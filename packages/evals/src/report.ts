/**
 * Reads per-task Vitest reports into observations, persists native sessions and
 * canonical traces, and summarizes results per profile.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import type { ReportCase } from "@vitest-evals/core";
import { readReportWorkspace, readVitestJsonReportFile } from "@vitest-evals/core/node";
import type { SuiteComparison } from "./config.ts";
import type { EvalTask } from "./plan.ts";
import { PI_TRACE_ARTIFACT, parseTraceArtifact, type TraceRecord } from "./trace.ts";

export const PI_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";

export type EvalRunIdentity = {
	evalSet: string;
	caseId: string;
	/** Capability family, when the task belongs to one. */
	family?: string;
	/** Root domain, when the task belongs to one. */
	domain?: string;
	profile: string;
	model: string;
	runNumber: number;
};

export type ExpectedEvalRun = EvalRunIdentity;

type EvalMetrics = {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	toolCalls?: number;
	totalMs?: number;
	estimatedCostUsd?: number;
};

export type EvalObservation = EvalRunIdentity &
	EvalMetrics &
	({ outcome: "scored"; score: number } | { outcome: "unscored" | "skipped" | "pending" | "errored" });

export type TaskResult = { observation: EvalObservation; trace?: TraceRecord };

export type PairedMetricSummary = {
	eligiblePairs: number;
	controlMean: number | null;
	treatmentMean: number | null;
	meanDelta: number | null;
};

export type EvalSetComparison = {
	evalSet: string;
	/** Capability family this eval set belongs to, or null. */
	family: string | null;
	/** Root domain this family belongs to, or null. */
	domain: string | null;
	totalPairs: number;
	eligiblePairs: number;
	blockedPairs: number;
	/** Pass rate per selected profile over eligible pairs. */
	passRates: Record<string, number | null>;
	control: string | null;
	treatment: string | null;
	lift: number | null;
	flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky">;
	totalTokens: PairedMetricSummary | null;
	toolCalls: PairedMetricSummary | null;
	totalMs: PairedMetricSummary | null;
	estimatedCostUsd: PairedMetricSummary | null;
};

/** Roll-up of all eval sets tagged with the same capability family. */
export type FamilySummary = {
	family: string;
	totalPairs: number;
	eligiblePairs: number;
	passRates: Record<string, number | null>;
};

export type DomainSummary = {
	domain: string;
	totalPairs: number;
	eligiblePairs: number;
	passRates: Record<string, number | null>;
};

export type BlockedPair = Omit<EvalRunIdentity, "profile"> & { reasons: string[] };

export type OperationalMetricTotal = { availableRuns: number; total: number | null };

export type ProfileTotals = {
	profile: string;
	runs: number;
	inputTokens: OperationalMetricTotal;
	outputTokens: OperationalMetricTotal;
	cacheReadTokens: OperationalMetricTotal;
	cacheWriteTokens: OperationalMetricTotal;
	totalTokens: OperationalMetricTotal;
	toolCalls: OperationalMetricTotal;
	totalMs: OperationalMetricTotal;
	estimatedCostUsd: OperationalMetricTotal;
};

export type EvalComparisonReport = {
	schemaVersion: 4;
	protocolDigest: string;
	suite: string;
	control: string | null;
	treatment: string | null;
	profiles: ProfileTotals[];
	comparisons: EvalSetComparison[];
	families: FamilySummary[];
	domains: DomainSummary[];
	blockedPairs: BlockedPair[];
};

export type ReportOptions = {
	protocolDigest: string;
	suite: string;
	profiles: readonly string[];
	comparison?: SuiteComparison;
};

