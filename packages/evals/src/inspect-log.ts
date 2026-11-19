/**
 * Emits Inspect AI JSON evaluation logs (format version 2) from pi-eval artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalComparisonReport, EvalObservation } from "./report.ts";
import type { TraceMessage, TraceRecord } from "./trace.ts";

type InspectLogInput = {
	protocol: Record<string, unknown>;
	observations: readonly EvalObservation[];
	traces: readonly TraceRecord[];
	report: EvalComparisonReport;
};

type JsonRecord = Record<string, unknown>;

/** Build the Inspect log object without touching the filesystem. */
export function toInspectLog(input: InspectLogInput): Record<string, unknown> {
	const { protocol, observations, traces, report } = input;
	const created = new Date().toISOString().replace("Z", "+00:00");
	const suite = suiteName(protocol, report);
	const model = modelName(protocol, observations);
	const digest = protocolDigest(protocol, report);
	const traceByKey = new Map<string, TraceRecord>();
	for (const trace of traces) {
		if (!isRecord(trace)) continue;
		const metadata: JsonRecord = isRecord(trace.metadata) ? trace.metadata : {};
		const key = JSON.stringify([
			metadata.evalSet ?? "",
			metadata.caseId ?? "",
			metadata.profile ?? "",
			metadata.model ?? "",
			finiteOrZero(metadata.runNumber),
		]);
		if (!traceByKey.has(key)) traceByKey.set(key, trace as TraceRecord);
	}
	const scoreValues = observations.flatMap((observation) => {
		const score = scoredValue(observation);
		return score === undefined ? [] : [score];
	});
	const accuracy =
		scoreValues.length === 0 ? 0 : scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length;
	const tokens = {
		input_tokens: sumMetric(observations, "inputTokens"),
		output_tokens: sumMetric(observations, "outputTokens"),
		total_tokens: sumMetric(observations, "totalTokens"),
		input_tokens_cache_read: sumMetric(observations, "cacheReadTokens"),
		input_tokens_cache_write: sumMetric(observations, "cacheWriteTokens"),
	};
	const samples = observations.map((observation) => {
		const trace = traceByKey.get(identityKey(observation));
		const messages = Array.isArray(trace?.messages) ? trace.messages : [];
		const prompt = promptOf(protocol, observation);
		const text = firstUserText(messages) || prompt;
		const completion = finalAssistantText(messages);
		const sample: JsonRecord = {
			id: identityKey(observation),
			epoch: 1,
			input: text,
			target: "",
			messages: toInspectMessages(messages),
			output: {
				model: observation.model ?? model,
				choices: [{ message: { role: "assistant", content: completion }, stop_reason: "stop" }],
				completion,
				usage: usageOf(observation),
			},
			metadata: {
				evalSet: observation.evalSet ?? "",
				caseId: observation.caseId ?? "",
				profile: observation.profile ?? "",
				model: observation.model ?? "",
				...(observation.family ? { family: observation.family } : {}),
				...(observation.domain ? { domain: observation.domain } : {}),
				runNumber: finiteOrZero(observation.runNumber),
				outcome: observation.outcome,
			},
		};
		const score = scoredValue(observation);
		if (score !== undefined) {
			sample.scores = { accuracy: { value: score, answer: completion, explanation: "" } };
		}
		return sample;
	});
	return {
		version: 2,
		status: "success",
		eval: {
			eval_id: "",
			run_id: "",
			created,
			task: suite,
			task_id: "",
			task_version: 0,
			dataset: { name: suite, samples: observations.length },
			model,
			config: {},
			metadata: { protocolDigest: digest, suite, piEval: true },
		},
		plan: {
			name: "plan",
			steps: [{ solver: "pi-eval", params: {}, params_passed: {} }],
			config: {},
		},
		results: {
			total_samples: observations.length,
			completed_samples: observations.length,
			sample_count: observations.length,
			scores: [
				{
					name: "accuracy",
					scorer: "pi-eval",
					metrics: { accuracy: { name: "accuracy", value: accuracy, params: {} } },
				},
			],
		},
		stats: {
			started_at: created,
			completed_at: created,
			model_usage: { [model]: tokens },
			role_usage: {},
		},
		invalidated: false,
		tags: [],
		metadata: {},
		total_samples: observations.length,
		samples,
	};
}

