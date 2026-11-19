/**
 * Exports canonical pi-eval traces as Harbor ATIF (Agent Trajectory Interchange
 * Format) trajectories, the standard machine-readable trajectory shape.
 *
 * Tool results attach to the agent step that issued the matching call; when no
 * call is recorded they start their own agent step. Traces without a message
 * array or with no messages are skipped, and numeric fields never carry NaN or
 * Infinity.
 */

import pkg from "../../package.json" with { type: "json" };
import type { ExportSpec } from "../config.ts";
import type { TraceContentPart, TraceMessage, TraceRecord } from "../trace.ts";

type JsonRecord = Record<string, unknown>;

/** The originator of a step, mapped from pi-eval trace roles. */
export type AtifStepSource = "system" | "user" | "agent";

/** A structured tool call inside an agent step. */
export type AtifToolCall = {
	/** The tool call id that the matching observation result answers. */
	tool_call_id: string;
	/** The tool being invoked. */
	function_name: string;
	/** Arguments passed to the tool, with non-finite numbers replaced by null. */
	arguments: JsonRecord;
};

type AtifTextPart = { type: "text"; text: string };
type AtifImagePart = { type: "image"; source: { media_type: string; path: string } };
type AtifContentPart = AtifTextPart | AtifImagePart;

/** Environment feedback attached to an agent step. */
export type AtifObservationResult = {
	source_call_id?: string;
	content: string | AtifContentPart[];
};

export type AtifObservation = {
	results: AtifObservationResult[];
};

export type AtifStep = {
	step_id: number;
	source: AtifStepSource;
	message: string | AtifContentPart[];
	reasoning_content?: string;
	tool_calls?: AtifToolCall[];
	observation?: AtifObservation;
};

export type AtifAgent = {
	name: string;
	version: string;
	model_name?: string;
};

export type AtifTrajectory = {
	schema_version: string;
	agent: AtifAgent;
	steps: AtifStep[];
	final_metrics?: {
		total_steps: number;
		total_prompt_tokens?: number;
		total_completion_tokens?: number;
	};
	extra?: JsonRecord;
};

function contentOf(content: string | readonly TraceContentPart[]): string | AtifContentPart[] {
	if (typeof content === "string") return content;
	return content.map(
		(part): AtifContentPart =>
			part.type === "text"
				? { type: "text", text: part.text }
				: {
						type: "image",
						source: { media_type: part.mimeType, path: `data:${part.mimeType};base64,${part.data}` },
					},
	);
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (value !== null && typeof value === "object") {
		const out: JsonRecord = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = sanitizeValue(entry);
			if (sanitized !== undefined) out[key] = sanitized;
		}
		return out;
	}
	return value;
}

function finiteOrZero(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function toAtifSteps(messages: readonly TraceMessage[]): AtifStep[] {
	const steps: AtifStep[] = [];
	const agentStepByToolCallId = new Map<string, AtifStep>();
	let lastAgentStep: AtifStep | undefined;
	const push = (step: Omit<AtifStep, "step_id">): AtifStep => {
		const pushed: AtifStep = { ...step, step_id: steps.length + 1 };
		steps.push(pushed);
		return pushed;
	};

	for (const message of messages) {
		if (message.role === "system") {
			lastAgentStep = undefined;
			push({ source: "system", message: message.content });
			continue;
		}
		if (message.role === "user") {
			lastAgentStep = undefined;
			push({ source: "user", message: contentOf(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const toolCalls: AtifToolCall[] = [];
			for (const call of message.toolCalls ?? []) {
				toolCalls.push({
					tool_call_id: call.id,
					function_name: call.name,
					arguments: sanitizeValue(call.arguments) as JsonRecord,
				});
			}
			const step = push({
				source: "agent",
				message: message.content,
				...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			lastAgentStep = step;
			for (const call of toolCalls) agentStepByToolCallId.set(call.tool_call_id, step);
			continue;
		}
		const owner = agentStepByToolCallId.get(message.toolCallId) ?? lastAgentStep;
		const result: AtifObservationResult = { content: contentOf(message.content) };
		if (owner?.tool_calls?.some((call) => call.tool_call_id === message.toolCallId)) {
			result.source_call_id = message.toolCallId;
		}
		if (owner) {
			owner.observation ??= { results: [] };
			owner.observation.results.push(result);
		} else {
			lastAgentStep = push({ source: "agent", message: "", observation: { results: [result] } });
		}
	}
	return steps;
}

/**
 * Convert one trace to an ATIF trajectory. Returns undefined when the trace is
 * malformed (no message array or no mappable steps) so callers can skip it.
 */
export function toAtifRecord(trace: TraceRecord, spec: ExportSpec): AtifTrajectory | undefined {
	if (trace.schemaVersion !== 1 || !Array.isArray(trace.messages) || trace.messages.length === 0) return undefined;
	const steps = toAtifSteps(trace.messages);
	const metadata = trace.metadata;
	return {
		schema_version: "ATIF-v1.8",
		agent: {
			name: "pi-eval",
			version: pkg.version,
			model_name: metadata.model,
		},
		steps,
		final_metrics: {
			total_steps: steps.length,
			total_prompt_tokens: finiteOrZero(metadata.inputTokens),
			total_completion_tokens: finiteOrZero(metadata.outputTokens),
		},
		...(spec.includeMetadata !== false ? { extra: sanitizeValue(metadata) as JsonRecord } : {}),
	};
}
