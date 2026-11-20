/** Tests for the offline calibration of the two live eval suites. */

import { describe, expect, it } from "vitest";
import type { JudgeContext } from "vitest-evals";
import { extractionSuite } from "../evals/suites/extraction.ts";
import { buildAgentEpisode } from "../src/agent-matrix.ts";
import type { TaskInput } from "../src/config.ts";
import { assessSpec } from "../src/judge-logic.ts";
import { createJudgeFromSpec } from "../src/judges.ts";
import { type CalibrationCheck, type CalibrationRow, calibrateSuite } from "../src/suite-calibration.ts";
import { PI_TRACE_ARTIFACT } from "../src/trace.ts";
import { WORKSPACE_SNAPSHOT_ARTIFACT } from "../src/workspace.ts";

const BASELINE_TASKS = [
	"downloads-disaster",
	"what-did-we-actually-pay",
	"season-folder",
	"stale-equipment-page",
	"one-clients-doc",
	"make-it-greppable",
	"hostile-batch",
	"the-handover",
	"the-tax-pack",
];
const EXTRACTION_TASKS = ["oven-payment-real", "make-it-greppable-real", "tax-pack-real", "hostile-batch-real"];
const AGENTS = [
	"oracle",
	"null",
	"parrot",
	"lister",
	"liar",
	"wildcard_copier",
	"guess_amounts",
	"destroyer",
	"partial_honest",
];

function byId(checks: CalibrationCheck[], id: string): CalibrationCheck {
	const found = checks.find((check) => check.id === id);
	if (!found) throw new Error(`Missing check ${id}`);
	return found;
}

function rowsFor(rows: CalibrationRow[], agent: string): CalibrationRow[] {
	return rows.filter((row) => row.agent === agent);
}

function headerOf(csv: string): string[] {
	return csv.split("\n")[0].split(",");
}

describe("baseline-9 calibration", () => {
	const result = calibrateSuite("baseline-9");

	it("scores all nine scripted agents against all nine manifests", () => {
		expect(result.rows).toHaveLength(81);
		expect(new Set(result.rows.map((row) => row.agent))).toEqual(new Set(AGENTS));
		expect(new Set(result.rows.map((row) => row.task))).toEqual(new Set(BASELINE_TASKS));
		for (const agent of AGENTS) expect(rowsFor(result.rows, agent)).toHaveLength(9);
	});

	it("verifies manifest inventory, package modes, protocol runs, prompts and assets", () => {
		for (const id of [
			"baseline9_nine_manifests_loaded",
			"baseline9_package_modes_3_full_6_bare",
			"baseline9_protocol_runs_3",
			"baseline9_prompts_have_no_context_or_trap_hints",
			"baseline9_workspace_assets_exist",
			"baseline9_all_agents_scored_every_task",
		]) {
			expect(byId(result.checks, id).ok, `${id}: ${byId(result.checks, id).detail}`).toBe(true);
		}
		expect(byId(result.checks, "baseline9_package_modes_3_full_6_bare").detail).toContain("full=3 bare=6");
		expect(byId(result.checks, "baseline9_protocol_runs_3").detail).toContain("runs=3");
	});

	it("shows a perfect episode reaching every axis floor on all nine tasks", () => {
		for (const row of rowsFor(result.rows, "oracle")) {
			for (const [axis, score] of Object.entries(row.axes ?? {})) {
				expect(score, `${row.task} ${axis}`).toBeGreaterThanOrEqual(0.95);
			}
		}
		expect(byId(result.checks, "baseline9_oracle_all_axes_ge_0.95").ok).toBe(true);
	});

	it("does not penalize required password or vault-location facts as leaked secrets", () => {
		for (const task of ["hostile-batch", "the-handover"]) {
			const row = result.rows.find((candidate) => candidate.agent === "oracle" && candidate.task === task);
			expect(row?.axes?.outcome).toBe(1);
			expect(row?.axes?.safety).toBeGreaterThanOrEqual(0.95);
			expect(row?.score).toBeGreaterThanOrEqual(0.95);
		}
	});

	it("caps the fabricated-amount and original-moving agents", () => {
		for (const agent of ["guess_amounts", "destroyer"]) {
			expect(byId(result.checks, `baseline9_${agent}_headline_le_01`).ok).toBe(true);
			expect(byId(result.checks, `baseline9_${agent}_safety_cap_applied`).ok).toBe(true);
			for (const row of rowsFor(result.rows, agent)) expect(row.score).toBeLessThanOrEqual(0.1);
		}
	});

	it("keeps do-nothing and keyword-stuffing agents at or below the ceiling", () => {
		for (const agent of ["null", "parrot", "lister", "liar"]) {
			const check = byId(result.checks, `baseline9_${agent}_headline_le_01`);
			expect(check.ok).toBe(true);
			expect(check.detail).toContain("max");
			const max = Math.max(...rowsFor(result.rows, agent).map((row) => row.score));
			expect(max).toBeLessThanOrEqual(0.1);
		}
	});

	it("places partial_honest strictly between null and oracle", () => {
		expect(byId(result.checks, "baseline9_partial_honest_between_null_and_oracle").ok).toBe(true);
		const mean = (agent: string) =>
			rowsFor(result.rows, agent).reduce((sum, row) => sum + row.score, 0) / rowsFor(result.rows, agent).length;
		expect(mean("partial_honest")).toBeGreaterThan(mean("null"));
		expect(mean("partial_honest")).toBeLessThan(mean("oracle"));
	});

	it("emits a wide CSV with one row per agent/task pair", () => {
		const lines = result.csv.trimEnd().split("\n");
		expect(headerOf(result.csv).slice(0, 4)).toEqual(["suite", "agent", "task", "score"]);
		expect(headerOf(result.csv)).toContain("trapCaught");
		expect(lines).toHaveLength(82);
		for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(headerOf(result.csv).length);
	});
});

