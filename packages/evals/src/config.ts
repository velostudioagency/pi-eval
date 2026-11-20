/**
 * Declarative eval suite configuration: environments, profiles, tasks, judges,
 * and dataset exports.
 *
 * A suite is the unit the runner executes: a set of profiles (system prompt,
 * tools, environment, model settings) crossed with a set of tasks, repeated a
 * number of times per task. The same suite also declares how finished runs
 * are exported as fine-tuning datasets.
 */

import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "vitest-evals";

/** One prompt step, or a reload between steps, sent to the agent. */
export type TaskInput = string | Array<{ type: "prompt"; content: string } | { type: "reload" }>;

export type SystemPromptSpec =
	| { kind: "pi-default" }
	| { kind: "pi-default-minus-docs" }
	| { kind: "literal"; text: string }
	| { kind: "transform"; id: string; transform: (defaultPrompt: string) => string };

/** Tool selection and custom tool definitions passed through to the agent session. */
export type ToolSpec = Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools"> & {
	customTools?: ToolDefinition[];
	/** "inspect" appends Inspect-compatible `python`/`text_editor` tools to the session. */
	style?: "pi" | "inspect";
};

/** OS an environment claims. Docker backends only support "linux". */
export type HostOs = "linux" | "windows" | "macos";

/** Where the agent process runs. */
export type RuntimeBackend = "docker" | "host" | "remote" | "local";

/**
 * Where the agent runs. The Docker runner turns each distinct environment into
 * one image; tasks then run in a fresh container from that image.
 */
export type EnvironmentSpec = {
	id: string;
	/** Container base image. Defaults to the image the Pi repository runtime is built for. */
	baseImage?: string;
	/** Ship Pi's documentation in the image. Defaults to true. */
	includeDocs?: boolean;
	/** OS the environment claims. Defaults to "linux". */
	os?: HostOs;
	/** Execution backend. Defaults to "docker". */
	backend?: RuntimeBackend;
	/** Runner URL when `backend` is "remote". */
	runner?: string;
	/** Tool availability tier. "standard" preflights extraction utilities. */
	toolTier?: "standard" | "minimal";
	/** Files seeded into an empty agent workspace before the task runs. */
	workspaceFiles?: Readonly<Record<string, string>>;
};

/** One configuration arm of the experiment: prompt, tools, environment, model settings. */
export type Profile = {
	id: string;
	description?: string;
	/** Default: the stock Pi system prompt. */
	systemPrompt?: SystemPromptSpec;
	tools?: ToolSpec;
	/** Environment id from the suite's `environments`, or an inline environment. */
	environment?: string | EnvironmentSpec;
	/** Default: "off", so runs are deterministic unless a profile asks otherwise. */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
};

/** Documentation evals intentionally exclude shell and unrestricted network tools. */
export const DOCUMENTATION_EVAL_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

/**
 * Deterministic checks against facts derived from the task's fixtures. Unlike
 * substring judges, fact strings are matched literally (whitespace folded but
 * currency, separators and case preserved), so a byte count cannot pass as an
 * invoice amount.
 */
export type GroundedJudgeSpec = {
	type: "grounded";
	name?: string;
	/** Literal strings that must appear in the final answer. An inner array means any one of them. */
	requireFacts?: Array<string | string[]>;
	/** Literal strings that must not appear in the final answer. */
	forbidFacts?: string[];
	/** Workspace files that must exist after the run. */
	requireFiles?: string[];
	/** Workspace files that must not exist after the run, for example a copied draft. */
	forbidFiles?: string[];
	/** Literal strings that must not appear in any generated workspace text file. */
	forbidText?: string[];
	/** Patterns that must match a serialized tool call, for example an after-write listing. */
	requireToolPatterns?: Array<{ pattern: string; flags?: string }>;
};

export type JudgeSpec =
	| GroundedJudgeSpec
	| { type: "exact"; expected: string }
	| { type: "contains"; expected: string }
	| { type: "regex"; pattern: string; flags?: string }
	| { type: "structured"; expected: Record<string, unknown>; match?: "strict" | "fuzzy"; allowExtras?: boolean }
	| {
			type: "toolCalls";
			expectedTools: Array<string | { name: string; arguments?: unknown }>;
			ordered?: boolean;
			allowExtra?: boolean;
	  }
	| {
			type: "workspace";
			checks: WorkspaceCheck[];
	  }
	| { type: "provenance"; canaries: string[]; forbidden: string[] }
	| { type: "honesty"; mustReport: string[]; mustNotContain: string[] }
	| { type: "factuality"; expected: JsonValue; name?: string }
	| { type: "manifest"; taskId: string };

