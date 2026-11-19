/** Tests for the canonical trace conversion used by dataset exporters. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseTraceArtifact, type TraceMetadata, toTraceRecord } from "../src/trace.ts";

const metadata: TraceMetadata = {
	profile: "default",
	model: "fixture/model",
	systemPromptSha256: "hash",
	inputTokens: 3,
	outputTokens: 2,
	totalTokens: 5,
	toolCalls: 1,
};

function messages() {
	return [
		{ role: "system", content: "old prompt", timestamp: 0 },
		{ role: "user", content: "read the file", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "check the file" },
				{ type: "text", text: "reading" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } },
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-fixture",
			usage: {
				input: 3,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 3,
		},
	] as unknown as AgentSession["messages"];
}

describe("toTraceRecord", () => {
	it("keeps the forced prompt, collapses transcript system messages, and preserves tool calls", () => {
		const trace = toTraceRecord(messages(), { systemPrompt: "forced prompt", metadata });
		expect(trace.schemaVersion).toBe(1);
		expect(trace.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(trace.messages[0]).toEqual({ role: "system", content: "forced prompt" });
		expect(trace.messages[2]).toEqual({
			role: "assistant",
			content: "reading",
			reasoning: "check the file",
			toolCalls: [{ id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
		});
		expect(trace.messages[3]).toMatchObject({ role: "tool", toolCallId: "call-1", name: "read", content: "hello" });
		expect(trace.metadata).toEqual(metadata);
	});

	it("omits an empty system prompt", () => {
		const trace = toTraceRecord(messages(), { systemPrompt: "  ", metadata });
		expect(trace.messages[0].role).toBe("user");
	});
});

describe("parseTraceArtifact", () => {
	it("accepts harness trace strings and rejects malformed values", () => {
		const trace = toTraceRecord(messages(), { systemPrompt: "prompt", metadata });
		expect(parseTraceArtifact(JSON.stringify(trace))).toEqual(trace);
		expect(parseTraceArtifact("not json")).toBeUndefined();
		expect(parseTraceArtifact('{"schemaVersion":2,"messages":[]}')).toBeUndefined();
	});
});
