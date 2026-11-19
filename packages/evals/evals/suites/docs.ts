/**
 * The documentation-lift suite: the original Pi experiment expressed as two
 * profiles that differ only in whether the coding-agent documentation ships.
 */

import { DOCUMENTATION_EVAL_TOOLS, type SuiteSpec } from "../../src/config.ts";

export const docsSuite: SuiteSpec = {
	id: "docs",
	evalFiles: [
		"evals/custom-provider.docs.eval.ts",
		"evals/extensions.docs.eval.ts",
		"evals/models.docs.eval.ts",
		"evals/openai-provider.docs.eval.ts",
		"evals/prompt-templates.docs.eval.ts",
		"evals/tui.docs.eval.ts",
	],
	comparison: { control: "without_docs", treatment: "with_docs" },
	environments: [
		{ id: "pi-repo-no-docs", includeDocs: false },
		{ id: "pi-repo-docs", includeDocs: true },
	],
	profiles: [
		{
			id: "without_docs",
			description: "Repository runtime without Pi documentation.",
			systemPrompt: { kind: "pi-default-minus-docs" },
			environment: "pi-repo-no-docs",
			tools: { tools: [...DOCUMENTATION_EVAL_TOOLS] },
		},
		{
			id: "with_docs",
			description: "Repository runtime with Pi documentation.",
			systemPrompt: { kind: "pi-default" },
			environment: "pi-repo-docs",
			tools: { tools: [...DOCUMENTATION_EVAL_TOOLS] },
		},
	],
};
