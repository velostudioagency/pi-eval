import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
	type EvalObservation,
	type ExpectedEvalRun,
	formatEvalComparisonReport,
	type ReportOptions,
	summarizeEvalObservations,
} from "../src/report.ts";

const PROFILES = ["without_docs", "with_docs"] as const;
const OPTIONS: ReportOptions = {
	protocolDigest: "digest",
	suite: "docs",
	profiles: [...PROFILES],
	comparison: { control: "without_docs", treatment: "with_docs" },
};

function scored(
	profile: string,
	runNumber: number,
	score: number,
	metrics: Partial<{
		totalTokens: number;
		toolCalls: number;
		totalMs: number;
		estimatedCostUsd: number;
	}> = {},
): EvalObservation {
	return {
		evalSet: "tool access",
		caseId: "create",
		profile,
		model: "fixture/model",
		runNumber,
		outcome: "scored",
		score,
		totalTokens: 100,
		toolCalls: 2,
		totalMs: 1000,
		estimatedCostUsd: 0.01,
		...metrics,
	};
}

function errored(profile: string, runNumber: number, totalTokens?: number): EvalObservation {
	return {
		evalSet: "tool access",
		caseId: "create",
		profile,
		model: "fixture/model",
		runNumber,
		outcome: "errored",
		totalTokens,
	};
}

function expectedFor(runNumbers: readonly number[]): ExpectedEvalRun[] {
	return runNumbers.flatMap((runNumber) =>
		PROFILES.map((profile) => ({
			evalSet: "tool access",
			caseId: "create",
			profile,
			model: "fixture/model",
			runNumber,
		})),
	);
}

describe("summarizeEvalObservations", () => {
	it("computes paired lift and efficiency deltas", () => {
		const observations = [
			scored("without_docs", 1, 0, { totalTokens: 100, toolCalls: 3, totalMs: 1000 }),
			scored("with_docs", 1, 1, { totalTokens: 120, toolCalls: 2, totalMs: 800 }),
			scored("without_docs", 2, 1, { totalTokens: 200 }),
			scored("with_docs", 2, 1, { totalTokens: 180 }),
		];
		const report = summarizeEvalObservations(OPTIONS, expectedFor([1, 2]), observations);
		expect(report.comparisons).toEqual([
			expect.objectContaining({
				evalSet: "tool access",
				totalPairs: 2,
				eligiblePairs: 2,
				blockedPairs: 0,
				passRates: { without_docs: 0.5, with_docs: 1 },
				lift: 0.5,
				totalTokens: { eligiblePairs: 2, controlMean: 150, treatmentMean: 150, meanDelta: 0 },
				toolCalls: { eligiblePairs: 2, controlMean: 2.5, treatmentMean: 2, meanDelta: -0.5 },
				totalMs: { eligiblePairs: 2, controlMean: 1000, treatmentMean: 900, meanDelta: -100 },
				estimatedCostUsd: { eligiblePairs: 2, controlMean: 0.01, treatmentMean: 0.01, meanDelta: 0 },
			}),
		]);
	});

	it("reports per-profile pass rates without declaring a comparison", () => {
		const report = summarizeEvalObservations(
			{ protocolDigest: "digest", suite: "example", profiles: ["default", "no-tools"] },
			expectedFor([1]).map((run) => ({ ...run, profile: run.profile === "with_docs" ? "no-tools" : "default" })),
			[scored("default", 1, 1), scored("no-tools", 1, 0)],
		);
		expect(report.comparisons[0]).toEqual(
			expect.objectContaining({
				passRates: { default: 1, "no-tools": 0 },
				lift: null,
				totalTokens: null,
			}),
		);
	});

	it("groups results by capability family", () => {
		const observations = [
			{ ...scored("without_docs", 1, 0), family: "tools" },
			{ ...scored("with_docs", 1, 1), family: "tools" },
		];
		const expected = expectedFor([1]).map((run) => ({ ...run, family: "tools" }));
		const report = summarizeEvalObservations(OPTIONS, expected, observations);
		expect(report.comparisons[0]).toMatchObject({ family: "tools", lift: 1 });
		expect(report.families).toEqual([
			{
				family: "tools",
				totalPairs: 1,
				eligiblePairs: 1,
				passRates: { without_docs: 0, with_docs: 1 },
			},
		]);
		expect(stripVTControlCharacters(formatEvalComparisonReport(report))).toContain("[tools]");
	});

	it("rolls families up into a root domain", () => {
		const observations = [
			{ ...scored("without_docs", 1, 0), family: "read", domain: "data-manipulation" },
			{ ...scored("with_docs", 1, 1), family: "read", domain: "data-manipulation" },
			{ ...scored("without_docs", 2, 1), family: "write", domain: "data-manipulation" },
			{ ...scored("with_docs", 2, 1), family: "write", domain: "data-manipulation" },
		];
		const expected = expectedFor([1, 2]).flatMap((run) => [
			{ ...run, family: run.runNumber === 1 ? "read" : "write", domain: "data-manipulation" },
		]);
		const report = summarizeEvalObservations(OPTIONS, expected, observations);
		expect(report.domains).toEqual([
			{
				domain: "data-manipulation",
				totalPairs: 2,
				eligiblePairs: 2,
				passRates: { without_docs: 0.5, with_docs: 1 },
			},
		]);
		expect(stripVTControlCharacters(formatEvalComparisonReport(report))).toContain("{data-manipulation}");
	});

	it("fails closed for incomplete and errored pairs while retaining totals", () => {
		const observations: EvalObservation[] = [
			scored("without_docs", 1, 0),
			errored("with_docs", 1, 120),
			scored("without_docs", 2, 1, { totalTokens: 200 }),
		];
		const report = summarizeEvalObservations(OPTIONS, expectedFor([1, 2]), observations);
		expect(report.comparisons[0]).toEqual(
			expect.objectContaining({ totalPairs: 2, eligiblePairs: 0, blockedPairs: 2, lift: null }),
		);
		expect(report.blockedPairs).toEqual([
			expect.objectContaining({ runNumber: 1, reasons: ["with_docs: errored"] }),
			expect.objectContaining({ runNumber: 2, reasons: ["with_docs: expected 1 observation, found 0"] }),
		]);
		expect(report.profiles[0].totalTokens).toEqual({ availableRuns: 2, total: 300 });
	});

	it("blocks duplicate observations and keeps missing metrics distinct from zero", () => {
		const withoutTokens = scored("without_docs", 1, 1);
		delete withoutTokens.totalTokens;
		const report = summarizeEvalObservations(OPTIONS, expectedFor([1]), [
			withoutTokens,
			withoutTokens,
			scored("with_docs", 1, 1, { totalTokens: 0 }),
		]);
		expect(report.blockedPairs[0].reasons).toEqual(["without_docs: expected 1 observation, found 2"]);
		expect(report.profiles[0].totalTokens).toEqual({ availableRuns: 0, total: null });
		expect(report.profiles[1].totalTokens).toEqual({ availableRuns: 1, total: 0 });
	});

	it("formats blocked comparisons and operational totals", () => {
		const report = summarizeEvalObservations(OPTIONS, expectedFor([1, 2]), [
			scored("without_docs", 1, 1),
			scored("with_docs", 1, 1),
		]);
		const formatted = stripVTControlCharacters(formatEvalComparisonReport(report));
		expect(formatted).toContain("Eval Suite: docs");
		expect(formatted).toContain("Pass rate  withheld because pairs are blocked");
		expect(formatted).toContain("without_docs: 1 runs");
	});
});
