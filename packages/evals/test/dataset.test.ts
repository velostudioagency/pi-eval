/** Tests for dataset exporters and their model-family chat templates. */

import { describe, expect, it } from "vitest";
import { type ExportSpec, resolveChatTemplate, type SuiteSpec, validateSuite } from "../src/config.ts";
import { exportTraceRecord, exportTraceRecords, renderTrace } from "../src/dataset.ts";
import type { TraceRecord } from "../src/trace.ts";

const trace: TraceRecord = {
	schemaVersion: 1,
	messages: [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: "hi",
			reasoning: "greeting",
			toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }],
		},
		{ role: "tool", toolCallId: "c1", name: "read", content: "contents", isError: true },
	],
	metadata: {
		profile: "default",
		model: "fixture/model",
		systemPromptSha256: "hash",
		inputTokens: 1,
		outputTokens: 1,
		totalTokens: 2,
		toolCalls: 1,
		score: 1,
	},
};

const simple: TraceRecord = {
	...trace,
	messages: [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
	],
};

describe("messages exporter", () => {
	it("emits tool calls in OpenAI shape and keeps metadata out by default", () => {
		const record = exportTraceRecord(trace, { format: "messages" });
		expect(record).toMatchObject({
			messages: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: "hi",
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
				},
				{ role: "tool", tool_call_id: "c1", content: "contents" },
			],
		});
		expect(record).not.toHaveProperty("metadata");
		expect(record).not.toHaveProperty("messages.2.reasoning_content");
	});

	it("includes reasoning only when asked", () => {
		const record = exportTraceRecord(trace, { format: "messages", includeReasoning: true, includeMetadata: true });
		expect(record).toMatchObject({ metadata: { score: 1 } });
		expect((record?.messages as Array<Record<string, unknown>>)[2]).toMatchObject({
			role: "assistant",
			reasoning_content: "greeting",
		});
	});
});

describe("other exporters", () => {
	it("maps roles for ShareGPT", () => {
		const record = exportTraceRecord(trace, { format: "sharegpt" });
		expect(record?.conversations).toEqual([
			{ from: "system", value: "be brief" },
			{ from: "human", value: "hello" },
			{ from: "gpt", value: 'hi\n[tool_call read {"path":"a.txt"}]' },
			{ from: "observation", value: "contents" },
		]);
	});

	it("exports single-turn traces as Alpaca and skips tool traces", () => {
		expect(exportTraceRecord(simple, { format: "alpaca" })).toEqual({
			instruction: "hello",
			input: "be brief",
			output: "hi",
		});
		expect(exportTraceRecord(trace, { format: "alpaca" })).toBeUndefined();
	});

	it("renders model-family templates", () => {
		const chatml = renderTrace(simple, {
			id: "test-chatml",
			system: "<|im_start|>system\n{content}<|im_end|>\n",
			user: "<|im_start|>user\n{content}<|im_end|>\n",
			assistant: "<|im_start|>assistant\n{content}<|im_end|>\n",
		});
		expect(chatml).toBe(
			"<|im_start|>system\nbe brief<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\nhi<|im_end|>\n",
		);
		const deepseek = exportTraceRecord(simple, { format: "rendered", template: "deepseek" });
		expect(deepseek?.text).toContain("<｜User｜>hello<｜Assistant｜>");
		expect(deepseek?.text).toContain("<｜end▁of▁sentence｜>");
		expect(() => renderTrace(simple, { id: "bad", user: "no placeholder" })).toThrow("needs");
	});
});

describe("exportTraceRecords", () => {
	it("filters unscored traces by default and writes one JSON record per line", () => {
		const unscored: TraceRecord = { ...simple, metadata: { ...simple.metadata, score: undefined } };
		const spec: ExportSpec = { format: "messages" };
		const result = exportTraceRecords([simple, unscored], spec);
		expect(result.lines).toHaveLength(1);
		expect(result.skipped).toBe(1);
		expect(result.file).toBe("dataset.messages.jsonl");
		expect(JSON.parse(result.lines[0])).toHaveProperty("messages");
	});

	it("rejects unknown templates at suite validation", () => {
		const suite: SuiteSpec = {
			id: "bad",
			profiles: [{ id: "default" }],
			tasks: [{ id: "t", evalSet: "e", input: "hello" }],
			exports: [{ format: "rendered", template: "unknown" }],
		};
		expect(() => validateSuite(suite)).toThrow("Unknown chat template");
		expect(() => resolveChatTemplate("chatml")).not.toThrow();
	});
});
