import { describe, expect, it } from "vitest";
import { classifyError, isMeasuredError } from "../src/error-policy.ts";

describe("error policy", () => {
	it("distinguishes retry, grade and reward validity", () => {
		expect(classifyError("TimeoutError").policy).toEqual({
			shouldRetry: true,
			shouldGrade: false,
			hasValidReward: false,
		});
		expect(classifyError("ModelIdentityError").policy).toEqual({
			shouldRetry: false,
			shouldGrade: true,
			hasValidReward: false,
		});
		expect(classifyError("AgentTimeoutError").policy).toEqual({
			shouldRetry: false,
			shouldGrade: true,
			hasValidReward: true,
		});
	});

	it("treats only valid rewards as measured failures", () => {
		expect(isMeasuredError(classifyError("AgentTimeoutError"))).toBe(true);
		expect(isMeasuredError(classifyError("TimeoutError"))).toBe(false);
		expect(isMeasuredError(undefined)).toBe(false);
	});

	it("defaults unknown kinds to retryable and gradeable", () => {
		expect(classifyError("SomethingNew").policy).toEqual({
			shouldRetry: true,
			shouldGrade: true,
			hasValidReward: true,
		});
	});
});
