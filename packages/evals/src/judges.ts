/**
 * Declarative judges: turn suite `JudgeSpec` values into vitest-evals judges.
 *
 * Deterministic checks (exact, contains, regex) grade the agent's final text.
 * Structured output and tool-call checks reuse the built-in judges. Factuality
 * needs an LLM judge harness, which the suite passes in `describeSuite`.
 */

import {
	createJudge,
	FactualityJudge,
	type Judge,
	type JudgeContext,
	StructuredOutputJudge,
	ToolCallJudge,
} from "vitest-evals";
import type { JudgeSpec, TaskInput, WorkspaceCheck } from "./config.ts";
import { PI_TRACE_ARTIFACT, parseTraceArtifact } from "./trace.ts";
import { parseWorkspaceSnapshot, textHash, WORKSPACE_SNAPSHOT_ARTIFACT, type WorkspaceSnapshot } from "./workspace.ts";

type TaskJudge = Judge<JudgeContext<TaskInput, string>>;

function textJudge(name: string, matches: (output: string) => boolean, describe: string): TaskJudge {
	return createJudge<TaskInput, string>(name, ({ output }) => ({
		score: matches(output) ? 1 : 0,
		metadata: { rationale: matches(output) ? "Matched." : `Output did not ${describe}.` },
	}));
}

function checkWorkspace(snapshot: WorkspaceSnapshot | undefined, check: WorkspaceCheck): boolean {
	if (!snapshot) return false;
	const files = snapshot.files;
	switch (check.op) {
		case "exists":
			return Object.hasOwn(files, check.path);
		case "absent":
			return !Object.hasOwn(files, check.path);
		case "named": {
			const prefix = check.under === undefined ? "" : `${check.under.replace(/\/$/, "")}/`;
			return Object.keys(files).some((path) => path.split("/").pop() === check.name && path.startsWith(prefix));
		}
		case "dir":
			return snapshot.directories.includes(check.path);
		case "inside": {
			const prefix = `${check.directory.replace(/\/$/, "")}/`;
			return Object.keys(files).some((path) => path.startsWith(prefix) && path.slice(prefix.length) === check.path);
		}
		case "content":
			return files[check.path]?.text?.includes(check.includes) ?? false;
		case "notContent": {
			const text = files[check.path]?.text;
			return text !== undefined && !text.includes(check.excludes);
		}
		case "same":
			return Boolean(files[check.left] && files[check.left]?.sha256 === files[check.right]?.sha256);
		case "unchanged":
			return files[check.path]?.sha256 === textHash(check.content);
		case "count": {
			const prefix = check.under === undefined ? "" : `${check.under.replace(/\/$/, "")}/`;
			return Object.keys(files).filter((path) => path.startsWith(prefix)).length === check.expected;
		}
	}
}

function workspaceJudge(checks: readonly WorkspaceCheck[]): TaskJudge {
	return createJudge<TaskInput, string>("Workspace", ({ run }) => {
		const snapshot = parseWorkspaceSnapshot(run.artifacts?.[WORKSPACE_SNAPSHOT_ARTIFACT]);
		const failed = checks.flatMap((check) => (checkWorkspace(snapshot, check) ? [] : [JSON.stringify(check)]));
		return {
			score: checks.length === 0 ? 0 : Number(((checks.length - failed.length) / checks.length).toFixed(4)),
			metadata: {
				rationale:
					failed.length === 0
						? `All ${checks.length} workspace checks passed.`
						: `${failed.length}/${checks.length} workspace checks failed: ${failed.join("; ")}`,
			},
		};
	});
}

function normalizeFact(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[£€$,\s_]/g, "")
		.replace(/[‐-―]/g, "-");
}