function optionalMetric(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a finite non-negative number.`);
	}
	return value;
}

function validateScore(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError("Eval score must be between 0 and 1.");
	}
	return value;
}

function classifyCaseStatus(status: ReportCase["status"]): "errored" | "skipped" | "pending" | undefined {
	if (status === "failed") return "errored";
	if (status === "skipped" || status === "todo" || status === "disabled") return "skipped";
	if (status === "pending") return "pending";
	return undefined;
}

function taskIdentity(task: EvalTask): EvalRunIdentity {
	return {
		evalSet: task.evalSet,
		caseId: task.caseId,
		...(task.family ? { family: task.family } : {}),
		...(task.domain ? { domain: task.domain } : {}),
		profile: task.profile,
		model: task.model,
		runNumber: task.runNumber,
	};
}

export function erroredObservation(task: EvalTask): EvalObservation {
	return { ...taskIdentity(task), outcome: "errored" };
}

async function persistSession(caseResult: ReportCase, task: EvalTask, artifactDirectory: string): Promise<void> {
	const session = caseResult.harness?.run?.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT];
	if (typeof session !== "string") return;
	const identity = JSON.stringify([task.evalSet, task.caseId, task.profile, task.model, task.runNumber]);
	const directory = join(
		artifactDirectory,
		task.profile,
		"sessions",
		createHash("sha256").update(identity).digest("hex"),
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "session.jsonl"), session, { mode: 0o600 });
}

export async function readTaskResult(
	task: EvalTask,
	reportPath: string,
	artifactDirectory: string,
): Promise<TaskResult> {
	const identity = taskIdentity(task);
	const loaded = await Promise.all([readReportWorkspace([reportPath]), readVitestJsonReportFile(reportPath)]).catch(
		() => undefined,
	);
	if (!loaded) return { observation: { ...identity, outcome: "errored" } };
	const [{ workspace }, rawReport] = loaded;
	const reportedFullName = `${task.evalSet} ${task.caseId}`;
	const assertions = rawReport.testResults
		.flatMap(({ assertionResults }) => assertionResults)
		.filter(({ fullName }) => fullName === reportedFullName);
	if (assertions.length !== 1) return { observation: { ...identity, outcome: "errored" } };
	const assertion = assertions[0];
	const statusOutcome = classifyCaseStatus(assertion.status);
	if (statusOutcome === "skipped" || statusOutcome === "pending") {
		return { observation: { ...identity, outcome: statusOutcome } };
	}
	const caseResults = workspace.cases.filter(({ fullName }) => fullName === reportedFullName);
	if (caseResults.length !== 1) return { observation: { ...identity, outcome: "errored" } };
	const caseResult = caseResults[0];
	if (caseResult.status !== assertion.status) return { observation: { ...identity, outcome: "errored" } };
	const run = caseResult.harness?.run;
	if (!run) return { observation: { ...identity, outcome: "errored" } };
	await persistSession(caseResult, task, artifactDirectory);
	const actualModel = run.usage.provider && run.usage.model ? `${run.usage.provider}/${run.usage.model}` : undefined;
	if (actualModel !== task.model) return { observation: { ...identity, outcome: "errored" } };
	let metrics: EvalMetrics = {};
	try {
		metrics = {
			inputTokens: optionalMetric(run.usage.inputTokens, "inputTokens"),
			outputTokens: optionalMetric(run.usage.outputTokens, "outputTokens"),
			cacheReadTokens: optionalMetric(run.usage.metadata?.cacheReadTokens, "cacheReadTokens"),
			cacheWriteTokens: optionalMetric(run.usage.metadata?.cacheWriteTokens, "cacheWriteTokens"),
			totalTokens: optionalMetric(run.usage.totalTokens, "totalTokens"),
			toolCalls: optionalMetric(run.usage.toolCalls, "toolCalls"),
			totalMs: optionalMetric(run.timings?.totalMs, "totalMs"),
			estimatedCostUsd: optionalMetric(run.usage.metadata?.estimatedCostUsd, "estimatedCostUsd"),
		};
	} catch {
		return { observation: { ...identity, outcome: "errored" } };
	}
	if (statusOutcome === "errored" || run.errors.length > 0) {
		return { observation: { ...identity, ...metrics, outcome: "errored" } };
	}
	let score: number | undefined;
	try {
		score = validateScore(caseResult.eval?.avgScore);
	} catch {
		return { observation: { ...identity, ...metrics, outcome: "errored" } };
	}
	const trace = parseTraceArtifact(run.artifacts?.[PI_TRACE_ARTIFACT]);
	if (score === undefined) {
		return {
			observation: { ...identity, ...metrics, outcome: "unscored" },
			...(trace ? { trace: enrichTrace(trace, identity, "unscored") } : {}),
		};
	}
	return {
		observation: { ...identity, ...metrics, outcome: "scored", score },
		...(trace ? { trace: enrichTrace(trace, identity, "scored", score) } : {}),
	};
}

function enrichTrace(trace: TraceRecord, identity: EvalRunIdentity, outcome: string, score?: number): TraceRecord {
	return {
		...trace,
		metadata: {
			...trace.metadata,
			evalSet: identity.evalSet,
			caseId: identity.caseId,
			...(identity.family ? { family: identity.family } : {}),
			...(identity.domain ? { domain: identity.domain } : {}),
			runNumber: identity.runNumber,
			outcome,
			...(score === undefined ? {} : { score }),
		},
	};
}

type PairGroup = Omit<EvalRunIdentity, "profile"> & {
	expected: Map<string, number>;
	observations: Map<string, EvalObservation[]>;
};

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function difference(treatment: number, control: number): number {
	return Number((treatment - control).toPrecision(15));
}

function pairKey(identity: Omit<EvalRunIdentity, "profile">): string {
	return JSON.stringify([
		identity.evalSet,
		identity.caseId,
		identity.family ?? null,
		identity.domain ?? null,
		identity.model,
		identity.runNumber,
	]);
}

function groupPairs(expectedRuns: readonly ExpectedEvalRun[], observations: readonly EvalObservation[]): PairGroup[] {
	const groups = new Map<string, PairGroup>();
	const getGroup = (identity: EvalRunIdentity): PairGroup => {
		const key = pairKey(identity);
		const existing = groups.get(key);
		if (existing) return existing;
		const group: PairGroup = {
			evalSet: identity.evalSet,
			caseId: identity.caseId,
			...(identity.family ? { family: identity.family } : {}),
			...(identity.domain ? { domain: identity.domain } : {}),
			model: identity.model,
			runNumber: identity.runNumber,
			expected: new Map<string, number>(),
			observations: new Map<string, EvalObservation[]>(),
		};
		groups.set(key, group);
		return group;
	};
	for (const expected of expectedRuns) {
		const group = getGroup(expected);
		group.expected.set(expected.profile, (group.expected.get(expected.profile) ?? 0) + 1);
	}
	for (const observation of observations) {
		const group = getGroup(observation);
		const running = group.observations.get(observation.profile) ?? [];
		running.push(observation);
		group.observations.set(observation.profile, running);
	}
	return [...groups.values()].sort(
		(left, right) =>
			left.evalSet.localeCompare(right.evalSet) ||
			left.caseId.localeCompare(right.caseId) ||
			left.model.localeCompare(right.model) ||
			left.runNumber - right.runNumber,
	);
}

type ScoredGroup = Omit<EvalRunIdentity, "profile"> & { scores: Map<string, number> };

function resolveGroup(group: PairGroup, profiles: readonly string[]): { scored?: ScoredGroup; blocked?: BlockedPair } {
	const reasons: string[] = [];
	for (const profile of profiles) {
		const expected = group.expected.get(profile) ?? 0;
		const observed = group.observations.get(profile) ?? [];
		if (expected !== 1) reasons.push(`${profile}: design expected 1 run, found ${expected}`);
		if (observed.length !== expected) {
			reasons.push(
				`${profile}: expected ${expected} observation${expected === 1 ? "" : "s"}, found ${observed.length}`,
			);
		}
		if (expected === 1 && observed.length === 1 && observed[0].outcome !== "scored") {
			reasons.push(`${profile}: ${observed[0].outcome}`);
		}
	}
	if (reasons.length > 0) {
		return {
			blocked: {
				evalSet: group.evalSet,
				caseId: group.caseId,
				...(group.family ? { family: group.family } : {}),
				...(group.domain ? { domain: group.domain } : {}),
				model: group.model,
				runNumber: group.runNumber,
				reasons,
			},
		};
	}
	const scores = new Map<string, number>();
	for (const profile of profiles) {
		const observation = group.observations.get(profile)?.[0];
		if (observation?.outcome === "scored") scores.set(profile, observation.score);
	}
	return {
		scored: {
			evalSet: group.evalSet,
			caseId: group.caseId,
			...(group.family ? { family: group.family } : {}),
			...(group.domain ? { domain: group.domain } : {}),
			model: group.model,
			runNumber: group.runNumber,
			scores,
		},
	};
}

function summarizeMetric(
	groups: readonly ScoredGroup[],
	select: (observation: EvalObservation) => number | undefined,
	observations: readonly EvalObservation[],
	control: string,
	treatment: string,
): PairedMetricSummary {
	const controlValues: number[] = [];
	const treatmentValues: number[] = [];
	for (const group of groups) {
		const find = (profile: string) =>
			observations.find(
				(observation) =>
					observation.evalSet === group.evalSet &&
					observation.caseId === group.caseId &&
					(observation.family ?? null) === (group.family ?? null) &&
					(observation.domain ?? null) === (group.domain ?? null) &&
					observation.model === group.model &&
					observation.runNumber === group.runNumber &&
					observation.profile === profile,
			);
		const controlValue = find(control);
		const treatmentValue = find(treatment);
		const controlMetric = controlValue ? select(controlValue) : undefined;
		const treatmentMetric = treatmentValue ? select(treatmentValue) : undefined;
		if (controlMetric === undefined || treatmentMetric === undefined) continue;
		controlValues.push(controlMetric);
		treatmentValues.push(treatmentMetric);
	}
	const controlMean = mean(controlValues);
	const treatmentMean = mean(treatmentValues);
	return {
		eligiblePairs: controlValues.length,
		controlMean,
		treatmentMean,
		meanDelta: controlMean === null || treatmentMean === null ? null : difference(treatmentMean, controlMean),
	};
}

function operationalTotal(
	runs: readonly EvalObservation[],
	select: (observation: EvalObservation) => number | undefined,
): OperationalMetricTotal {
	const values = runs.flatMap((run) => {
		const value = select(run);
		return value === undefined ? [] : [value];
	});
	return {
		availableRuns: values.length,
		total: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
	};
}

function profileTotals(observations: readonly EvalObservation[], profile: string): ProfileTotals {
	const runs = observations.filter((observation) => observation.profile === profile);
	return {
		profile,
		runs: runs.length,
		inputTokens: operationalTotal(runs, ({ inputTokens }) => inputTokens),
		outputTokens: operationalTotal(runs, ({ outputTokens }) => outputTokens),
		cacheReadTokens: operationalTotal(runs, ({ cacheReadTokens }) => cacheReadTokens),
		cacheWriteTokens: operationalTotal(runs, ({ cacheWriteTokens }) => cacheWriteTokens),
		totalTokens: operationalTotal(runs, ({ totalTokens }) => totalTokens),
		toolCalls: operationalTotal(runs, ({ toolCalls }) => toolCalls),
		totalMs: operationalTotal(runs, ({ totalMs }) => totalMs),
		estimatedCostUsd: operationalTotal(runs, ({ estimatedCostUsd }) => estimatedCostUsd),
	};
}

function comparisonFlags(
	groups: readonly ScoredGroup[],
	controlPassRate: number | null,
	treatmentPassRate: number | null,
): Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky"> {
	const flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky"> = [];
	if (controlPassRate !== null && treatmentPassRate !== null) {
		if (controlPassRate === treatmentPassRate) flags.push("no-lift");
		if (treatmentPassRate < controlPassRate) flags.push("negative-delta");
		if (controlPassRate === 1) flags.push("control-saturated");
		if (treatmentPassRate === 1) flags.push("treatment-saturated");
	}
	const outcomes = new Map<string, Set<string>>();
	for (const group of groups) {
		for (const [profile, score] of group.scores) {
			const key = JSON.stringify([
				group.evalSet,
				group.caseId,
				group.model,
				group.family ?? null,
				group.domain ?? null,
				profile,
			]);
			const seen = outcomes.get(key) ?? new Set<string>();
			seen.add(String(score >= 1));
			outcomes.set(key, seen);
		}
	}
	if ([...outcomes.values()].some((values) => values.size > 1)) flags.push("flaky");
	return flags;
}

function passRate(groups: readonly ScoredGroup[], profile: string): number | null {
	const scored = groups.filter((group) => group.scores.has(profile));
	if (scored.length === 0) return null;
	return scored.filter((group) => (group.scores.get(profile) ?? 0) >= 1).length / scored.length;
}

export function summarizeEvalObservations(
	options: ReportOptions,
	expectedRuns: readonly ExpectedEvalRun[],
	observations: readonly EvalObservation[],
): EvalComparisonReport {
	const { profiles, comparison } = options;
	const groups = groupPairs(expectedRuns, observations);
	const blockedPairs: BlockedPair[] = [];
	const scoredByEvalSet = new Map<string, ScoredGroup[]>();
	const totalsByEvalSet = new Map<string, number>();
	const familiesByEvalSet = new Map<string, string | null>();
	const domainsByEvalSet = new Map<string, string | null>();
	const scoredByFamily = new Map<string, ScoredGroup[]>();
	const totalsByFamily = new Map<string, number>();
	const scoredByDomain = new Map<string, ScoredGroup[]>();
	const totalsByDomain = new Map<string, number>();
	for (const group of groups) {
		familiesByEvalSet.set(group.evalSet, group.family ?? null);
		domainsByEvalSet.set(group.evalSet, group.domain ?? null);
		if (group.family) totalsByFamily.set(group.family, (totalsByFamily.get(group.family) ?? 0) + 1);
		if (group.domain) totalsByDomain.set(group.domain, (totalsByDomain.get(group.domain) ?? 0) + 1);
		totalsByEvalSet.set(group.evalSet, (totalsByEvalSet.get(group.evalSet) ?? 0) + 1);
		const { scored, blocked } = resolveGroup(group, profiles);
		if (blocked) blockedPairs.push(blocked);
		if (scored) {
			scoredByEvalSet.set(group.evalSet, [...(scoredByEvalSet.get(group.evalSet) ?? []), scored]);
			if (scored.family) {
				scoredByFamily.set(scored.family, [...(scoredByFamily.get(scored.family) ?? []), scored]);
			}
			if (scored.domain) {
				scoredByDomain.set(scored.domain, [...(scoredByDomain.get(scored.domain) ?? []), scored]);
			}
		}
	}
	const families: FamilySummary[] = [...totalsByFamily]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([family, totalPairs]): FamilySummary => {
			const scored = scoredByFamily.get(family) ?? [];
			const passRates: Record<string, number | null> = {};
			for (const profile of profiles) passRates[profile] = passRate(scored, profile);
			return { family, totalPairs, eligiblePairs: scored.length, passRates };
		});
	const domains: DomainSummary[] = [...totalsByDomain]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([domain, totalPairs]): DomainSummary => {
			const scored = scoredByDomain.get(domain) ?? [];
			const passRates: Record<string, number | null> = {};
			for (const profile of profiles) passRates[profile] = passRate(scored, profile);
			return { domain, totalPairs, eligiblePairs: scored.length, passRates };
		});
	const comparisons = [...totalsByEvalSet]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([evalSet, totalPairs]): EvalSetComparison => {
			const scored = scoredByEvalSet.get(evalSet) ?? [];
			const blockedPairCount = totalPairs - scored.length;
			const publishRates = blockedPairCount === 0 && scored.length > 0;
			const passRates: Record<string, number | null> = {};
			for (const profile of profiles) passRates[profile] = publishRates ? passRate(scored, profile) : null;
			const control = comparison?.control ?? null;
			const treatment = comparison?.treatment ?? null;
			const controlPassRate = control ? (passRates[control] ?? null) : null;
			const treatmentPassRate = treatment ? (passRates[treatment] ?? null) : null;
			const hasComparison = control !== null && treatment !== null;
			return {
				evalSet,
				family: familiesByEvalSet.get(evalSet) ?? null,
				domain: domainsByEvalSet.get(evalSet) ?? null,
				totalPairs,
				eligiblePairs: scored.length,
				blockedPairs: blockedPairCount,
				passRates,
				control,
				treatment,
				lift:
					!hasComparison || controlPassRate === null || treatmentPassRate === null
						? null
						: difference(treatmentPassRate, controlPassRate),
				flags:
					hasComparison && publishRates
						? comparisonFlags(scored, controlPassRate, treatmentPassRate)
						: publishRates
							? comparisonFlags(scored, null, null).filter((flag) => flag === "flaky")
							: [],
				totalTokens:
					hasComparison && control && treatment
						? summarizeMetric(scored, ({ totalTokens }) => totalTokens, observations, control, treatment)
						: null,
				toolCalls:
					hasComparison && control && treatment
						? summarizeMetric(scored, ({ toolCalls }) => toolCalls, observations, control, treatment)
						: null,
				totalMs:
					hasComparison && control && treatment
						? summarizeMetric(scored, ({ totalMs }) => totalMs, observations, control, treatment)
						: null,
				estimatedCostUsd:
					hasComparison && control && treatment
						? summarizeMetric(
								scored,
								({ estimatedCostUsd }) => estimatedCostUsd,
								observations,
								control,
								treatment,
							)
						: null,
			};
		});
	return {
		schemaVersion: 4,
		protocolDigest: options.protocolDigest,
		suite: options.suite,
		control: comparison?.control ?? null,
		treatment: comparison?.treatment ?? null,
		profiles: profiles.map((profile) => profileTotals(observations, profile)),
		comparisons,
		families,
		domains,
		blockedPairs,
	};
}

function percentage(value: number | null): string {
	return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function pairedMetric(label: string, metric: PairedMetricSummary | null, unit = ""): string {
	if (!metric || metric.meanDelta === null || metric.controlMean === null || metric.treatmentMean === null) {
		return `    ${label.padStart(10)}  unavailable`;
	}
	return `    ${label.padStart(10)}  ${signed(metric.meanDelta, 1)}${unit} (with ${metric.treatmentMean.toFixed(1)}${unit}, without ${metric.controlMean.toFixed(1)}${unit}, ${metric.eligiblePairs} pairs)`;
}

function operationalMetric(metric: OperationalMetricTotal, runs: number, format: (total: number) => string): string {
	if (metric.total === null) return `unavailable (0/${runs} measured)`;
	const coverage = metric.availableRuns === runs ? "" : ` (${metric.availableRuns}/${runs} measured)`;
	return `${format(metric.total)}${coverage}`;
}

export function formatEvalComparisonReport(report: EvalComparisonReport): string {
	if (report.comparisons.length === 0) return "";
	const lines = [styleText("bold", `Eval Suite: ${report.suite}`)];
	for (const comparison of report.comparisons) {
		lines.push(
			`  ${comparison.evalSet}${comparison.family ? ` [${comparison.family}]` : ""}${comparison.domain ? ` {${comparison.domain}}` : ""}`,
		);
		lines.push(`         Pairs  ${comparison.eligiblePairs}/${comparison.totalPairs} eligible`);
		if (comparison.blockedPairs > 0) {
			lines.push("     Pass rate  withheld because pairs are blocked");
		} else if (comparison.control && comparison.treatment && comparison.lift !== null) {
			lines.push(
				`     Pass rate  ${signed(comparison.lift * 100, 1)} pp (${comparison.treatment} ${percentage(comparison.passRates[comparison.treatment] ?? null)}, ${comparison.control} ${percentage(comparison.passRates[comparison.control] ?? null)})`,
			);
		} else if (comparison.control && comparison.treatment) {
			lines.push("     Pass rate  unavailable");
		} else {
			const rates = Object.entries(comparison.passRates)
				.map(([profile, rate]) => `${profile} ${percentage(rate)}`)
				.join(", ");
			lines.push(`     Pass rate  ${rates}`);
		}
		if (comparison.flags.length > 0) lines.push(`         Flags  ${comparison.flags.join(", ")}`);
		if (comparison.control && comparison.treatment) {
			lines.push(pairedMetric("Tokens", comparison.totalTokens));
			lines.push(pairedMetric("Tools", comparison.toolCalls));
			lines.push(pairedMetric("Latency", comparison.totalMs, "ms"));
			const cost = comparison.estimatedCostUsd;
			if (!cost || cost.meanDelta === null || cost.controlMean === null || cost.treatmentMean === null) {
				lines.push("     Est. cost  unavailable");
			} else {
				lines.push(
					`     Est. cost  ${cost.meanDelta >= 0 ? "+" : "-"}$${Math.abs(cost.meanDelta).toFixed(4)} (with $${cost.treatmentMean.toFixed(4)}, without $${cost.controlMean.toFixed(4)}, ${cost.eligiblePairs} pairs)`,
				);
			}
		}
	}
	if (report.domains.length > 0) {
		lines.push("  Domains");
		for (const domain of report.domains) {
			const rates = Object.entries(domain.passRates)
				.map(([profile, rate]) => `${profile} ${percentage(rate)}`)
				.join(", ");
			lines.push(`    ${domain.domain}: ${domain.eligiblePairs}/${domain.totalPairs} pairs, ${rates}`);
		}
	}
	if (report.families.length > 0) {
		lines.push("  Families");
		for (const family of report.families) {
			const rates = Object.entries(family.passRates)
				.map(([profile, rate]) => `${profile} ${percentage(rate)}`)
				.join(", ");
			lines.push(`    ${family.family}: ${family.eligiblePairs}/${family.totalPairs} pairs, ${rates}`);
		}
	}
	lines.push("  Operational totals");
	for (const totals of report.profiles) {
		const tokens = operationalMetric(totals.totalTokens, totals.runs, (total) => `${total} tokens`);
		const tools = operationalMetric(totals.toolCalls, totals.runs, (total) => `${total} tools`);
		const latency = operationalMetric(totals.totalMs, totals.runs, (total) => `${(total / 1000).toFixed(2)}s`);
		const cost = operationalMetric(totals.estimatedCostUsd, totals.runs, (total) => `$${total.toFixed(4)} cost`);
		lines.push(`    ${totals.profile}: ${totals.runs} runs, ${tokens}, ${tools}, ${latency}, ${cost}`);
	}
	if (report.blockedPairs.length > 0) {
		lines.push("  Blocked pairs");
		for (const blocked of report.blockedPairs) {
			lines.push(
				`    ${blocked.evalSet}/${blocked.caseId}/${blocked.model}/run-${blocked.runNumber}: ${blocked.reasons.join("; ")}`,
			);
		}
	}
	return lines.join("\n");
}