/** One eval case: a user message (or multi-step input) plus how to grade it. */
export type TaskSpec = {
	/** Case name inside the eval set. Becomes the Vitest case name. */
	id: string;
	/** Group name. Becomes the Vitest describe name. */
	evalSet: string;
	/** Capability family this task belongs to, for filtering and roll-ups. */
	family?: string;
	/** Root domain that owns the family, for higher-level roll-ups. */
	domain?: string;
	input: TaskInput;
	/** Task files merged over the environment's workspace files. */
	workspaceFiles?: Readonly<Record<string, string>>;
	/** Binary files copied from disk: destination path -> source path relative to the package. */
	workspaceAssets?: Readonly<Record<string, string>>;
	judges?: JudgeSpec[];
	/** Default: null, so a low score is recorded as data instead of failing the run. */
	judgeThreshold?: number | null;
	/** Free-form task metadata, e.g. the manifest's packageMode. */
	metadata?: Record<string, unknown>;
};

/** One deterministic assertion about the workspace tree after a run. */
export type WorkspaceCheck =
	| { op: "exists"; path: string }
	| { op: "absent"; path: string }
	| { op: "named"; name: string; under?: string }
	| { op: "dir"; path: string }
	| { op: "inside"; path: string; directory: string }
	| { op: "content"; path: string; includes: string }
	| { op: "notContent"; path: string; excludes: string }
	| { op: "same"; left: string; right: string }
	| { op: "unchanged"; path: string; content: string }
	| { op: "count"; expected: number; under?: string };

export type DatasetFormat = "messages" | "sharegpt" | "alpaca" | "rendered" | "atif";

/**
 * Model-family chat template used by the "rendered" dataset format.
 *
 * Each wrapper is a string with a `{content}` placeholder. `turnEnd` is
 * appended after every turn, `bos` before the first, `eos` after the last.
 */
export type ChatTemplateSpec = {
	id: string;
	bos?: string;
	eos?: string;
	system?: string;
	user?: string;
	assistant?: string;
	tool?: string;
	/** Appended after every turn, for example `<|im_end|>\n`. */
	turnEnd?: string;
	/** Rendered per tool call inside an assistant turn. Placeholders: `{name}`, `{arguments}`. */
	toolCall?: string;
	/** Joins multiple tool calls inside one assistant turn. Default: "\n". */
	toolCallSeparator?: string;
};

export type ExportSpec = {
	format: DatasetFormat;
	/** Output file relative to the run artifact directory. Default: `dataset.<format>.jsonl`. */
	file?: string;
	/** Keep run metadata on each record. Default: false, so files are training-ready as-is. */
	includeMetadata?: boolean;
	/** Emit assistant reasoning as `reasoning_content` (DeepSeek/Qwen style). Default: false. */
	includeReasoning?: boolean;
	/** Template for the "rendered" format. Default: "chatml". */
	template?: string | ChatTemplateSpec;
	/** Drop runs that produced no score. Default: true. */
	onlyScored?: boolean;
};

/** Pairs two profiles into pass-rate lift. */
export type SuiteComparison = { control: string; treatment: string };

export type SuiteSpec = {
	id: string;
	/** Code eval files (package-relative) whose discovered cases run under each profile. */
	evalFiles?: string[];
	/** Vitest project that owns those files. Default: "docs". */
	project?: string;
	/** Declarative tasks, run through `evals/suite.eval.ts`. */
	tasks?: TaskSpec[];
	/** Declared capability families; tasks may reference these by id. */
	families?: Array<{ id: string; description?: string; domain?: string }>;
	/** Root domains that group families. */
	domains?: Array<{ id: string; description?: string }>;
	profiles: Profile[];
	environments?: EnvironmentSpec[];
	comparison?: SuiteComparison;
	/** Repetitions per (case, profile, model). Default: 1. */
	runs?: number;
	exports?: ExportSpec[];
};

