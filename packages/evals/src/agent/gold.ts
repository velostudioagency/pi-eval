/**
 * Deterministic canonical-action models and the gold/Null gate. The gate runs
 * verification on a known-good run (must pass) and on a run that refuses to
 * act (must fail) before any real model is used.
 */

import { readFileSync } from "node:fs";
import type { AgentTask } from "./task.ts";
import {
	type AgentAction,
	readVerificationChecks,
	runVerification,
	type VerificationCheck,
	VerificationContext,
	type VerificationResult,
} from "./verify.ts";

/** Final text of the model that refuses to act. */
export const NULL_FINAL_TEXT = "I don't know how to proceed.";

/** A canonical action as stored in solution/gold.json. */
export type GoldAction = { tool: string; args: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectArray(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		if (!isObject(item)) return undefined;
	}
	return value as Record<string, unknown>[];
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Refuses to act; the verifier must reject this run. */
export class NullModel {
	readonly actions: AgentAction[] = [];
	readonly finalText: string = NULL_FINAL_TEXT;
}

/** Turns the canonical actions in a solution into an action log and final text. */
export class GoldModel {
	readonly actions: AgentAction[];
	readonly finalText: string;

	constructor(actions: GoldAction[], final: string = "Done.") {
		this.actions = actions.map(({ tool, args }) => ({ name: tool, args }));
		this.finalText = final;
	}
}

/** Reads solution/gold.json, returning canonical actions and final text. */
export function loadSolution(path: string): { actions: GoldAction[]; final: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`invalid solution JSON: ${path}`);
	}
	if (!isObject(parsed)) {
		throw new Error(`gold solution must be a JSON object: ${path}`);
	}
	const rawActions = objectArray(parsed.actions);
	if (!rawActions) {
		throw new Error(`gold solution actions must be a list of objects: ${path}`);
	}
	const actions = rawActions.map((action) => {
		if (typeof action.tool !== "string" || !action.tool.trim()) {
			throw new Error(`gold action is missing a tool name: ${path}`);
		}
		const args = isObject(action.args) ? action.args : {};
		return { tool: action.tool, args };
	});
	const final = typeof parsed.final === "string" ? parsed.final : "Done.";
	return { actions, final };
}

/** Structured evidence for a gold-gate decision. */
export type TaskValidationDetails = {
	gold: VerificationResult;
	null: VerificationResult;
	summary: string;
};

/** Result of the gold/Null gate for one task. */
export type TaskValidation = {
	ok: boolean;
	goldOk: boolean;
	nullRejected: boolean;
	details: TaskValidationDetails;
};

/** Proves the verifier accepts the canonical run and rejects a run that does nothing. */
export function validateTask(task: AgentTask): TaskValidation {
	let checks: VerificationCheck[];
	let solution: { actions: GoldAction[]; final: string };
	try {
		checks = readVerificationChecks(task.verifyPath);
		solution = loadSolution(task.solutionPath);
	} catch (err) {
		const summary = `cannot validate task ${task.id}: ${errorMessage(err)}`;
		const failed: VerificationResult = { ok: false, checks: [], error: summary };
		return { ok: false, goldOk: false, nullRejected: false, details: { gold: failed, null: failed, summary } };
	}
	const goldModel = new GoldModel(solution.actions, solution.final);
	const gold = runVerification(
		task.repoDir,
		checks,
		new VerificationContext(task.repoDir, goldModel.actions, goldModel.finalText, [], task.id),
	);
	const nullModel = new NullModel();
	const nullResult = runVerification(
		task.repoDir,
		checks,
		new VerificationContext(task.repoDir, nullModel.actions, nullModel.finalText, [], task.id),
	);
	const goldOk = gold.ok;
	const nullRejected = !nullResult.ok;
	return {
		ok: goldOk && nullRejected,
		goldOk,
		nullRejected,
		details: {
			gold,
			null: nullResult,
			summary: `gold ${goldOk ? "passed" : "failed"}; null ${nullRejected ? "rejected" : "accepted"}`,
		},
	};
}
