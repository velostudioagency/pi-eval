/**
 * Declarative judges: turn suite `JudgeSpec` values into vitest-evals judges.
 *
 * Deterministic checks delegate to `judge-logic.ts` so the same scoring code
 * runs in the harness and during offline rescoring. Structured output and
 * tool-call checks reuse the built-in judges. Factuality needs an LLM judge
 * harness, which the suite passes in `describeSuite`.
 */

import {
	createJudge,
	FactualityJudge,
	type Judge,
	type JudgeContext,
	type JudgeResult,
	StructuredOutputJudge,
	ToolCallJudge,
} from "vitest-evals";
import type { JudgeSpec, TaskInput } from "./config.ts";
import { assessSpec } from "./judge-logic.ts";

type TaskJudge = Judge<JudgeContext<TaskInput, string>>;

function pureJudge(name: string, spec: JudgeSpec): TaskJudge {
	return createJudge<TaskInput, string>(name, (context) => {
		const result = assessSpec(spec, { output: context.output, artifacts: context.run?.artifacts });
		return { score: result.score, metadata: result.metadata as JudgeResult["metadata"] };
	});
}

function adapt(name: string, judge: Judge): TaskJudge {
	// Built-in judges only read the context fields every harness supplies, and
	// declare their options with `any`; the narrowed task context is safe here.
	return createJudge<TaskInput, string>(name, (context) => judge.assess(context as JudgeContext));
}

export function createJudgeFromSpec(spec: JudgeSpec): TaskJudge {
	switch (spec.type) {
		case "grounded":
			return pureJudge(spec.name ?? "Grounded", spec);
		case "exact":
			return pureJudge("ExactMatch", spec);
		case "contains":
			return pureJudge("Contains", spec);
		case "regex":
			return pureJudge("Regex", spec);
		case "workspace":
			return pureJudge("Workspace", spec);
		case "provenance":
			return pureJudge("Provenance", spec);
		case "honesty":
			return pureJudge("Honesty", spec);
		case "manifest":
			return pureJudge(`Manifest(${spec.taskId})`, spec);
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
	}
}

export function createJudgesFromSpecs(specs: readonly JudgeSpec[] | undefined): TaskJudge[] {
	return (specs ?? []).map(createJudgeFromSpec);
}
