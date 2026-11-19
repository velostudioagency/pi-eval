/** Verified-run metrics: exclusive failure buckets, rates, and Wilson intervals. */

export type AgentCheck = {
	type: string;
	ok: boolean;
	detail?: string;
};

export type AgentAction = {
	name?: string;
	text?: string;
	skinnedName?: string;
	meta?: Record<string, unknown>;
};

export type AgentUsage = Record<string, number>;

export type AgentVerification = { checks: AgentCheck[] };

export type AgentRunError = string | { kind?: string; message?: string };

export type AgentRunResult = {
	profileId: string;
	taskId: string;
	ok: boolean;
	actions: AgentAction[];
	verification: AgentVerification;
	usage: AgentUsage;
	error?: AgentRunError;
	stopReason?: string;
};

/** Run-level failure buckets, in the order the first matching bucket wins. */
export const FAILURE_BUCKETS = [
	"infra_error",
	"fault_removed_tool",
	"hallucinated_tool",
	"invalid_arguments",
	"rule_violation",
	"verification_failure",
] as const;

export type FailureBucket = (typeof FAILURE_BUCKETS)[number] | "success";

export type AgentRunSummary = {
	successRate: number;
	partialCredit: number;
	wilson95: [number, number];
	buckets: Record<FailureBucket, number>;
	diagnosticRates: {
		hallucinatedToolRate: number;
		invalidArgumentsRate: number;
		/** Aliases mirroring the source Python metric names. */
		hallucinated_tool_rate: number;
		invalid_arguments_rate: number;
	};
	tokenTotals: Record<string, number>;
	totalRuns: number;
};

const RULE_CHECK_TYPES = new Set([
	"read_before_edit",
	"no_write_outside",
	"forbidden_command",
	"required_command",
	"max_actions",
]);

function actionMeta(action: AgentAction): Record<string, unknown> {
	return action.meta ?? {};
}

function actionText(action: AgentAction): string {
	return `${action.name ?? ""} ${action.text ?? ""}`;
}

function validationError(meta: Record<string, unknown>): string {
	const value = meta.validation_error;
	return typeof value === "string" ? value : "";
}

function isFaultRemoved(action: AgentAction): boolean {
	const meta = actionMeta(action);
	return (
		validationError(meta) === "fault_removed" || (meta.fault_removed !== undefined && meta.fault_removed !== null)
	);
}

function isUnknownTool(action: AgentAction): boolean {
	if (isFaultRemoved(action)) return false;
	return (
		validationError(actionMeta(action)) === "unknown_tool" ||
		actionText(action).toLowerCase().includes("unknown tool")
	);
}

function isInvalidArguments(action: AgentAction): boolean {
	if (isFaultRemoved(action) || isUnknownTool(action)) return false;
	const code = validationError(actionMeta(action));
	return (
		code === "arguments" ||
		code === "type" ||
		code === "skin" ||
		code === "fault" ||
		actionText(action).toLowerCase().includes("validation failed")
	);
}

function failedRuleChecks(result: AgentRunResult): AgentCheck[] {
	return result.verification.checks.filter((check) => !check.ok && RULE_CHECK_TYPES.has(check.type));
}

function isInfraError(result: AgentRunResult): boolean {
	if (result.stopReason === "infra_error") return true;
	const error = result.error;
	if (typeof error === "string") return error === "infra_error";
	return error?.kind === "infra_error";
}

/** Assign one exclusive bucket to a run; infra errors and successes are first. */
export function failureBucket(result: AgentRunResult): FailureBucket {
	if (isInfraError(result)) return "infra_error";
	if (result.ok) return "success";
	if (result.actions.some(isFaultRemoved)) return "fault_removed_tool";
	if (result.actions.some(isUnknownTool)) return "hallucinated_tool";
	if (result.actions.some(isInvalidArguments)) return "invalid_arguments";
	if (failedRuleChecks(result).length > 0) return "rule_violation";
	return "verification_failure";
}