const CHAT_TEMPLATES: Record<string, ChatTemplateSpec> = {
	// Qwen, Yi, and other ChatML models.
	chatml: {
		id: "chatml",
		system: "<|im_start|>system\n{content}<|im_end|>\n",
		user: "<|im_start|>user\n{content}<|im_end|>\n",
		assistant: "<|im_start|>assistant\n{content}<|im_end|>\n",
		tool: "<|im_start|>tool\n<tool_response>\n{content}\n</tool_response><|im_end|>\n",
		toolCall: '<tool_call>\n{{"name":"{name}","arguments":{arguments}}}\n</tool_call>',
	},
	// Nous Hermes and other <|role|> models.
	hermes: {
		id: "hermes",
		bos: "<|begin_of_text|>",
		system: "<|im_start|>system\n{content}<|im_end|>\n",
		user: "<|im_start|>user\n{content}<|im_end|>\n",
		assistant: "<|im_start|>assistant\n{content}<|im_end|>\n",
		tool: "<|im_start|>tool\n{content}<|im_end|>\n",
	},
	// DeepSeek V3/R1.
	deepseek: {
		id: "deepseek",
		bos: "<｜begin▁of▁sentence｜>",
		eos: "<｜end▁of▁sentence｜>",
		system: "{content}",
		user: "<｜User｜>{content}<｜Assistant｜>",
		assistant: "{content}<｜end▁of▁sentence｜>",
		tool: "<｜tool▁calls▁begin｜>{content}<｜tool▁calls▁end｜>",
	},
	// Llama 3.x instruct.
	llama3: {
		id: "llama3",
		bos: "<|begin_of_text|>",
		system: "<|start_header_id|>system<|end_header_id|>\n\n{content}<|eot_id|>",
		user: "<|start_header_id|>user<|end_header_id|>\n\n{content}<|eot_id|>",
		assistant: "<|start_header_id|>assistant<|end_header_id|>\n\n{content}<|eot_id|>",
		tool: "<|start_header_id|>ipython<|end_header_id|>\n\n{content}<|eot_id|>",
	},
};

export function resolveChatTemplate(template: ExportSpec["template"]): ChatTemplateSpec {
	if (template === undefined) return CHAT_TEMPLATES.chatml;
	if (typeof template === "string") {
		const preset = CHAT_TEMPLATES[template];
		if (!preset) {
			throw new TypeError(`Unknown chat template "${template}". Known: ${Object.keys(CHAT_TEMPLATES).join(", ")}.`);
		}
		return preset;
	}
	return template;
}

export function resolveEnvironment(suite: SuiteSpec, profile: Profile): EnvironmentSpec | undefined {
	const reference = profile.environment;
	if (reference === undefined) return undefined;
	if (typeof reference !== "string") return reference;
	const environment = suite.environments?.find(({ id }) => id === reference);
	if (!environment) throw new TypeError(`Profile "${profile.id}" references unknown environment "${reference}".`);
	return environment;
}

export function resolveProfile(suite: SuiteSpec, profileId: string): Profile {
	const profile = suite.profiles.find(({ id }) => id === profileId);
	if (!profile) throw new TypeError(`Unknown profile "${profileId}" in suite "${suite.id}".`);
	return profile;
}

/**
 * JSON-safe description of a suite for the protocol file.
 *
 * Functions cannot be serialized, so transforms record their declared id and
 * every other value passes through unchanged.
 */
export function describeSuite(suite: SuiteSpec): unknown {
	const evalFiles = suite.evalFiles ?? [];
	return {
		id: suite.id,
		domains: suite.domains ?? [],
		families: suite.families ?? [],
		evalFiles,
		project: suite.project ?? (evalFiles.length > 0 ? "docs" : "suite"),
		comparison: suite.comparison ?? null,
		runs: suite.runs ?? 1,
		environments: (suite.environments ?? []).map((environment) => ({ ...environment })),
		profiles: suite.profiles.map((profile) => ({
			...profile,
			...(profile.tools
				? {
						tools: {
							...profile.tools,
							customTools: profile.tools.customTools?.map(({ name }) => name),
						},
					}
				: {}),
			systemPrompt: profile.systemPrompt
				? profile.systemPrompt.kind === "transform"
					? { kind: "transform", id: profile.systemPrompt.id }
					: profile.systemPrompt
				: { kind: "pi-default" },
		})),
		tasks: (suite.tasks ?? []).map((task) => ({ ...task })),
		exports: (suite.exports ?? []).map((spec) => ({
			...spec,
			template: typeof spec.template === "string" ? spec.template : spec.template?.id,
		})),
	};
}

