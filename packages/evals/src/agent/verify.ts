/**
 * Declarative verification for agent-eval runs. Checks are read from a
 * task's verify.json and evaluated against a workspace plus the action log
 * and final answer produced by a run.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { PathEscapeError, resolveWorkspacePath } from "./task.ts";

/** One recorded tool call: the tool name plus its arguments. */
export type AgentAction = { name: string; args: Record<string, unknown> };

/** Raised for an unknown or malformed check specification. */
export class CheckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CheckError";
	}
}

/** The facts a check may inspect after a run. */
export class VerificationContext {
	readonly workspace: string;
	readonly actions: AgentAction[];
	readonly finalText: string;
	readonly skillsLoaded: string[];
	readonly taskId: string;

	constructor(workspace: string, actions: AgentAction[], finalText: string, skillsLoaded: string[], taskId: string) {
		this.workspace = resolve(workspace);
		this.actions = actions;
		this.finalText = finalText;
		this.skillsLoaded = skillsLoaded;
		this.taskId = taskId;
	}

	/** Resolves a relative path inside the workspace, rejecting escapes. */
	resolve(relativePath: string): string {
		return resolveWorkspacePath(this.workspace, relativePath);
	}
}

/** A single declarative assertion. */
export type VerificationCheck =
	| { type: "file_exists"; path: string }
	| { type: "file_absent"; path: string }
	| { type: "file_contains"; path: string; text: string }
	| { type: "file_not_contains"; path: string; text: string }
	| { type: "file_unchanged"; path: string; sha256: string }
	| { type: "command_exit_zero"; command: string; timeout?: number }
	| { type: "command_output_matches"; command: string; pattern: string; flags?: string; timeout?: number }
	| { type: "action_used"; name: string }
	| { type: "action_not_used"; name: string }
	| { type: "max_actions"; max: number }
	| { type: "canary_present"; canary: string }
	| { type: "final_contains"; text: string };

/** Outcome of one check. */
export type CheckResult = { type: string; ok: boolean; detail: string };

/** Outcome of a whole verification. `error` is set only when checks cannot run. */
export type VerificationResult = { ok: boolean; checks: CheckResult[]; error?: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clip(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

function safeUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

/** Replaces host-specific paths, users, and hostnames with synthetic values. */
export function scrubHostValues(text: string): string {
	if (!text) return text;
	const pairs: Array<[string, string]> = [];
	const add = (value: string, replacement: string): void => {
		if (!value || value.length < 3) return;
		for (const variant of new Set([value, value.replace(/\\/g, "/")])) {
			if (variant && variant !== "/" && variant !== "\\") pairs.push([variant, replacement]);
		}
	};
	add(homedir(), "/home/dev");
	add(process.env.USERPROFILE ?? "", "/home/dev");
	add(process.env.HOME ?? "", "/home/dev");
	add(process.env.TMPDIR ?? "", "/tmp");
	add(tmpdir(), "/tmp");
	add(safeUser(), "dev");
	add(safeHostname(), "sandbox");
	pairs.sort((a, b) => b[0].length - a[0].length);
	let out = text;
	for (const [needle, replacement] of pairs) {
		out = out.split(needle).join(replacement);
	}
	return out;
}

function safeHostname(): string {
	try {
		return hostname();
	} catch {
		return "";
	}
}

function stringField(raw: Record<string, unknown>, key: string): string {
	const value = raw[key];
	if (typeof value !== "string") {
		throw new CheckError(`check requires a string '${key}'`);
	}
	return value;
}

function pathField(raw: Record<string, unknown>): string {
	const value = stringField(raw, "path");
	if (!value.trim()) throw new CheckError("check requires a non-empty 'path'");
	return value;
}

function numberField(raw: Record<string, unknown>, key: string): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new CheckError(`check requires a numeric '${key}'`);
	}
	return value;
}

function optionalStringField(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" ? value : undefined;
}

