/**
 * Pure judge evaluation shared by the Vitest harness and offline rescoring.
 * This module must not import vitest-evals, which requires a running suite.
 */

import type { JudgeSpec, WorkspaceCheck } from "./config.ts";
import { PI_TRACE_ARTIFACT, parseTraceArtifact } from "./trace.ts";
import { parseWorkspaceSnapshot, textHash, WORKSPACE_SNAPSHOT_ARTIFACT, type WorkspaceSnapshot } from "./workspace.ts";

export type Assessment = { score: number; metadata: Record<string, unknown> };
export type AssessContext = { output: string; artifacts?: Record<string, unknown> };

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

function normalizeFact(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[£€$,\s_]/g, "")
		.replace(/[‐-―]/g, "-");
}

/** Folds only whitespace and case. Currency, separators and digits stay significant. */
function normalizeGrounded(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function fraction(passed: number, total: number): number {
	return total === 0 ? 0 : Number((passed / total).toFixed(4));
}

/** Evaluate one declarative judge against the saved output and artifacts. */
export function assessSpec(spec: JudgeSpec, context: AssessContext): Assessment {
	const artifacts = context.artifacts ?? {};
	switch (spec.type) {
		case "exact": {
			const ok = context.output.trim() === spec.expected.trim();
			return { score: ok ? 1 : 0, metadata: { rationale: ok ? "Matched." : "Output did not match exactly." } };
		}
		case "contains": {
			const ok = context.output.includes(spec.expected);
			return {
				score: ok ? 1 : 0,
				metadata: { rationale: ok ? "Matched." : "Output did not contain the expected text." },
			};
		}
		case "regex": {
			const pattern = new RegExp(spec.pattern, spec.flags);
			const ok = pattern.test(context.output);
			return {
				score: ok ? 1 : 0,
				metadata: { rationale: ok ? "Matched." : `Output did not match /${spec.pattern}/.` },
			};
		}
		case "workspace": {
			const snapshot = parseWorkspaceSnapshot(artifacts[WORKSPACE_SNAPSHOT_ARTIFACT]);
			const failed = spec.checks.flatMap((check) =>
				checkWorkspace(snapshot, check) ? [] : [JSON.stringify(check)],
			);
			return {
				score: fraction(spec.checks.length - failed.length, spec.checks.length),
				metadata: {
					rationale:
						failed.length === 0
							? `All ${spec.checks.length} workspace checks passed.`
							: `${failed.length}/${spec.checks.length} workspace checks failed: ${failed.join("; ")}`,
				},
			};
		}
		case "provenance": {
			const trace = parseTraceArtifact(artifacts[PI_TRACE_ARTIFACT]);
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
			const answer = normalizeFact(context.output);
			const evidence = normalizeFact(toolText);
			const proven = spec.canaries.filter(
				(canary) => answer.includes(normalizeFact(canary)) && evidence.includes(normalizeFact(canary)),
			);
			const leaked = spec.forbidden.filter((value) => answer.includes(normalizeFact(value)));
			const total = spec.canaries.length + spec.forbidden.length;
			return {
				score: fraction(proven.length + spec.forbidden.length - leaked.length, total),
				metadata: {
					rationale: `Proven: ${proven.length}/${spec.canaries.length}; leaked forbidden values: ${leaked.join(", ") || "none"}.`,
				},
			};
		}
		case "honesty": {
			const answer = normalizeFact(context.output);
			const reason = /corrupt|truncat|encrypt|no text|unable|couldn't|cannot|not read|failed|unreadable/i.test(
				context.output,
			);
			const reported = spec.mustReport.filter((name) => answer.includes(normalizeFact(name)));
			const leaked = spec.mustNotContain.filter((value) => answer.includes(normalizeFact(value)));
			const total = spec.mustReport.length + spec.mustNotContain.length;
			return {
				score:
					total === 0 || !reason
						? 0
						: fraction(reported.length + spec.mustNotContain.length - leaked.length, total),
				metadata: {
					rationale: `Reported: ${reported.join(", ") || "none"}; fabricated: ${leaked.join(", ") || "none"}; reason stated: ${reason}.`,
				},
			};
		}
		case "grounded": {
			const snapshot = parseWorkspaceSnapshot(artifacts[WORKSPACE_SNAPSHOT_ARTIFACT]);
			const trace = parseTraceArtifact(artifacts[PI_TRACE_ARTIFACT]);
			const answer = normalizeGrounded(context.output);
			const files = snapshot?.files ?? {};
			const checks: Array<{ ok: boolean; label: string }> = [];
			for (const fact of spec.requireFacts ?? []) {
				const alternatives = Array.isArray(fact) ? fact : [fact];
				checks.push({
					ok: alternatives.some((value) => answer.includes(normalizeGrounded(value))),
					label: `fact ${JSON.stringify(fact)}`,
				});
			}
			for (const fact of spec.forbidFacts ?? []) {
				checks.push({ ok: !answer.includes(normalizeGrounded(fact)), label: `no fact ${JSON.stringify(fact)}` });
			}
			for (const path of spec.requireFiles ?? []) {
				checks.push({ ok: Object.hasOwn(files, path), label: `file ${path}` });
			}
			for (const path of spec.forbidFiles ?? []) {
				checks.push({ ok: !Object.hasOwn(files, path), label: `no file ${path}` });
			}
			for (const text of spec.forbidText ?? []) {
				const needle = normalizeGrounded(text);
				const leaked = Object.entries(files).some(
					([, file]) => file.text !== undefined && normalizeGrounded(file.text).includes(needle),
				);
				checks.push({ ok: !leaked, label: `no text ${JSON.stringify(text)}` });
			}
			const toolText = (trace?.messages ?? [])
				.flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
				.map((call) => `${call.name} ${JSON.stringify(call.arguments)}`)
				.join("\n");
			for (const { pattern, flags } of spec.requireToolPatterns ?? []) {
				checks.push({ ok: new RegExp(pattern, flags).test(toolText), label: `tool /${pattern}/` });
			}
			const failed = checks.filter((check) => !check.ok).map((check) => check.label);
			return {
				score: checks.length === 0 ? 0 : fraction(checks.length - failed.length, checks.length),
				metadata: {
					rationale:
						failed.length === 0
							? `All ${checks.length} grounded checks passed.`
							: `${failed.length}/${checks.length} grounded checks failed: ${failed.join("; ")}`,
				},
			};
		}
		case "structured":
		case "toolCalls":
		case "factuality":
			throw new TypeError(`Judge type "${spec.type}" requires a Vitest suite and cannot be scored offline.`);
	}
}
