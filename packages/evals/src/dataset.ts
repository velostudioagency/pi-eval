/**
 * Dataset exporters: turn canonical trace records into fine-tuning JSONL.
 *
 * Formats differ per model family. `messages` keeps the provider-neutral chat
 * structure that most trainers apply their own template to; `rendered` applies
 * a declared chat template, so Qwen, Hermes, DeepSeek, and Llama files come out
 * in the exact text shape those models were trained on.
 */

import { type ChatTemplateSpec, type ExportSpec, resolveChatTemplate } from "./config.ts";
import type { TraceContentPart, TraceRecord, TraceToolCall } from "./trace.ts";

export type DatasetExport = { format: ExportSpec["format"]; file: string; lines: string[]; skipped: number };

type JsonRecord = Record<string, unknown>;

function toolCallArguments(call: TraceToolCall): string {
	return JSON.stringify(call.arguments ?? {});
}

function contentText(parts: string | TraceContentPart[]): string {
	if (typeof parts === "string") return parts;
	return parts.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`)).join("");
}

function messagesContent(parts: string | TraceContentPart[]): string | JsonRecord[] {
	if (typeof parts === "string") return parts;
	return parts.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
	);
}

function toMessagesRecord(trace: TraceRecord, spec: ExportSpec): JsonRecord {
	const messages = trace.messages.map((message) => {
		if (message.role === "assistant") {
			const toolCalls = message.toolCalls?.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: toolCallArguments(call) },
			}));
			return {
				role: "assistant",
				content: message.content || (toolCalls ? null : ""),
				...(spec.includeReasoning && message.reasoning ? { reasoning_content: message.reasoning } : {}),
				...(toolCalls ? { tool_calls: toolCalls } : {}),
			};
		}
		if (message.role === "tool") {
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				content: contentText(message.content),
			};
		}
		return { role: message.role, content: messagesContent(message.content) };
	});
	return { messages, ...(spec.includeMetadata ? { metadata: trace.metadata } : {}) };
}

function toShareGptRecord(trace: TraceRecord, spec: ExportSpec): JsonRecord {
	const conversations = trace.messages.map((message) => {
		if (message.role === "tool") return { from: "observation", value: contentText(message.content) };
		if (message.role === "assistant") {
			const calls = message.toolCalls?.map((call) => `[tool_call ${call.name} ${toolCallArguments(call)}]`) ?? [];
			const value = [message.content, ...calls].filter(Boolean).join("\n");
			return { from: "gpt", value };
		}
		return { from: message.role === "system" ? "system" : "human", value: contentText(message.content) };
	});
	return { conversations, ...(spec.includeMetadata ? { metadata: trace.metadata } : {}) };
}

function isAlpacaShaped(trace: TraceRecord): boolean {
	const roles = trace.messages.map(({ role }) => role);
	if (roles.filter((role) => role === "user").length !== 1) return false;
	if (roles.filter((role) => role === "assistant").length !== 1) return false;
	if (roles.some((role) => role === "tool")) return false;
	const assistant = trace.messages.find((message) => message.role === "assistant");
	if (assistant?.role === "assistant" && assistant.toolCalls) return false;
	return roles.every((role) => role === "system" || role === "user" || role === "assistant");
}

function toAlpacaRecord(trace: TraceRecord): JsonRecord | undefined {
	if (!isAlpacaShaped(trace)) return undefined;
	const system = trace.messages.find((message) => message.role === "system");
	const user = trace.messages.find((message) => message.role === "user");
	const assistant = trace.messages.find((message) => message.role === "assistant");
	if (!user || !assistant) return undefined;
	return {
		instruction: contentText(user.content),
		input: system ? contentText(system.content) : "",
		output: assistant.role === "assistant" ? assistant.content : "",
	};
}

function templateTurn(template: string | undefined, role: string, content: string, turnEnd: string): string {
	if (template === undefined) return content;
	if (!template.includes("{content}")) throw new TypeError(`Chat template wrapper for ${role} needs "{content}".`);
	return template.replaceAll("{content}", content) + turnEnd;
}

/** Renders a trace with a model-family chat template. */
export function renderTrace(trace: TraceRecord, template: ChatTemplateSpec): string {
	const turnEnd = template.turnEnd ?? "";
	const separator = template.toolCallSeparator ?? "\n";
	let text = template.bos ?? "";
	for (const message of trace.messages) {
		if (message.role === "tool") {
			text += templateTurn(template.tool, "tool", contentText(message.content), turnEnd);
			continue;
		}
		if (message.role === "assistant") {
			const calls =
				message.toolCalls?.map((call) =>
					template.toolCall !== undefined
						? template.toolCall.replaceAll("{name}", call.name).replaceAll("{arguments}", toolCallArguments(call))
						: `[tool_call ${call.name} ${toolCallArguments(call)}]`,
				) ?? [];
			const content = [message.content, ...calls].filter(Boolean).join(separator);
			text += templateTurn(template.assistant, "assistant", content, turnEnd);
			continue;
		}
		const wrapper = message.role === "system" ? template.system : template.user;
		text += templateTurn(wrapper, message.role, contentText(message.content), turnEnd);
	}
	return text + (template.eos ?? "");
}

function toRenderedRecord(trace: TraceRecord, spec: ExportSpec): JsonRecord {
	return {
		text: renderTrace(trace, resolveChatTemplate(spec.template)),
		...(spec.includeMetadata ? { metadata: trace.metadata } : {}),
	};
}

/**
 * Export one trace in the configured format.
 *
 * Returns undefined when the format cannot represent this trace (for example
 * Alpaca with tool calls). The caller counts those as skipped instead of
 * writing a lossy record.
 */
export function exportTraceRecord(trace: TraceRecord, spec: ExportSpec): JsonRecord | undefined {
	if (spec.format === "messages") return toMessagesRecord(trace, spec);
	if (spec.format === "sharegpt") return toShareGptRecord(trace, spec);
	if (spec.format === "rendered") return toRenderedRecord(trace, spec);
	return toAlpacaRecord(trace);
}

export function exportTraceRecords(traces: readonly TraceRecord[], spec: ExportSpec): DatasetExport {
	const onlyScored = spec.onlyScored ?? true;
	const lines: string[] = [];
	let skipped = 0;
	for (const trace of traces) {
		if (onlyScored && trace.metadata.score === undefined) {
			skipped += 1;
			continue;
		}
		const record = exportTraceRecord(trace, spec);
		if (!record) {
			skipped += 1;
			continue;
		}
		lines.push(JSON.stringify(record));
	}
	return {
		format: spec.format,
		file: spec.file ?? `dataset.${spec.format}.jsonl`,
		lines,
		skipped,
	};
}