/** Parses one check from verify.json, validating fields at the config boundary. */
function parseCheck(raw: unknown): VerificationCheck {
	if (!isObject(raw)) throw new CheckError("each check must be a JSON object");
	switch (raw.type) {
		case "file_exists":
			return { type: "file_exists", path: pathField(raw) };
		case "file_absent":
			return { type: "file_absent", path: pathField(raw) };
		case "file_contains":
			return { type: "file_contains", path: pathField(raw), text: stringField(raw, "text") };
		case "file_not_contains":
			return { type: "file_not_contains", path: pathField(raw), text: stringField(raw, "text") };
		case "file_unchanged":
			return { type: "file_unchanged", path: pathField(raw), sha256: stringField(raw, "sha256") };
		case "command_exit_zero":
			return {
				type: "command_exit_zero",
				command: stringField(raw, "command"),
				timeout: raw.timeout === undefined ? undefined : numberField(raw, "timeout"),
			};
		case "command_output_matches":
			return {
				type: "command_output_matches",
				command: stringField(raw, "command"),
				pattern: stringField(raw, "pattern"),
				flags: optionalStringField(raw, "flags"),
				timeout: raw.timeout === undefined ? undefined : numberField(raw, "timeout"),
			};
		case "action_used":
			return { type: "action_used", name: stringField(raw, "name") };
		case "action_not_used":
			return { type: "action_not_used", name: stringField(raw, "name") };
		case "max_actions":
			return { type: "max_actions", max: numberField(raw, "max") };
		case "canary_present":
			return { type: "canary_present", canary: stringField(raw, "canary") };
		case "final_contains":
			return { type: "final_contains", text: stringField(raw, "text") };
		default:
			throw new CheckError(`unknown check type: ${JSON.stringify(raw.type)}`);
	}
}