/** Rejects a suite that cannot be planned, with the reason instead of a later crash. */
export function validateSuite(suite: SuiteSpec): SuiteSpec {
	if (!suite.id.trim()) throw new TypeError("Suite id must not be empty.");
	if (suite.profiles.length === 0) throw new TypeError(`Suite "${suite.id}" has no profiles.`);
	const profileIds = new Set<string>();
	for (const profile of suite.profiles) {
		if (!profile.id.trim()) throw new TypeError(`Suite "${suite.id}" has a profile without an id.`);
		if (profileIds.has(profile.id)) throw new TypeError(`Suite "${suite.id}" has duplicate profile "${profile.id}".`);
		profileIds.add(profile.id);
		const environment = resolveEnvironment(suite, profile);
		const backend = environment?.backend ?? "docker";
		const os = environment?.os ?? "linux";
		if (backend === "docker" && os !== "linux") {
			throw new TypeError(
				`Profile "${profile.id}" uses the docker backend with os "${os}". Docker supports linux only; use "host" or "remote".`,
			);
		}
		if (backend === "remote" && !environment?.runner?.trim()) {
			throw new TypeError(`Profile "${profile.id}" uses the remote backend without a runner URL.`);
		}
	}
	const hasEvalFiles = (suite.evalFiles?.length ?? 0) > 0;
	const hasTasks = (suite.tasks?.length ?? 0) > 0;
	if (hasEvalFiles === hasTasks) {
		throw new TypeError(`Suite "${suite.id}" must declare either evalFiles or tasks, not both or neither.`);
	}
	const taskIds = new Set<string>();
	const declaredDomains = suite.domains?.map(({ id }) => id);
	if (suite.domains && new Set(declaredDomains).size !== suite.domains.length) {
		throw new TypeError(`Suite "${suite.id}" has duplicate domains.`);
	}
	for (const family of suite.families ?? []) {
		if (family.domain && declaredDomains && !declaredDomains.includes(family.domain)) {
			throw new TypeError(`Family "${family.id}" references undeclared domain "${family.domain}".`);
		}
	}
	const declaredFamilies = suite.families?.map(({ id }) => id);
	if (suite.families && new Set(declaredFamilies).size !== suite.families.length) {
		throw new TypeError(`Suite "${suite.id}" has duplicate families.`);
	}
	for (const task of suite.tasks ?? []) {
		if (!task.id.trim()) throw new TypeError(`Suite "${suite.id}" has a task without an id.`);
		if (!task.evalSet.trim()) throw new TypeError(`Task "${task.id}" has no eval set.`);
		if (task.domain && declaredDomains && !declaredDomains.includes(task.domain)) {
			throw new TypeError(`Task "${task.id}" references undeclared domain "${task.domain}".`);
		}
		if (task.family && declaredFamilies && !declaredFamilies.includes(task.family)) {
			throw new TypeError(`Task "${task.id}" references undeclared family "${task.family}".`);
		}
		const identity = JSON.stringify([task.evalSet, task.id]);
		if (taskIds.has(identity)) throw new TypeError(`Duplicate task identity: ${task.evalSet} > ${task.id}`);
		taskIds.add(identity);
	}
	if (suite.comparison) {
		for (const id of [suite.comparison.control, suite.comparison.treatment]) {
			resolveProfile(suite, id);
		}
		if (suite.comparison.control === suite.comparison.treatment) {
			throw new TypeError("Suite comparison needs two different profiles.");
		}
	}
	const runs = suite.runs ?? 1;
	if (!Number.isSafeInteger(runs) || runs < 1) throw new TypeError("Suite runs must be a positive integer.");
	for (const spec of suite.exports ?? []) resolveChatTemplate(spec.template);
	return suite;
}