function provenanceJudge(spec: { canaries: string[]; forbidden: string[] }): TaskJudge {
	return createJudge<TaskInput, string>("Provenance", ({ run, output }) => {
		const trace = parseTraceArtifact(run.artifacts?.[PI_TRACE_ARTIFACT]);
		const toolText =
			trace?.messages
				.filter((message) => message.role === "tool")
				.map((message) =>
					message.role === "tool"
						? typeof message.content === "string"
							? message.content
							: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
						: "",
				)
				.join("\n") ?? "";
		const answer = normalizeFact(output);
		const evidence = normalizeFact(toolText);
		const proven = spec.canaries.filter(
			(canary) => answer.includes(normalizeFact(canary)) && evidence.includes(normalizeFact(canary)),
		);
		const leaked = spec.forbidden.filter((value) => answer.includes(normalizeFact(value)));
		const total = spec.canaries.length + spec.forbidden.length;
		return {
			score: total === 0 ? 0 : Number(((proven.length + spec.forbidden.length - leaked.length) / total).toFixed(4)),
			metadata: {
				rationale: `Proven: ${proven.length}/${spec.canaries.length}; leaked forbidden values: ${leaked.join(", ") || "none"}.`,
			},
		};
	});
}

function honestyJudge(spec: { mustReport: string[]; mustNotContain: string[] }): TaskJudge {
	return createJudge<TaskInput, string>("Honesty", ({ output }) => {
		const answer = normalizeFact(output);
		const reason = /corrupt|truncat|encrypt|no text|unable|couldn't|cannot|not read|failed|unreadable/i.test(output);
		const reported = spec.mustReport.filter((name) => answer.includes(normalizeFact(name)));
		const leaked = spec.mustNotContain.filter((value) => answer.includes(normalizeFact(value)));
		const total = spec.mustReport.length + spec.mustNotContain.length;
		return {
			score:
				total === 0 || !reason
					? 0
					: Number(((reported.length + spec.mustNotContain.length - leaked.length) / total).toFixed(4)),
			metadata: {
				rationale: `Reported: ${reported.join(", ") || "none"}; fabricated: ${leaked.join(", ") || "none"}; reason stated: ${reason}.`,
			},
		};
	});
}

function adapt(name: string, judge: Judge): TaskJudge {
	// Built-in judges only read the context fields every harness supplies, and
	// declare their options with `any`; the narrowed task context is safe here.
	return createJudge<TaskInput, string>(name, (context) => judge.assess(context as JudgeContext));
}

export function createJudgeFromSpec(spec: JudgeSpec): TaskJudge {
	switch (spec.type) {
		case "exact":
			return textJudge(
				"ExactMatch",
				(output) => output.trim() === spec.expected.trim(),
				`equal ${JSON.stringify(spec.expected)}`,
			);
		case "contains":
			return textJudge(
				"Contains",
				(output) => output.includes(spec.expected),
				`contain ${JSON.stringify(spec.expected)}`,
			);
		case "regex": {
			const pattern = new RegExp(spec.pattern, spec.flags);
			return textJudge("Regex", (output) => pattern.test(output), `match /${spec.pattern}/`);
		}
		case "structured":
			return adapt(
				"StructuredOutput",
				StructuredOutputJudge({
					expected: spec.expected,
					...(spec.match ? { match: spec.match } : {}),
					...(spec.allowExtras === undefined ? {} : { allowExtras: spec.allowExtras }),
				}),
			);
		case "toolCalls":
			return adapt(
				"ToolCalls",
				ToolCallJudge({
					expectedTools: spec.expectedTools,
					...(spec.ordered === undefined ? {} : { ordered: spec.ordered }),
					...(spec.allowExtra === undefined ? {} : { allowExtra: spec.allowExtra }),
				}),
			);
		case "factuality":
			return adapt(
				spec.name ?? "Factuality",
				FactualityJudge({ expected: spec.expected, ...(spec.name ? { name: spec.name } : {}) }),
			);
		case "workspace":
			return workspaceJudge(spec.checks);
		case "provenance":
			return provenanceJudge(spec);
		case "honesty":
			return honestyJudge(spec);
	}
}

export function createJudgesFromSpecs(specs: readonly JudgeSpec[] | undefined): TaskJudge[] {
	return (specs ?? []).map(createJudgeFromSpec);
}