/** Reads verify.json as either a check array or an object with a `checks` array. */
export function readVerificationChecks(path: string): VerificationCheck[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new CheckError(`cannot read verification config: ${path}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new CheckError(`invalid verification JSON: ${path}`);
	}
	const rawChecks = isArray(parsed) ? parsed : isObject(parsed) && isArray(parsed.checks) ? parsed.checks : undefined;
	if (!rawChecks) {
		throw new CheckError("verification config must be a check array or an object with a 'checks' array");
	}
	return rawChecks.map(parseCheck);
}

type CommandOutcome = { code: number; stdout: string; stderr: string; error?: string };

function runCommand(command: string, cwd: string, timeout: number): CommandOutcome {
	// verify.json stores the timeout in seconds (as in agent-eval); spawnSync takes ms.
	const result = spawnSync(command, { shell: true, cwd, encoding: "utf8", timeout: timeout * 1000 });
	return {
		code: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error ? { error: result.error.message } : {}),
	};
}

function regexFlags(flags: string | undefined): string {
	const wanted = new Set(["m", ...(flags ?? "").split("")]);
	return [...wanted].filter((flag) => "imsu".includes(flag)).join("");
}

function listWorkspaceFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && statSync(full).size <= 1024 * 1024) {
				files.push(full);
			}
		}
	};
	walk(root);
	return files;
}

function runCheck(ctx: VerificationContext, check: VerificationCheck): CheckResult {
	switch (check.type) {
		case "file_exists": {
			const target = ctx.resolve(check.path);
			let ok = false;
			try {
				ok = statSync(target).isFile();
			} catch {
				ok = false;
			}
			return { type: check.type, ok, detail: scrubHostValues(check.path) };
		}
		case "file_absent": {
			const target = ctx.resolve(check.path);
			let ok = false;
			try {
				statSync(target);
			} catch {
				ok = true;
			}
			return { type: check.type, ok, detail: scrubHostValues(check.path) };
		}
		case "file_contains": {
			const target = ctx.resolve(check.path);
			let content: string;
			try {
				content = readFileSync(target, "utf8");
			} catch (err) {
				return { type: check.type, ok: false, detail: scrubHostValues(`${check.path}: ${errorMessage(err)}`) };
			}
			const ok = content.includes(check.text);
			return {
				type: check.type,
				ok,
				detail: scrubHostValues(
					ok
						? `${check.path} contains ${JSON.stringify(check.text)}`
						: `missing ${JSON.stringify(check.text)} in ${check.path}`,
				),
			};
		}
		case "file_not_contains": {
			const target = ctx.resolve(check.path);
			let content: string;
			try {
				content = readFileSync(target, "utf8");
			} catch (err) {
				return { type: check.type, ok: false, detail: scrubHostValues(`${check.path}: ${errorMessage(err)}`) };
			}
			const ok = !content.includes(check.text);
			return {
				type: check.type,
				ok,
				detail: scrubHostValues(
					ok
						? `${check.path} has no ${JSON.stringify(check.text)}`
						: `found ${JSON.stringify(check.text)} in ${check.path}`,
				),
			};
		}
		case "file_unchanged": {
			const target = ctx.resolve(check.path);
			let content: Buffer;
			try {
				content = readFileSync(target);
			} catch (err) {
				return { type: check.type, ok: false, detail: scrubHostValues(`${check.path}: ${errorMessage(err)}`) };
			}
			const digest = createHash("sha256").update(content).digest("hex");
			const ok = digest.toLowerCase() === check.sha256.toLowerCase();
			return { type: check.type, ok, detail: scrubHostValues(`${check.path} sha256 ${digest}`) };
		}
		case "command_exit_zero": {
			const outcome = runCommand(check.command, ctx.workspace, check.timeout ?? 60);
			const detail = clip(scrubHostValues(outcome.error ?? (outcome.stdout || outcome.stderr)));
			return {
				type: check.type,
				ok: outcome.error === undefined && outcome.code === 0,
				detail: scrubHostValues(`exit=${outcome.code} ${detail}`.trim()),
			};
		}
		case "command_output_matches": {
			const outcome = runCommand(check.command, ctx.workspace, check.timeout ?? 60);
			let matcher: RegExp;
			try {
				matcher = new RegExp(check.pattern, regexFlags(check.flags));
			} catch (err) {
				throw new CheckError(`invalid regex ${JSON.stringify(check.pattern)}: ${errorMessage(err)}`);
			}
			const output = `${outcome.stdout}\n${outcome.stderr}`;
			const ok = matcher.test(output);
			const detail = clip(scrubHostValues(output));
			return {
				type: check.type,
				ok,
				detail: `pattern ${JSON.stringify(check.pattern)} ${ok ? "found" : "not found"} in output: ${detail}`,
			};
		}
		case "action_used": {
			const ok = ctx.actions.some((action) => action.name === check.name);
			return { type: check.type, ok, detail: scrubHostValues(`action ${check.name} ${ok ? "used" : "not used"}`) };
		}
		case "action_not_used": {
			const ok = !ctx.actions.some((action) => action.name === check.name);
			return { type: check.type, ok, detail: scrubHostValues(`action ${check.name} ${ok ? "not used" : "used"}`) };
		}
		case "max_actions": {
			const ok = ctx.actions.length <= check.max;
			return { type: check.type, ok, detail: `actions=${ctx.actions.length} max=${check.max}` };
		}
		case "canary_present": {
			const haystacks = [{ label: "final answer", text: ctx.finalText }];
			for (const file of listWorkspaceFiles(ctx.workspace)) {
				haystacks.push({ label: relative(ctx.workspace, file), text: readFileSync(file, "utf8") });
			}
			const hit = haystacks.find((entry) => entry.text.includes(check.canary));
			return {
				type: check.type,
				ok: hit !== undefined,
				detail: hit ? `canary found in ${scrubHostValues(hit.label)}` : "canary not found",
			};
		}
		case "final_contains": {
			const ok = ctx.finalText.includes(check.text);
			return {
				type: check.type,
				ok,
				detail: scrubHostValues(
					ok ? `final contains ${JSON.stringify(check.text)}` : `missing ${JSON.stringify(check.text)} in final`,
				),
			};
		}
	}
}

/** Runs every check and aggregates the result; a failure to run fails the whole gate. */
export function runVerification(
	workspace: string,
	checks: VerificationCheck[],
	context: VerificationContext,
): VerificationResult {
	const ctx = new VerificationContext(
		workspace,
		context.actions,
		context.finalText,
		context.skillsLoaded,
		context.taskId,
	);
	const results: CheckResult[] = [];
	try {
		for (const check of checks) {
			results.push(runCheck(ctx, check));
		}
	} catch (err) {
		const message =
			err instanceof PathEscapeError || err instanceof CheckError
				? err.message
				: `verification failed: ${errorMessage(err)}`;
		return { ok: false, checks: [], error: scrubHostValues(message) };
	}
	return { ok: results.every((result) => result.ok), checks: results };
}
