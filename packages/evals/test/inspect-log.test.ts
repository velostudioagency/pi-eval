import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toInspectLog, writeInspectLog } from "../src/inspect-log.ts";
import type { EvalComparisonReport, EvalObservation } from "../src/report.ts";
import type { TraceRecord } from "../src/trace.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const suite = "extraction";
const model = "pi-eval-local/qwen3:4b-max";
const digest = "d81573e393b741e25e7975b2889abc0b7e6ab1a919a282ceec7a0c49ca08e4b7";
const userPrompt = "hey can you dig through the shared drive and find what we paid for the oven repair back in march?";
const finalText = "The oven repair was 1,240 GBP; the bank export entry TFK/2093 proves payment.";

// Mirrors one line of the real traces.jsonl: system, user, assistant with a
// tool call and reasoning, tool result, then the final assistant answer.
const trace: TraceRecord = {
	schemaVersion: 1,
	metadata: {
		profile: "default",
		model,
		systemPromptSha256: "abc123",
		inputTokens: 8190,
		outputTokens: 5295,
		totalTokens: 54875,
		toolCalls: 1,
		suite,
		family: "data-extraction",
		domain: "data-manipulation",
		evalSet: "oven-payment-real",
		caseId: "oven-payment-real",
		runNumber: 1,
		score: 0.5,
		outcome: "scored",
	},
	messages: [
		{ role: "system", content: "You are a coding assistant running inside pi." },
		{ role: "user", content: userPrompt },
		{
			role: "assistant",
			content: "",
			reasoning: "Check the shared drive records.",
			toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "ls G-drive" } }],
		},
		{ role: "tool", toolCallId: "call-1", name: "bash", content: "INV-2093.pdf", isError: true },
		{ role: "assistant", content: finalText },
	],
};

const scoredObservation: EvalObservation = {
	evalSet: "oven-payment-real",
	caseId: "oven-payment-real",
	family: "data-extraction",
	domain: "data-manipulation",
	profile: "default",
	model,
	runNumber: 1,
	inputTokens: 8190,
	outputTokens: 5295,
	cacheReadTokens: 41390,
	cacheWriteTokens: 0,
	totalTokens: 54875,
	toolCalls: 1,
	totalMs: 124172.33,
	outcome: "scored",
	score: 0.5,
};

const erroredObservation: EvalObservation = {
	evalSet: "make-it-greppable-real",
	caseId: "make-it-greppable-real",
	family: "data-extraction",
	domain: "data-manipulation",
	profile: "default",
	model,
	runNumber: 2,
	inputTokens: 4765,
	outputTokens: 5532,
	cacheReadTokens: 1788,
	cacheWriteTokens: 5,
	totalTokens: 12085,
	toolCalls: 2,
	totalMs: 103339.88,
	outcome: "errored",
};

const report: EvalComparisonReport = {
	schemaVersion: 4,
	protocolDigest: digest,
	suite,
	control: null,
	treatment: null,
	profiles: [],
	comparisons: [],
	families: [],
	domains: [],
	blockedPairs: [],
};

const input = {
	protocol: { suite, model, protocolDigest: digest },
	observations: [scoredObservation, erroredObservation],
	traces: [trace],
	report,
};

function objectOf(value: unknown): Record<string, unknown> {
	expect(value).toBeTypeOf("object");
	return value as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
	expect(Array.isArray(value)).toBe(true);
	return value as unknown[];
}

