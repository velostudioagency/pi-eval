/** Tests for agent run metrics, the trajectory recorder, and request fidelity. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRequests, loadRealRequest } from "../src/agent/fidelity.ts";
import { type AgentRunResult, failureBucket, summarizeAgentRuns, wilsonInterval } from "../src/agent/metrics.ts";
import { AgentRecorder, scrubHostValues, sha256Text } from "../src/agent/recorder.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agent-metrics-test-"));
	directories.push(path);
	return path;
}

function runResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		profileId: "native",
		taskId: "task",
		ok: false,
		actions: [],
		verification: { checks: [] },
		usage: {},
		...overrides,
	};
}

describe("failureBucket", () => {
	it("returns success for a passing run", () => {
		expect(failureBucket(runResult({ ok: true }))).toBe("success");
	});

	it("assigns one exclusive bucket in priority order", () => {
		const removed = { name: "read", meta: { validation_error: "fault_removed" } };
		const unknown = { name: "ghost", meta: { validation_error: "unknown_tool" } };
		const invalid = { name: "read", meta: { validation_error: "arguments" } };
		const rule = { type: "read_before_edit", ok: false };
		const checks = { checks: [rule] };

		expect(
			failureBucket(
				runResult({ stopReason: "infra_error", actions: [removed, unknown, invalid], verification: checks }),
			),
		).toBe("infra_error");
		expect(
			failureBucket(runResult({ error: { kind: "infra_error" }, actions: [unknown], verification: checks })),
		).toBe("infra_error");
		expect(failureBucket(runResult({ actions: [unknown, invalid, removed], verification: checks }))).toBe(
			"fault_removed_tool",
		);
		expect(failureBucket(runResult({ actions: [invalid, unknown], verification: checks }))).toBe("hallucinated_tool");
		expect(failureBucket(runResult({ actions: [{ name: "read", text: "unknown tool used" }] }))).toBe(
			"hallucinated_tool",
		);
		expect(failureBucket(runResult({ actions: [invalid], verification: checks }))).toBe("invalid_arguments");
		expect(failureBucket(runResult({ actions: [{ text: "validation failed" }] }))).toBe("invalid_arguments");
		expect(failureBucket(runResult({ verification: checks }))).toBe("rule_violation");
		expect(failureBucket(runResult({ verification: { checks: [{ type: "file_exists", ok: false }] } }))).toBe(
			"verification_failure",
		);
	});
});

describe("summarizeAgentRuns", () => {
	it("computes rates, buckets, diagnostics, and token totals", () => {
		const results = [
			runResult({
				ok: true,
				actions: [{ name: "read" }],
				verification: {
					checks: [
						{ type: "file_exists", ok: true },
						{ type: "read_before_edit", ok: true },
					],
				},
				usage: { promptTokens: 10, completionTokens: 5 },
			}),
			runResult({
				actions: [{ name: "ghost", meta: { validation_error: "unknown_tool" } }],
				verification: { checks: [{ type: "file_exists", ok: false }] },
				usage: { promptTokens: 4, completionTokens: 2 },
			}),
		];
		const summary = summarizeAgentRuns(results);
		expect(summary.totalRuns).toBe(2);
		expect(summary.successRate).toBe(0.5);
		expect(summary.partialCredit).toBeCloseTo(2 / 3);
		expect(summary.buckets).toMatchObject({ success: 1, hallucinated_tool: 1, infra_error: 0 });
		expect(Object.values(summary.buckets).reduce((total, count) => total + count, 0)).toBe(2);
		expect(summary.diagnosticRates.hallucinatedToolRate).toBe(0.5);
		expect(summary.diagnosticRates.hallucinated_tool_rate).toBe(0.5);
		expect(summary.diagnosticRates.invalidArgumentsRate).toBe(0);
		expect(summary.tokenTotals).toMatchObject({ promptTokens: 14, completionTokens: 7, totalTokens: 21 });
	});

	it("computes the Wilson interval for known counts and stays finite when empty", () => {
		const [low, high] = wilsonInterval(8, 10);
		expect(low).toBeCloseTo(0.4902, 3);
		expect(high).toBeCloseTo(0.9433, 3);
		expect(wilsonInterval(0, 0)).toEqual([0, 0]);
		const summary = summarizeAgentRuns([]);
		expect(summary.successRate).toBe(0);
		expect(summary.wilson95).toEqual([0, 0]);
		expect(summary.totalRuns).toBe(0);
	});
});

describe("AgentRecorder", () => {
	it("writes byte-identical JSONL for identical inputs", async () => {
		const firstDir = await tempDir();
		const secondDir = await tempDir();
		const fields = {
			turn: 1,
			system_prompt_hash: sha256Text("prompt"),
			request_messages: [{ role: "user", content: "héllo" }],
		};
		const first = new AgentRecorder({ outputDir: firstDir, taskId: "task", profileId: "profile", seed: 7 });
		const second = new AgentRecorder({ outputDir: secondDir, taskId: "task", profileId: "profile", seed: 7 });
		first.recordEvent("start", fields);
		second.recordEvent("start", fields);
		first.recordEvent("end", { ok: true });
		second.recordEvent("end", { ok: true });
		first.close();
		second.close();

		const [firstBytes, secondBytes] = await Promise.all([
			readFile(first.path, "utf8"),
			readFile(second.path, "utf8"),
		]);
		expect(firstBytes).toBe(secondBytes);
		expect(first.path).toContain("task__profile__7.jsonl");
		expect(second.path).toContain("task__profile__7.jsonl");
	});

	it("sorts keys and uses compact separators with an incrementing seq", async () => {
		const directory = await tempDir();
		const recorder = new AgentRecorder({ outputDir: directory });
		recorder.recordEvent("z_event", { b: 2, a: 1 });
		recorder.recordEvent("next");
		recorder.close();
		const lines = (await readFile(recorder.path, "utf8")).trim().split("\n");
		expect(lines[0]).toBe('{"a":1,"b":2,"event":"z_event","seq":1}');
		expect(lines[1]).toBe('{"event":"next","seq":2}');
	});

	it("scrubs home, temp, and username values", () => {
		const home = homedir();
		expect(scrubHostValues(`${home}/project`)).toBe("/home/dev/project");
		expect(scrubHostValues(tmpdir())).toBe("/tmp");
		expect(scrubHostValues("plain text")).toBe("plain text");
		expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("captures turn fields and scrubs host values in turns and summaries", async () => {
		const directory = await tempDir();
		const recorder = new AgentRecorder({ outputDir: directory, runId: "run" });
		const payload = recorder.recordTurn({
			turn: 2,
			systemPromptHash: "hash",
			requestMessages: [{ role: "user", content: `read ${homedir()}/secret` }],
			rawModelText: "done",
			reasoning: "think",
			parsedCalls: [{ name: "read" }],
			canonicalActions: [{ name: "read" }],
			toolResults: [{ ok: true }],
			injections: [{ id: "i" }],
			faults: [{ id: "f" }],
			usage: { promptTokens: 3 },
			formatError: "bad json",
			malformedCount: 3,
		});
		const summaryPath = recorder.writeSummary({ path: homedir(), ok: true });
		recorder.close();

		const turnText = await readFile(recorder.path, "utf8");
		expect(payload.event).toBe("turn");
		expect(turnText).not.toContain(homedir());
		expect(turnText).toContain("/home/dev/secret");
		const parsed = JSON.parse(turnText.trim());
		expect(parsed).toMatchObject({
			seq: 1,
			event: "turn",
			turn: 2,
			system_prompt_hash: "hash",
			raw_model_text: "done",
			reasoning: "think",
			parsed_calls: [{ name: "read" }],
			canonical_actions: [{ name: "read" }],
			tool_results: [{ ok: true }],
			injections: [{ id: "i" }],
			faults: [{ id: "f" }],
			usage: { promptTokens: 3 },
			format_error: "bad json",
			malformed_count: 3,
		});
		const summaryText = await readFile(summaryPath, "utf8");
		expect(summaryText).not.toContain(homedir());
		expect(summaryText).toContain('"ok": true');
	});
});

describe("loadRealRequest", () => {
	it("loads JSON text and nested request/payload shapes", () => {
		const nested = { messages: [{ role: "user", content: "hi" }] };
		expect(loadRealRequest({ request: nested })).toEqual(nested);
		expect(loadRealRequest({ payload: nested })).toEqual(nested);
		expect(loadRealRequest(JSON.stringify(nested))).toEqual(nested);
		expect(() => loadRealRequest("not json")).toThrow();
		expect(() => loadRealRequest([])).toThrow();
	});
});

describe("compareRequests", () => {
	const read = { function: { name: "read", parameters: { properties: { path: {} } } } };
	const writeTool = { function: { name: "write", parameters: { properties: { path: {}, content: {} } } } };

	it("returns PASS when the rendered request matches the capture", () => {
		const system = "<environment>e</environment>\n# Available tools\n<tools>t</tools>";
		const messages = [
			{ role: "system", content: system },
			{ role: "user", content: "hi" },
		];
		const diffs = compareRequests({ systemPrompt: system, toolSpecs: [read], messages }, { messages, tools: [read] });
		expect(diffs.map((diff) => diff.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
	});

	it("returns WARN for reordered tools and missing section markers", () => {
		const ours = {
			systemPrompt: "<environment>e</environment>\n<tools>t</tools>",
			toolSpecs: [read, writeTool],
			messages: [
				{ role: "system", content: "x" },
				{ role: "user", content: "hi" },
			],
		};
		const real = {
			messages: [
				{ role: "system", content: "no markers here" },
				{ role: "user", content: "hi" },
			],
			tools: [writeTool, read],
		};
		const diffs = compareRequests(ours, real);
		expect(diffs.find((diff) => diff.name === "section order")?.status).toBe("WARN");
		expect(diffs.find((diff) => diff.name === "tool names")?.status).toBe("WARN");
		expect(diffs.find((diff) => diff.name === "tool count")?.status).toBe("PASS");
		expect(diffs.find((diff) => diff.name === "parameter names")?.status).toBe("PASS");
		expect(diffs.find((diff) => diff.name === "message roles")?.status).toBe("PASS");
	});

	it("returns FAIL for mismatched roles, tools, and parameters", () => {
		const ours = {
			systemPrompt: "<environment>e</environment>",
			toolSpecs: [read],
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "yo" },
			],
		};
		const real = {
			messages: [
				{ role: "system", content: "<environment>e</environment>" },
				{ role: "user", content: "hi" },
			],
			tools: [writeTool],
		};
		const diffs = compareRequests(ours, real);
		expect(diffs.find((diff) => diff.name === "section order")?.status).toBe("PASS");
		expect(diffs.find((diff) => diff.name === "tool names")?.status).toBe("FAIL");
		expect(diffs.find((diff) => diff.name === "tool count")?.status).toBe("PASS");
		expect(diffs.find((diff) => diff.name === "parameter names")?.status).toBe("FAIL");
		expect(diffs.find((diff) => diff.name === "message roles")?.status).toBe("FAIL");
	});
});