function rate(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Wilson score 95% confidence interval for a binomial proportion. */
export function wilsonInterval(successes: number, total: number, z = 1.96): [number, number] {
	if (total <= 0) return [0, 0];
	const p = successes / total;
	const z2 = z * z;
	const denominator = 1 + z2 / total;
	const center = (p + z2 / (2 * total)) / denominator;
	const half = (z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
	return [clamp01(center - half), clamp01(center + half)];
}

function sumTokenTotals(results: AgentRunResult[]): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const result of results) {
		for (const [key, value] of Object.entries(result.usage)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				totals[key] = (totals[key] ?? 0) + value;
			}
		}
	}
	if ("totalTokens" in totals || "total_tokens" in totals) return totals;
	const prompt = totals.promptTokens ?? totals.prompt_tokens ?? 0;
	const completion = totals.completionTokens ?? totals.completion_tokens ?? 0;
	if (prompt || completion) {
		const total = prompt + completion;
		if ("prompt_tokens" in totals || "completion_tokens" in totals) totals.total_tokens = total;
		else totals.totalTokens = total;
	}
	return totals;
}

function emptyBuckets(): Record<FailureBucket, number> {
	return {
		infra_error: 0,
		fault_removed_tool: 0,
		hallucinated_tool: 0,
		invalid_arguments: 0,
		rule_violation: 0,
		verification_failure: 0,
		success: 0,
	};
}

/** Summarize a set of runs with only finite numeric outputs. */
export function summarizeAgentRuns(results: AgentRunResult[]): AgentRunSummary {
	const totalRuns = results.length;
	const scored = results.filter((result) => !isInfraError(result));
	const successes = scored.filter((result) => result.ok).length;
	const buckets = emptyBuckets();
	for (const result of results) buckets[failureBucket(result)] += 1;

	let totalChecks = 0;
	let passedChecks = 0;
	let totalActions = 0;
	let hallucinatedActions = 0;
	let invalidArgumentActions = 0;
	for (const result of scored) {
		for (const check of result.verification.checks) {
			totalChecks += 1;
			if (check.ok) passedChecks += 1;
		}
		for (const action of result.actions) {
			totalActions += 1;
			if (isUnknownTool(action)) hallucinatedActions += 1;
			else if (isInvalidArguments(action)) invalidArgumentActions += 1;
		}
	}

	const hallucinatedToolRate = rate(hallucinatedActions, totalActions);
	const invalidArgumentsRate = rate(invalidArgumentActions, totalActions);
	return {
		successRate: rate(successes, scored.length),
		partialCredit: rate(passedChecks, totalChecks),
		wilson95: wilsonInterval(successes, scored.length),
		buckets,
		diagnosticRates: {
			hallucinatedToolRate,
			invalidArgumentsRate,
			hallucinated_tool_rate: hallucinatedToolRate,
			invalid_arguments_rate: invalidArgumentsRate,
		},
		tokenTotals: sumTokenTotals(scored),
		totalRuns,
	};
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/** Render a summary as a human-readable report string. */
export function printAgentReport(summary: AgentRunSummary): string {
	const [low, high] = summary.wilson95;
	const bucketLine = Object.entries(summary.buckets)
		.map(([name, count]) => `${name}=${count}`)
		.join(", ");
	return [
		`runs: ${summary.totalRuns}`,
		`success rate: ${percent(summary.successRate)} (95% CI [${percent(low)}, ${percent(high)}])`,
		`partial credit: ${percent(summary.partialCredit)}`,
		`buckets (exclusive, priority order): ${bucketLine}`,
		`hallucinated tool rate: ${percent(summary.diagnosticRates.hallucinatedToolRate)}`,
		`invalid arguments rate: ${percent(summary.diagnosticRates.invalidArgumentsRate)}`,
		`tokens: ${JSON.stringify(summary.tokenTotals)}`,
	].join("\n");
}
