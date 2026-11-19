/** Tests for the ATIF trajectory exporter. */

import { describe, expect, it } from "vitest";
import type { ExportSpec } from "../src/config.ts";
import type { TraceRecord } from "../src/trace.ts";
import { toAtifRecord } from "../src/trace-formats/atif.ts";

const spec: ExportSpec = { format: "atif" };

const trace: TraceRecord = {
	schemaVersion: 1,
	messages: [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "read the file" },
		{
			role: "assistant",
			content: "reading",
			toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }],
		},
		{ role: "tool", toolCallId: "c1", name: "read", content: "Error: file missing", isError: true },
	],
	metadata: {
		profile: "default",
		model: "fixture/model",
		systemPromptSha256: "hash",
		inputTokens: 3,
		outputTokens: 2,
		totalTokens: 5,
		toolCalls: 1,
		score: 1,
	},
};

const record = toAtifRecord(trace, spec);

describe("toAtifRecord", () => {
	it("maps roles to ATIF sources and keeps step ids sequential from 1", () => {
		expect(record?.schema_version).toBe("ATIF-v1.8");
		expect(record?.steps.map((step) => step.source)).toEqual(["system", "user", "agent"]);
		expect(record?.steps.map((step) => step.step_id)).toEqual([1, 2, 3]);
		expect(record?.steps[0]).toMatchObject({ message: "be brief" });
		expect(record?.steps[1]).toMatchObject({ message: "read the file" });
	});

	it("maps the assistant message and its tool result onto the agent step", () => {
		const agentStep = record?.steps[2];
		expect(agentStep?.message).toBe("reading");
		expect(agentStep?.tool_calls).toEqual([
			{ tool_call_id: "c1", function_name: "read", arguments: { path: "a.txt" } },
		]);
		expect(agentStep?.observation).toEqual({ results: [{ source_call_id: "c1", content: "Error: file missing" }] });
	});

	it("propagates tool errors through the observation result", () => {
		expect(record?.steps[2]?.observation?.results[0]?.content).toContain("file missing");
	});

	it("carries trace metadata on the agent and in the trajectory extra", () => {
		expect(record?.agent.name).toBe("pi-eval");
		expect(record?.agent.model_name).toBe("fixture/model");
		expect(record?.extra).toMatchObject({
			profile: "default",
			model: "fixture/model",
			inputTokens: 3,
			totalTokens: 5,
		});
		expect(record?.final_metrics).toMatchObject({
			total_steps: 3,
			total_prompt_tokens: 3,
			total_completion_tokens: 2,
		});
	});

	it("skips malformed traces", () => {
		const missingMessages = { schemaVersion: 1, metadata: trace.metadata } as TraceRecord;
		expect(toAtifRecord(missingMessages, spec)).toBeUndefined();
		const noSteps = { schemaVersion: 1 as const, messages: [], metadata: trace.metadata } as TraceRecord;
		expect(toAtifRecord(noSteps, spec)).toBeUndefined();
		const wrongVersion = {
			schemaVersion: 2,
			messages: [{ role: "user", content: "hi" }],
			metadata: trace.metadata,
		} as unknown as TraceRecord;
		expect(toAtifRecord(wrongVersion, spec)).toBeUndefined();
	});

	it("replaces non-finite numbers with null instead of emitting NaN or Infinity", () => {
		const nanTrace: TraceRecord = {
			...trace,
			messages: [
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "c2", name: "run", arguments: { count: Number.NaN, factor: Infinity } }],
				},
			],
		};
		const nanRecord = toAtifRecord(nanTrace, spec);
		expect(nanRecord?.steps[0].tool_calls?.[0].arguments).toEqual({ count: null, factor: null });
	});
});