describe("toInspectLog", () => {
	it("emits a version 2 success log with the suite, model and protocol digest", () => {
		const log = objectOf(toInspectLog(input));
		expect(log.version).toBe(2);
		expect(log.status).toBe("success");
		const evalSpec = objectOf(log.eval);
		expect(evalSpec.task).toBe(suite);
		expect(evalSpec.model).toBe(model);
		expect(typeof evalSpec.created).toBe("string");
		expect(objectOf(evalSpec.metadata).protocolDigest).toBe(digest);
		expect(objectOf(evalSpec.dataset).samples).toBe(2);
	});

	it("reports sample counts, accuracy and a single solver step", () => {
		const log = objectOf(toInspectLog(input));
		const results = objectOf(log.results);
		expect(results.sample_count).toBe(2);
		expect(results.total_samples).toBe(2);
		const score = objectOf(arrayOf(results.scores)[0]);
		expect(objectOf(objectOf(score.metrics).accuracy).value).toBe(0.5);
		const plan = objectOf(log.plan);
		expect(arrayOf(plan.steps)).toHaveLength(1);
		expect(objectOf(arrayOf(plan.steps)[0]).solver).toBe("pi-eval");
		expect(plan.config).toEqual({});
	});

	it("maps trace messages, tool calls and tool results into Inspect shapes", () => {
		const log = objectOf(toInspectLog(input));
		const sample = objectOf(arrayOf(log.samples)[0]);
		expect(sample.epoch).toBe(1);
		expect(sample.id).toBe(JSON.stringify(["oven-payment-real", "oven-payment-real", "default", model, 1]));
		expect(sample.input).toBe(userPrompt);
		expect(sample.target).toBe("");
		expect(objectOf(sample.output).completion).toBe(finalText);

		const messages = arrayOf(sample.messages).map((value) => objectOf(value));
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
		expect(messages[0].content).toBe("You are a coding assistant running inside pi.");
		expect(messages[2].reasoning).toBe("Check the shared drive records.");
		const calls = arrayOf(messages[2].tool_calls).map((value) => objectOf(value));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			id: "call-1",
			function: "bash",
			arguments: { command: "ls G-drive" },
			type: "function",
		});
		expect(messages[3].tool_call_id).toBe("call-1");
		expect(messages[3].function).toBe("bash");
		expect(objectOf(messages[3].error)).toEqual({ type: "unknown", message: "INV-2093.pdf" });
		expect(messages[4].content).toBe(finalText);
	});

	it("scores only scored samples and carries identity metadata", () => {
		const log = objectOf(toInspectLog(input));
		const samples = arrayOf(log.samples).map((value) => objectOf(value));
		const scores = objectOf(samples[0].scores);
		expect(objectOf(scores.accuracy)).toEqual({ value: 0.5, answer: finalText, explanation: "" });
		expect(samples[1].scores).toBeUndefined();
		expect(objectOf(samples[1].metadata)).toMatchObject({
			profile: "default",
			model,
			domain: "data-manipulation",
			runNumber: 2,
			outcome: "errored",
		});
	});

	it("sums token counts from observations into stats", () => {
		const log = objectOf(toInspectLog(input));
		const usage = objectOf(objectOf(objectOf(log.stats).model_usage)[model]);
		expect(usage).toEqual({
			input_tokens: 8190 + 4765,
			output_tokens: 5295 + 5532,
			total_tokens: 54875 + 12085,
			input_tokens_cache_read: 41390 + 1788,
			input_tokens_cache_write: 0 + 5,
		});
	});

	it("tolerates a malformed trace without throwing or emitting NaN", () => {
		const malformed = {
			...input,
			traces: [
				{ schemaVersion: 1, metadata: { ...trace.metadata, runNumber: 2 }, messages: [null, 42] },
			] as unknown as TraceRecord[],
		};
		const log = objectOf(toInspectLog(malformed));
		const sample = objectOf(arrayOf(log.samples)[1]);
		expect(arrayOf(sample.messages)).toEqual([]);
		expect(JSON.stringify(log)).not.toContain("null,null");
		expect(JSON.stringify(log)).not.toMatch(/NaN|Infinity/);
	});
});

describe("writeInspectLog", () => {
	it("writes a log that can be parsed back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-eval-inspect-log-"));
		directories.push(directory);
		const path = join(directory, "logs", "run.eval");
		await writeInspectLog(path, input);
		const written = objectOf(JSON.parse(await readFile(path, "utf8")));
		expect(written.version).toBe(2);
		expect(arrayOf(written.samples)).toHaveLength(2);
	});
});
