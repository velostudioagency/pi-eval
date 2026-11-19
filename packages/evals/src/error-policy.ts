/**
 * Failure classification adapted from Harbor's trial error policy.
 *
 * Three independent decisions matter: whether a run is worth retrying,
 * whether it should be graded at all, and whether a zero reward is a valid
 * measurement rather than a missing one. Keeping them separate avoids
 * counting infrastructure failures as model failures.
 */

export type ErrorPolicy = {
	shouldRetry: boolean;
	shouldGrade: boolean;
	hasValidReward: boolean;
};

export type TrialError = { kind: string; policy: ErrorPolicy };

const RETRY_NO_GRADE: ErrorPolicy = { shouldRetry: true, shouldGrade: false, hasValidReward: false };
const RETRY_GRADE: ErrorPolicy = { shouldRetry: true, shouldGrade: true, hasValidReward: false };
const TERMINAL_GRADE: ErrorPolicy = { shouldRetry: false, shouldGrade: true, hasValidReward: false };
const TERMINAL_NO_GRADE: ErrorPolicy = { shouldRetry: false, shouldGrade: false, hasValidReward: false };
const TERMINAL_VALID_REWARD: ErrorPolicy = { shouldRetry: false, shouldGrade: true, hasValidReward: true };
const UNKNOWN: ErrorPolicy = { shouldRetry: true, shouldGrade: true, hasValidReward: true };

const POLICIES: Record<string, ErrorPolicy> = {
	// Infrastructure: retry, do not grade.
	ReportNotFoundError: RETRY_NO_GRADE,
	WorkspaceReportError: RETRY_NO_GRADE,
	AssertionMismatchError: RETRY_NO_GRADE,
	HostEvalStartupError: RETRY_NO_GRADE,
	TimeoutError: RETRY_NO_GRADE,
	// Transient provider or network failures: retry, no valid reward yet.
	ApiError: RETRY_GRADE,
	ApiRateLimitError: RETRY_GRADE,
	ApiConnectionError: RETRY_GRADE,
	NetworkConnectionError: RETRY_GRADE,
	// Deterministic harness or agent failures: grade, but no valid reward.
	ModelIdentityError: TERMINAL_GRADE,
	ModelNotFoundError: TERMINAL_GRADE,
	VerifierError: TERMINAL_GRADE,
	RewardParseError: TERMINAL_GRADE,
	// Misconfiguration: neither retry nor grade.
	AuthenticationError: TERMINAL_NO_GRADE,
	ConfigurationError: TERMINAL_NO_GRADE,
	CancelledError: TERMINAL_NO_GRADE,
	// Agent failures that are real measurements: zero is a valid reward.
	AgentTimeoutError: TERMINAL_VALID_REWARD,
	ContextWindowExceededError: TERMINAL_VALID_REWARD,
	AgentSafetyRefusalError: TERMINAL_VALID_REWARD,
	AgentExitError: TERMINAL_VALID_REWARD,
};

/** Resolve the policy for a stored error kind. Unknown kinds are retryable and gradeable. */
export function classifyError(kind: string): TrialError {
	return { kind, policy: POLICIES[kind] ?? UNKNOWN };
}

/** Only errors with a valid reward contribute a measured zero to aggregates. */
export function isMeasuredError(error: TrialError | undefined): boolean {
	return error?.policy.hasValidReward === true;
}
