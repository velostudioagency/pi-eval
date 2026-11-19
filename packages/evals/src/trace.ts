/**
 * Canonical eval trace records: the model-visible conversation of one run,
 * held in a dataset-shaped structure that exporters turn into training files.
 */

import type { Message } from "@earendil-works/pi-ai";
import { type AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";

/** Artifact name the harness uses to hand a trace to the reporter. */
export const PI_TRACE_ARTIFACT = "piEvalTrace";

export type TraceContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type TraceToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type TraceMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | TraceContentPart[] }
	| { role: "assistant"; content: string; reasoning?: string; toolCalls?: TraceToolCall[] }
	| { role: "tool"; toolCallId: string; name: string; content: string | TraceContentPart[]; isError?: true };

export type TraceMetadata = {
	profile: string;
	model: string;
	systemPromptSha256: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	toolCalls: number;
	/** Declared tool tier of the environment; not a guarantee of availability. */
	toolTier?: "standard" | "minimal";
	estimatedCostUsd?: number;
	suite?: string;
	family?: string;
	domain?: string;
	evalSet?: string;
	caseId?: string;
	runNumber?: number;
	score?: number;
	outcome?: string;
};

export type TraceRecord = {
	schemaVersion: 1;
	messages: TraceMessage[];
	metadata: TraceMetadata;
};

type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function toContent(value: string | readonly ContentPart[]): string | TraceContentPart[] {
	if (typeof value === "string") return value;
	const parts: TraceContentPart[] = value.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
	if (parts.every((part) => part.type === "text")) {
		return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	}
	return parts;
}

function toToolCallArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(arguments_)) as Record<string, unknown>;
}

/**
 * Convert a finished session into a trace record.
 *
 * `systemPrompt` is the prompt the provider actually received, which can differ
 * from the transcript when an eval forces a prompt. Mid-conversation system
 * messages are folded away, matching what providers without that capability see.
 */
export function toTraceRecord(
	messages: AgentSession["messages"],
	options: { systemPrompt: string; metadata: TraceMetadata },
): TraceRecord {
	const modelMessages: Message[] = convertToLlm(messages).filter((message) => message.role !== "system");
	const traceMessages: TraceMessage[] = [];
	if (options.systemPrompt.trim()) traceMessages.push({ role: "system", content: options.systemPrompt });
	for (const message of modelMessages) {
		if (message.role === "user") {
			traceMessages.push({ role: "user", content: toContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			const reasoning = message.content
				.flatMap((part) => (part.type === "thinking" ? [part.thinking ?? ""] : []))
				.join("");
			const toolCalls = message.content
				.filter((part) => part.type === "toolCall")
				.map((part) => ({ id: part.id, name: part.name, arguments: toToolCallArguments(part.arguments) }));
			traceMessages.push({
				role: "assistant",
				content: text,
				...(reasoning ? { reasoning } : {}),
				...(toolCalls.length > 0 ? { toolCalls } : {}),
			});
			continue;
		}
		if (message.role === "toolResult") {
			traceMessages.push({
				role: "tool",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: toContent(message.content),
				...(message.isError ? { isError: true as const } : {}),
			});
		}
	}
	return { schemaVersion: 1, messages: traceMessages, metadata: options.metadata };
}

/** Reads a trace artifact written by the harness. */
export function parseTraceArtifact(value: unknown): TraceRecord | undefined {
	if (typeof value !== "string") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Partial<TraceRecord>;
	if (record.schemaVersion !== 1 || !Array.isArray(record.messages)) return undefined;
	if (typeof record.metadata !== "object" || record.metadata === null) return undefined;
	return record as TraceRecord;
}
