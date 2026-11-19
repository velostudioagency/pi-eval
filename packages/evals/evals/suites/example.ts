/**
 * A minimal declarative suite: the template for new task-based experiments.
 *
 * It shows both task shapes and both grader kinds. Add the suite to
 * `evals/suites/index.ts`, then run it with `--suite example`.
 */

import type { SuiteSpec } from "../../src/config.ts";

export const exampleSuite: SuiteSpec = {
	id: "example",
	runs: 1,
	families: [
		{ id: "knowledge", description: "Factual recall without tools." },
		{ id: "workspace", description: "File and shell interaction." },
	],
	tasks: [
		{
			id: "answers-a-fact",
			evalSet: "smoke",
			family: "knowledge",
			input: "What is the capital of France? Answer with only the city name.",
			judges: [{ type: "exact", expected: "Paris" }],
		},
		{
			id: "reads-the-workspace",
			evalSet: "smoke",
			family: "workspace",
			input: "Read notes.txt and reply with its single line of text, verbatim.",
			workspaceFiles: { "notes.txt": "eval harness smoke test" },
			judges: [
				{ type: "exact", expected: "eval harness smoke test" },
				{ type: "toolCalls", expectedTools: ["read"] },
			],
		},
	],
	profiles: [
		{
			id: "default",
			description: "Stock Pi prompt with the default tool set.",
			systemPrompt: { kind: "pi-default" },
		},
		{
			id: "no-tools",
			description: "Stock Pi prompt with tools disabled.",
			systemPrompt: { kind: "pi-default" },
			tools: { noTools: "all" },
		},
	],
	exports: [
		{ format: "messages" },
		{ format: "sharegpt", file: "dataset.sharegpt.jsonl" },
		{ format: "rendered", template: "chatml", file: "dataset.chatml.jsonl" },
	],
};