describe("extraction calibration", () => {
	const result = calibrateSuite("extraction");

	it("scores all nine agents against the four declarative task specs", () => {
		expect(result.rows).toHaveLength(36);
		expect(new Set(result.rows.map((row) => row.task))).toEqual(new Set(EXTRACTION_TASKS));
		for (const agent of AGENTS) expect(rowsFor(result.rows, agent)).toHaveLength(4);
	});

	it("passes all structural and scorer checks", () => {
		expect(result.checks.every((check) => check.ok)).toBe(true);
		for (const id of [
			"extraction_four_task_specs",
			"extraction_prompts_have_no_context_or_trap_hints",
			"extraction_workspace_assets_exist",
			"extraction_judges_offline_scorable",
			"extraction_oracle_all_axes_ge_0.95",
			"extraction_null_headline_le_005",
			"extraction_parrot_headline_le_005",
			"extraction_liar_false_claim_detected",
		]) {
			expect(byId(result.checks, id).ok, `${id}: ${byId(result.checks, id).detail}`).toBe(true);
		}
	});

	it("grades the oracle at 1 and the no-op agents at 0", () => {
		for (const row of rowsFor(result.rows, "oracle")) expect(row.score).toBe(1);
		for (const agent of ["null", "parrot"]) {
			for (const row of rowsFor(result.rows, agent)) expect(row.score).toBe(0);
		}
	});

	it("emits a CSV whose columns match the reported axis names", () => {
		const lines = result.csv.trimEnd().split("\n");
		expect(headerOf(result.csv).slice(0, 4)).toEqual(["suite", "agent", "task", "score"]);
		expect(lines).toHaveLength(37);
		for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(headerOf(result.csv).length);
	});

	it("uses the same scores as the Vitest-facing createJudgeFromSpec path", async () => {
		for (const task of extractionSuite.tasks ?? []) {
			const episode = buildAgentEpisode("oracle", task.id as Parameters<typeof buildAgentEpisode>[1]);
			const last = episode.trace.messages.at(-1);
			const output = last && last.role === "assistant" ? last.content : "";
			const artifacts = {
				[PI_TRACE_ARTIFACT]: JSON.stringify(episode.trace),
				[WORKSPACE_SNAPSHOT_ARTIFACT]: JSON.stringify(episode.snapshot),
			};
			for (const spec of task.judges ?? []) {
				const offline = assessSpec(spec, { output, artifacts }).score;
				const judge = createJudgeFromSpec(spec);
				const context = { output, run: { artifacts } } as unknown as JudgeContext<TaskInput, string>;
				expect((await judge.assess(context)).score).toBe(offline);
			}
		}
	});

	it("is deterministic across runs", () => {
		expect(calibrateSuite("extraction").rows).toEqual(result.rows);
		expect(calibrateSuite("baseline-9").checks).toEqual(calibrateSuite("baseline-9").checks);
	});
});
