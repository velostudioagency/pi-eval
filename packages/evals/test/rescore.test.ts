import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessSpec } from "../src/judge-logic.ts";
import type { EvalTask } from "../src/plan.ts";
import { rescoreArtifacts } from "../src/rescore.ts";
import { PI_TRACE_ARTIFACT } from "../src/trace.ts";

describe("offline rescore parity", () => {
	let dir: string;
	const task: EvalTask = {
		file: "evals/suite.eval.ts",
		fullName: "smoke > answers-a-fact",
		evalSet: "smoke",
		caseId: "answers-a-fact",
		profile: "default",
		model: "fixture/model",
		runNumber: 1,
	};
	const trace = {
		schemaVersion: 1,
		messages: [
			{ role: "user", content: "capital?" },
			{ role: "assistant", content: "Paris" },
		],
		metadata: {
			profile: "default",
			model: "fixture/model",
			evalSet: "smoke",
			caseId: "answers-a-fact",
			runNumber: 1,
			outcome: "scored",
			score: 1,
		},
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-rescore-"));
		const digest = "test-digest";
		writeFileSync(
			join(dir, "protocol.json"),
			JSON.stringify({ schemaVersion: 2, suite: { id: "example" }, protocolDigest: digest, profiles: ["default"] }),
		);
		writeFileSync(join(dir, "expected-runs.json"), JSON.stringify([task]));
		writeFileSync(join(dir, "observations.jsonl"), `${JSON.stringify({ ...task, outcome: "scored", score: 1 })}\n`);
		writeFileSync(join(dir, "traces.jsonl"), `${JSON.stringify(trace)}\n`);
		const key = JSON.stringify([task.evalSet, task.caseId, task.profile, task.model, task.runNumber]);
		mkdirSync(join(dir, "judge-inputs"), { recursive: true });
		const file = join(dir, "judge-inputs", `${createHash("sha256").update(key).digest("hex")}.json`);
		writeFileSync(file, JSON.stringify({ ...task, artifacts: { [PI_TRACE_ARTIFACT]: JSON.stringify(trace) } }));
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("matches the live judge result on the same trace", async () => {
		const live = assessSpec(
			{ type: "exact", expected: "Paris" },
			{
				output: "Paris",
				artifacts: { [PI_TRACE_ARTIFACT]: JSON.stringify(trace) },
			},
		);
		expect(live.score).toBe(1);
		await rescoreArtifacts(dir);
		const observations = readFileSync(join(dir, "observations.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { score?: number });
		expect(observations[0]?.score).toBe(live.score);
	});
});