/** Serialize the Inspect log to `path`, creating its parent directory. */
export async function writeInspectLog(path: string, input: InspectLogInput): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(toInspectLog(input), null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrEmpty(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function scoredValue(observation: EvalObservation): number | undefined {
	if (observation.outcome !== "scored") return undefined;
	return Number.isFinite(observation.score) ? observation.score : undefined;
}

function sumMetric(observations: readonly EvalObservation[], key: keyof EvalObservation): number {
	let total = 0;
	for (const observation of observations) total += finiteOrZero(observation[key]);
	return total;
}

function usageOf(observation: EvalObservation): JsonRecord {
	return {
		input_tokens: finiteOrZero(observation.inputTokens),
		output_tokens: finiteOrZero(observation.outputTokens),
		total_tokens: finiteOrZero(observation.totalTokens),
		input_tokens_cache_read: finiteOrZero(observation.cacheReadTokens),
		input_tokens_cache_write: finiteOrZero(observation.cacheWriteTokens),
	};
}

function identityKey(observation: EvalObservation): string {
	return JSON.stringify([
		observation.evalSet ?? "",
		observation.caseId ?? "",
		observation.profile ?? "",
		observation.model ?? "",
		finiteOrZero(observation.runNumber),
	]);
}

function suiteName(protocol: Record<string, unknown>, report: EvalComparisonReport): string {
	const suite = protocol.suite;
	if (typeof suite === "string" && suite) return suite;
	if (isRecord(suite) && typeof suite.id === "string" && suite.id) return suite.id;
	return report.suite ?? "";
}

function modelName(protocol: Record<string, unknown>, observations: readonly EvalObservation[]): string {
	if (typeof protocol.model === "string" && protocol.model) return protocol.model;
	return observations.find((observation) => observation.model)?.model ?? "";
}

function protocolDigest(protocol: Record<string, unknown>, report: EvalComparisonReport): string {
	return report.protocolDigest || stringOrEmpty(protocol.protocolDigest);
}

function promptOf(protocol: Record<string, unknown>, observation: EvalObservation): string {
	if (!Array.isArray(protocol.tasks)) return "";
	const task = protocol.tasks.find(
		(value) =>
			isRecord(value) &&
			value.evalSet === observation.evalSet &&
			value.caseId === observation.caseId &&
			finiteOrZero(value.runNumber) === finiteOrZero(observation.runNumber) &&
			value.profile === observation.profile &&
			value.model === observation.model,
	);
	return isRecord(task) ? stringOrEmpty(task.input) : "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function contentOf(content: unknown): string | JsonRecord[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: JsonRecord[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string") {
			const mime = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "application/octet-stream";
			parts.push({ type: "image", image: `data:${mime};base64,${part.data}` });
		}
	}
	return parts;
}

function toolCallsOf(value: unknown): JsonRecord[] {
	if (!Array.isArray(value)) return [];
	const calls: JsonRecord[] = [];
	for (const call of value) {
		if (!isRecord(call)) continue;
		calls.push({
			id: stringOrEmpty(call.id),
			function: stringOrEmpty(call.name),
			arguments: isRecord(call.arguments) ? call.arguments : {},
			type: "function",
		});
	}
	return calls;
}

// Traces come from JSON artifacts, so their message shapes are validated here
// even though the static TraceMessage union describes the well-formed case.
function toInspectMessages(messages: readonly TraceMessage[]): JsonRecord[] {
	if (!Array.isArray(messages)) return [];
	const result: JsonRecord[] = [];
	for (const message of messages) {
		if (!isRecord(message)) continue;
		switch (stringOrEmpty(message.role)) {
			case "system":
				result.push({ role: "system", content: contentOf(message.content) });
				break;
			case "user":
				result.push({ role: "user", content: contentOf(message.content) });
				break;
			case "assistant": {
				const assistant: JsonRecord = { role: "assistant", content: textOf(message.content) };
				const calls = toolCallsOf(message.toolCalls);
				if (calls.length > 0) assistant.tool_calls = calls;
				if (typeof message.reasoning === "string" && message.reasoning) assistant.reasoning = message.reasoning;
				result.push(assistant);
				break;
			}
			case "tool": {
				const tool: JsonRecord = {
					role: "tool",
					content: contentOf(message.content),
					tool_call_id: stringOrEmpty(message.toolCallId),
					function: stringOrEmpty(message.name),
				};
				if (message.isError === true) tool.error = { type: "unknown", message: textOf(message.content) };
				result.push(tool);
				break;
			}
			default:
				break;
		}
	}
	return result;
}

function firstUserText(messages: readonly TraceMessage[]): string {
	if (!Array.isArray(messages)) return "";
	for (const message of messages) {
		if (isRecord(message) && message.role === "user") return textOf(message.content);
	}
	return "";
}

function finalAssistantText(messages: readonly TraceMessage[]): string {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message: unknown = messages[index];
		if (isRecord(message) && message.role === "assistant") {
			const text = textOf(message.content);
			if (text) return text;
		}
	}
	return "";
}
