/**
 * Agent-eval harness profile schema and validation, ported from agenteval.profiles.schema.
 *
 * Profiles are plain JSON data. The types describe the fully resolved shape; validateAgentProfile
 * is the trust boundary that applies Pydantic-style defaults, rejects unknown keys, and enforces
 * the cross-field rules that keep a profile renderable by a harness.
 */

const PROMPT_WEIGHTS = ["minimal", "medium", "heavy"] as const;
const ENV_FIELDS = ["cwd", "os", "shell", "date", "git_status"] as const;
const HIERARCHIES = ["global_then_project", "project_only", "none"] as const;
const PROJECT_PLACEMENTS = ["system_tail", "first_user_message", "reminder"] as const;
const LINE_BASES = [0, 1] as const;
const LINE_RANGES = ["offset_limit", "start_end", "range_string"] as const;
const TERMINATIONS = ["no_tool_call", "finish_tool", "exit_command"] as const;
const EDIT_DIALECTS = [
	"str_replace",
	"search_replace_blocks",
	"apply_patch_v4a",
	"whole_file",
	"udiff",
	"bash_only",
] as const;
const PROTOCOLS = [
	"native_openai",
	"hermes_json",
	"xml_text",
	"json_action",
	"bash_block",
	"keystrokes",
	"plain_text",
	"terminus_json",
	"terminus_xml",
] as const;
const TOOLS_IN = ["tools_param", "system_prompt_text"] as const;
const RESULT_STYLES = ["plain", "numbered_lines", "json", "exit_code_footer"] as const;
const TRUNCATIONS = ["head_tail", "head", "none"] as const;
const SKILL_ADVERTISE = ["available_skills_xml", "markdown_list", "none"] as const;
const SKILL_LOADERS = ["read_file", "skill_tool"] as const;
const REMINDER_PLACEMENTS = ["user_suffix", "system_tail", "tool_result_suffix"] as const;
const PERMISSION_MODES = ["yolo", "ask", "plan_first", "auto", "skip"] as const;
const FAULT_PRESETS = ["none", "light", "heavy", "custom"] as const;
const HISTORY_REASONING = ["strip", "keep"] as const;

const REMINDER_CONDITIONS = [
	"every_n_turns",
	"min_turn",
	"max_turn",
	"if_tool_unused",
	"if_tool_used",
	"if_no_tool_calls",
] as const;
const INT_REMINDERS = ["every_n_turns", "min_turn", "max_turn"] as const;
const TOOL_REMINDERS = ["if_tool_unused", "if_tool_used"] as const;
const PLAIN_TEXT_DIALECTS = ["search_replace_blocks", "whole_file", "udiff"] as const;
const TERMINAL_TOOLS = ["bash", "terminal"] as const;

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const NATIVE_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

export type PromptWeight = (typeof PROMPT_WEIGHTS)[number];
export type EnvField = (typeof ENV_FIELDS)[number];
export type ProjectHierarchy = (typeof HIERARCHIES)[number];
export type ProjectPlacement = (typeof PROJECT_PLACEMENTS)[number];
export type LineBase = (typeof LINE_BASES)[number];
export type LineRange = (typeof LINE_RANGES)[number];
export type Termination = (typeof TERMINATIONS)[number];
export type EditDialect = (typeof EDIT_DIALECTS)[number];
export type Protocol = (typeof PROTOCOLS)[number];
export type ToolsIn = (typeof TOOLS_IN)[number];
export type ResultStyle = (typeof RESULT_STYLES)[number];
export type Truncation = (typeof TRUNCATIONS)[number];
export type SkillAdvertise = (typeof SKILL_ADVERTISE)[number];
export type SkillLoader = (typeof SKILL_LOADERS)[number];
export type ReminderPlacement = (typeof REMINDER_PLACEMENTS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type FaultPreset = (typeof FAULT_PRESETS)[number];
export type HistoryReasoning = (typeof HISTORY_REASONING)[number];

export type EnvBlockSpec = {
	enabled: boolean;
	fields: EnvField[];
};

export type ProjectContextSpec = {
	files: string[];
	hierarchy: ProjectHierarchy;
	placement: ProjectPlacement;
};

export type PromptSpec = {
	weight: PromptWeight;
	template: string;
	persona: string;
	sections: string[];
	envBlock: EnvBlockSpec;
	projectContext: ProjectContextSpec;
	systemReplaceable: boolean;
	emitDialectInstructions: boolean;
	embedTaskPrompt: boolean;
};

export type ToolSurfaceSpec = {
	canonical: string;
	name: string;
	params: Record<string, string>;
	description: string;
	lineBase: LineBase;
	lineRange: LineRange;
	extraParams: Record<string, Record<string, unknown>>;
	strict: boolean;
};

export type ToolsSpec = {
	termination: Termination;
	finishTool: string | null;
	finishWhenTrue: string | null;
	deferredLoading: boolean;
	surface: ToolSurfaceSpec[];
	editDialect: EditDialect;
};

export type WireSpec = {
	protocol: Protocol;
	parallelCalls: boolean;
	toolsIn: ToolsIn;
};

export type ResultsSpec = {
	style: ResultStyle;
	maxChars: number;
	truncation: Truncation;
	truncationNotice: string;
};

export type SkillsSpec = {
	enabled: boolean;
	advertise: SkillAdvertise;
	loader: SkillLoader;
	pack: string;
	surfaceEachTurn: boolean;
};

export type ReminderSpec = {
	id: string;
	when: Record<string, unknown>;
	placement: ReminderPlacement;
	template: string;
};

export type CompactionSpec = {
	enabled: boolean;
	thresholdRatio: number;
	keepTurns: number;
};

export type ContextSpec = {
	windowTokens: number;
	compaction: CompactionSpec;
};

export type PermissionsSpec = {
	mode: PermissionMode;
	denyRules: Record<string, unknown>[];
	hooks: Record<string, unknown>[];
	riskPatterns: string[];
	alwaysAskTools: string[];
};

export type StuckDetectorSpec = {
	enabled: boolean;
	repeatThreshold: number;
	nudge: string | null;
};

export type LoopSpec = {
	maxTurns: number;
	maxConsecutiveMalformed: number;
	stuckDetector: StuckDetectorSpec;
	steeringMessages: Record<string, unknown>[];
};

export type FaultsSpec = {
	preset: FaultPreset;
	seedSalt: number;
	custom: Record<string, unknown>[];
};

export type AgentProfile = {
	id: string;
	split: "train" | "heldout";
	family: string;
	prompt: PromptSpec;
	tools: ToolsSpec;
	wire: WireSpec;
	results: ResultsSpec;
	skills: SkillsSpec;
	reminders: ReminderSpec[];
	context: ContextSpec;
	permissions: PermissionsSpec;
	loop: LoopSpec;
	faults: FaultsSpec;
	historyReasoning: HistoryReasoning;
};

const ROOT_KEYS = [
	"id",
	"split",
	"family",
	"prompt",
	"tools",
	"wire",
	"results",
	"skills",
	"reminders",
	"context",
	"permissions",
	"loop",
	"faults",
	"historyReasoning",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError(`${where} must be an object`);
	return value;
}

function objectField(value: unknown, where: string): Record<string, unknown> {
	return value === undefined ? {} : asRecord(value, where);
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new TypeError(`${where}: unknown field "${key}"`);
	}
}

function boolField(value: unknown, where: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new TypeError(`${where} must be a boolean`);
	return value;
}

function stringField(value: unknown, where: string, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string") throw new TypeError(`${where} must be a string`);
	return value;
}

function requiredString(value: unknown, where: string): string {
	if (typeof value !== "string") throw new TypeError(`${where} must be a string`);
	return value;
}

function nonemptyString(value: unknown, where: string, message: string): string {
	const text = requiredString(value, where);
	if (!text.trim()) throw new TypeError(message);
	return text;
}

function enumField<T extends string | number>(value: unknown, allowed: readonly T[], where: string, fallback: T): T {
	if (value === undefined) return fallback;
	if (!allowed.some((item) => item === value)) {
		throw new TypeError(`${where} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function intField(value: unknown, where: string, fallback: number, min: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new TypeError(`${where} must be an integer >= ${min}`);
	}
	return value;
}

function plainIntField(value: unknown, where: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${where} must be an integer`);
	}
	return value;
}

function ratioField(value: unknown, where: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new TypeError(`${where} must be a number greater than 0 and at most 1`);
	}
	return value;
}

function stringArrayField(value: unknown, where: string, fallback: readonly string[]): string[] {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value)) throw new TypeError(`${where} must be an array of strings`);
	const items: unknown[] = value;
	if (items.some((item) => typeof item !== "string")) throw new TypeError(`${where} must be an array of strings`);
	return items as string[];
}

function recordArrayField(value: unknown, where: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new TypeError(`${where} must be an array of objects`);
	const items: unknown[] = value;
	if (items.some((item) => !isRecord(item))) throw new TypeError(`${where} must be an array of objects`);
	return items as Record<string, unknown>[];
}

function parseEnvBlock(value: unknown): EnvBlockSpec {
	const raw = objectField(value, "prompt.envBlock");
	checkKeys(raw, ["enabled", "fields"], "prompt.envBlock");
	const enabled = boolField(raw.enabled, "prompt.envBlock.enabled", false);
	const fields = stringArrayField(raw.fields, "prompt.envBlock.fields", ENV_FIELDS) as EnvField[];
	const unknown = [...new Set(fields.filter((field) => !(ENV_FIELDS as readonly string[]).includes(field)))].sort();
	if (unknown.length) throw new TypeError(`unknown environment fields: ${unknown.join(", ")}`);
	if (new Set(fields).size !== fields.length) throw new TypeError("environment fields must be unique");
	return { enabled, fields };
}

function parseProjectContext(value: unknown): ProjectContextSpec {
	const raw = objectField(value, "prompt.projectContext");
	checkKeys(raw, ["files", "hierarchy", "placement"], "prompt.projectContext");
	return {
		files: stringArrayField(raw.files, "prompt.projectContext.files", ["AGENTS.md"]),
		hierarchy: enumField(raw.hierarchy, HIERARCHIES, "prompt.projectContext.hierarchy", "global_then_project"),
		placement: enumField(raw.placement, PROJECT_PLACEMENTS, "prompt.projectContext.placement", "system_tail"),
	};
}

function parsePrompt(value: unknown): PromptSpec {
	const raw = objectField(value, "prompt");
	checkKeys(
		raw,
		[
			"weight",
			"template",
			"persona",
			"sections",
			"envBlock",
			"projectContext",
			"systemReplaceable",
			"emitDialectInstructions",
			"embedTaskPrompt",
		],
		"prompt",
	);
	return {
		weight: enumField(raw.weight, PROMPT_WEIGHTS, "prompt.weight", "minimal"),
		template:
			raw.template === undefined
				? "default.j2"
				: nonemptyString(raw.template, "prompt.template", "prompt.template must not be empty"),
		persona: stringField(raw.persona, "prompt.persona", "expert coding assistant"),
		sections: stringArrayField(raw.sections, "prompt.sections", []),
		envBlock: parseEnvBlock(raw.envBlock),
		projectContext: parseProjectContext(raw.projectContext),
		systemReplaceable: boolField(raw.systemReplaceable, "prompt.systemReplaceable", false),
		emitDialectInstructions: boolField(raw.emitDialectInstructions, "prompt.emitDialectInstructions", true),
		embedTaskPrompt: boolField(raw.embedTaskPrompt, "prompt.embedTaskPrompt", false),
	};
}

function parseToolSurface(value: unknown, index: number): ToolSurfaceSpec {
	const where = `tools.surface[${index}]`;
	const raw = asRecord(value, where);
	checkKeys(
		raw,
		["canonical", "name", "params", "description", "lineBase", "lineRange", "extraParams", "strict"],
		where,
	);
	const paramsRaw = objectField(raw.params, `${where}.params`);
	const params: Record<string, string> = {};
	for (const [key, target] of Object.entries(paramsRaw)) {
		if (typeof target !== "string") throw new TypeError(`${where}.params.${key} must be a string`);
		params[key] = target;
	}
	const extraRaw = objectField(raw.extraParams, `${where}.extraParams`);
	const extraParams: Record<string, Record<string, unknown>> = {};
	for (const [key, entry] of Object.entries(extraRaw)) {
		extraParams[key] = asRecord(entry, `${where}.extraParams.${key}`);
	}
	return {
		canonical: nonemptyString(
			raw.canonical,
			`${where}.canonical`,
			"tool names and canonical names must not be empty",
		),
		name: nonemptyString(raw.name, `${where}.name`, "tool names and canonical names must not be empty"),
		params,
		description: stringField(raw.description, `${where}.description`, ""),
		lineBase: enumField(raw.lineBase, LINE_BASES, `${where}.lineBase`, 1),
		lineRange: enumField(raw.lineRange, LINE_RANGES, `${where}.lineRange`, "offset_limit"),
		extraParams,
		strict: boolField(raw.strict, `${where}.strict`, false),
	};
}

function parseTools(value: unknown): ToolsSpec {
	const raw = objectField(value, "tools");
	checkKeys(
		raw,
		["termination", "finishTool", "finishWhenTrue", "deferredLoading", "surface", "editDialect"],
		"tools",
	);
	const surfaceRaw = raw.surface;
	if (surfaceRaw !== undefined && !Array.isArray(surfaceRaw)) {
		throw new TypeError("tools.surface must be an array");
	}
	const surface = ((surfaceRaw ?? []) as unknown[]).map((item, index) => parseToolSurface(item, index));
	const nullableString = (field: unknown, where: string): string | null => {
		if (field === undefined || field === null) return null;
		if (typeof field !== "string") throw new TypeError(`${where} must be a string or null`);
		return field;
	};
	return {
		termination: enumField(raw.termination, TERMINATIONS, "tools.termination", "no_tool_call"),
		finishTool: nullableString(raw.finishTool, "tools.finishTool"),
		finishWhenTrue: nullableString(raw.finishWhenTrue, "tools.finishWhenTrue"),
		deferredLoading: boolField(raw.deferredLoading, "tools.deferredLoading", false),
		surface,
		editDialect: enumField(raw.editDialect, EDIT_DIALECTS, "tools.editDialect", "str_replace"),
	};
}

function parseWire(value: unknown): WireSpec {
	const raw = objectField(value, "wire");
	checkKeys(raw, ["protocol", "parallelCalls", "toolsIn"], "wire");
	return {
		protocol: enumField(raw.protocol, PROTOCOLS, "wire.protocol", "native_openai"),
		parallelCalls: boolField(raw.parallelCalls, "wire.parallelCalls", false),
		toolsIn: enumField(raw.toolsIn, TOOLS_IN, "wire.toolsIn", "tools_param"),
	};
}

function parseResults(value: unknown): ResultsSpec {
	const raw = objectField(value, "results");
	checkKeys(raw, ["style", "maxChars", "truncation", "truncationNotice"], "results");
	return {
		style: enumField(raw.style, RESULT_STYLES, "results.style", "plain"),
		maxChars: intField(raw.maxChars, "results.maxChars", 20_000, 1),
		truncation: enumField(raw.truncation, TRUNCATIONS, "results.truncation", "head_tail"),
		truncationNotice: stringField(
			raw.truncationNotice,
			"results.truncationNotice",
			"[output truncated: N chars omitted]",
		),
	};
}

function parseSkills(value: unknown): SkillsSpec {
	const raw = objectField(value, "skills");
	checkKeys(raw, ["enabled", "advertise", "loader", "pack", "surfaceEachTurn"], "skills");
	return {
		enabled: boolField(raw.enabled, "skills.enabled", true),
		advertise: enumField(raw.advertise, SKILL_ADVERTISE, "skills.advertise", "available_skills_xml"),
		loader: enumField(raw.loader, SKILL_LOADERS, "skills.loader", "read_file"),
		pack: stringField(raw.pack, "skills.pack", "default_pack"),
		surfaceEachTurn: boolField(raw.surfaceEachTurn, "skills.surfaceEachTurn", false),
	};
}

function validateWhen(value: Record<string, unknown>): Record<string, unknown> {
	const unknown = Object.keys(value)
		.filter((key) => !(REMINDER_CONDITIONS as readonly string[]).includes(key))
		.sort();
	if (unknown.length) throw new TypeError(`unknown reminder condition(s): ${unknown.join(", ")}`);
	for (const name of INT_REMINDERS) {
		const field = value[name];
		if (field !== undefined && (typeof field !== "number" || !Number.isInteger(field) || field < 1)) {
			throw new TypeError(`reminder condition ${name} must be an integer >= 1`);
		}
	}
	for (const name of TOOL_REMINDERS) {
		const field = value[name];
		if (field !== undefined && (typeof field !== "string" || !field.trim())) {
			throw new TypeError(`reminder condition ${name} must be a tool name`);
		}
	}
	if (value.if_no_tool_calls !== undefined && typeof value.if_no_tool_calls !== "boolean") {
		throw new TypeError("reminder condition if_no_tool_calls must be a boolean");
	}
	return { ...value };
}

function parseReminder(value: unknown, index: number): ReminderSpec {
	const where = `reminders[${index}]`;
	const raw = asRecord(value, where);
	checkKeys(raw, ["id", "when", "placement", "template"], where);
	return {
		id: nonemptyString(raw.id, `${where}.id`, "reminder id and template must not be empty"),
		when: validateWhen(objectField(raw.when, `${where}.when`)),
		placement: enumField(raw.placement, REMINDER_PLACEMENTS, `${where}.placement`, "user_suffix"),
		template: nonemptyString(raw.template, `${where}.template`, "reminder id and template must not be empty"),
	};
}

function parseCompaction(value: unknown): CompactionSpec {
	const raw = objectField(value, "context.compaction");
	checkKeys(raw, ["enabled", "thresholdRatio", "keepTurns"], "context.compaction");
	return {
		enabled: boolField(raw.enabled, "context.compaction.enabled", false),
		thresholdRatio: ratioField(raw.thresholdRatio, "context.compaction.thresholdRatio", 0.75),
		keepTurns: intField(raw.keepTurns, "context.compaction.keepTurns", 2, 1),
	};
}

function parseContext(value: unknown): ContextSpec {
	const raw = objectField(value, "context");
	checkKeys(raw, ["windowTokens", "compaction"], "context");
	return {
		windowTokens: intField(raw.windowTokens, "context.windowTokens", 32_768, 1),
		compaction: parseCompaction(raw.compaction),
	};
}

function parsePermissions(value: unknown): PermissionsSpec {
	const raw = objectField(value, "permissions");
	checkKeys(raw, ["mode", "denyRules", "hooks", "riskPatterns", "alwaysAskTools"], "permissions");
	return {
		mode: enumField(raw.mode, PERMISSION_MODES, "permissions.mode", "yolo"),
		denyRules: recordArrayField(raw.denyRules, "permissions.denyRules"),
		hooks: recordArrayField(raw.hooks, "permissions.hooks"),
		riskPatterns: stringArrayField(raw.riskPatterns, "permissions.riskPatterns", []),
		alwaysAskTools: stringArrayField(raw.alwaysAskTools, "permissions.alwaysAskTools", []),
	};
}

function parseStuckDetector(value: unknown): StuckDetectorSpec {
	const raw = objectField(value, "loop.stuckDetector");
	checkKeys(raw, ["enabled", "repeatThreshold", "nudge"], "loop.stuckDetector");
	let nudge: string | null = null;
	if (raw.nudge !== undefined && raw.nudge !== null) {
		if (typeof raw.nudge !== "string") throw new TypeError("loop.stuckDetector.nudge must be a string or null");
		if (!raw.nudge.trim()) throw new TypeError("stuck detector nudge must not be empty when set");
		nudge = raw.nudge;
	}
	return {
		enabled: boolField(raw.enabled, "loop.stuckDetector.enabled", true),
		repeatThreshold: intField(raw.repeatThreshold, "loop.stuckDetector.repeatThreshold", 3, 2),
		nudge,
	};
}

function validateSteering(messages: Record<string, unknown>[]): Record<string, unknown>[] {
	for (const [index, item] of messages.entries()) {
		const turn = item.turn ?? item.at_turn;
		if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) {
			throw new TypeError(`steering message ${index} needs an integer turn >= 1`);
		}
		const text = item.text ?? item.content ?? item.message;
		if (typeof text !== "string" || !text.trim()) {
			throw new TypeError(`steering message ${index} needs non-empty text`);
		}
	}
	return messages;
}

function parseLoop(value: unknown): LoopSpec {
	const raw = objectField(value, "loop");
	checkKeys(raw, ["maxTurns", "maxConsecutiveMalformed", "stuckDetector", "steeringMessages"], "loop");
	return {
		maxTurns: intField(raw.maxTurns, "loop.maxTurns", 40, 1),
		maxConsecutiveMalformed: intField(raw.maxConsecutiveMalformed, "loop.maxConsecutiveMalformed", 3, 0),
		stuckDetector: parseStuckDetector(raw.stuckDetector),
		steeringMessages: validateSteering(recordArrayField(raw.steeringMessages, "loop.steeringMessages")),
	};
}

function parseFaults(value: unknown): FaultsSpec {
	const raw = objectField(value, "faults");
	checkKeys(raw, ["preset", "seedSalt", "custom"], "faults");
	return {
		preset: enumField(raw.preset, FAULT_PRESETS, "faults.preset", "none"),
		seedSalt: plainIntField(raw.seedSalt, "faults.seedSalt", 0),
		custom: recordArrayField(raw.custom, "faults.custom"),
	};
}

function fullMatch(value: string, pattern: RegExp): boolean {
	const match = pattern.exec(value);
	return match !== null && match[0].length === value.length;
}

/** Mirrors schema.py:310-409: checks that a parsed profile is internally renderable. */
function validateProfileRules(profile: AgentProfile): void {
	const surface = profile.tools.surface;
	const canonical = surface.map((tool) => tool.canonical);
	if (new Set(canonical).size !== canonical.length) {
		throw new TypeError("tools.surface contains duplicate canonical tools");
	}
	const names = surface.map((tool) => tool.name);
	if (new Set(names).size !== names.length) {
		throw new TypeError("tools.surface contains duplicate skinned tool names");
	}

	const { termination, finishTool, finishWhenTrue } = profile.tools;
	if (termination === "finish_tool") {
		if (!finishTool) {
			throw new TypeError(
				"finish_tool termination requires tools.finishTool to name a canonical tool in tools.surface",
			);
		}
		if (!canonical.includes(finishTool)) {
			throw new TypeError(`tools.finishTool ${JSON.stringify(finishTool)} is not in tools.surface`);
		}
	} else if (finishTool !== null) {
		throw new TypeError("tools.finishTool is only valid with termination: finish_tool");
	}
	if (finishWhenTrue !== null) {
		if (termination !== "finish_tool") {
			throw new TypeError("tools.finishWhenTrue is only valid with termination: finish_tool");
		}
		const surfaceParams = new Set<string>();
		for (const tool of surface) {
			for (const name of Object.values(tool.params)) surfaceParams.add(name);
			for (const name of Object.keys(tool.extraParams)) surfaceParams.add(name);
			for (const name of Object.keys(tool.params)) surfaceParams.add(name);
		}
		if (!surfaceParams.has(finishWhenTrue)) {
			throw new TypeError(
				`tools.finishWhenTrue ${JSON.stringify(finishWhenTrue)} is not a parameter of any tool in tools.surface`,
			);
		}
	}

	const native = profile.wire.protocol === "native_openai";
	const namePattern = native ? NATIVE_TOOL_NAME_RE : TOOL_NAME_RE;
	for (const tool of surface) {
		if (!fullMatch(tool.name, namePattern)) {
			throw new TypeError(
				`tool name ${JSON.stringify(tool.name)} is invalid for ${native ? "native" : "text"} wire names`,
			);
		}
		const targets = Object.values(tool.params);
		if (targets.some((target) => !target)) {
			throw new TypeError(`tool ${JSON.stringify(tool.name)} has an empty parameter name`);
		}
		if (new Set(targets).size !== targets.length) {
			throw new TypeError(`tool ${JSON.stringify(tool.name)} maps two parameters to the same name`);
		}
		const extras = Object.keys(tool.extraParams);
		if (extras.some((extra) => !extra)) {
			throw new TypeError(`tool ${JSON.stringify(tool.name)} has an empty extra parameter name`);
		}
		if (extras.some((extra) => targets.includes(extra))) {
			throw new TypeError(`tool ${JSON.stringify(tool.name)} uses the same name for an extra and mapped parameter`);
		}
		for (const target of [...targets, ...extras]) {
			if (!fullMatch(target, TOOL_NAME_RE)) {
				throw new TypeError(
					`invalid parameter name ${JSON.stringify(target)} on tool ${JSON.stringify(tool.name)}`,
				);
			}
		}
	}

	if (native && profile.wire.toolsIn !== "tools_param") {
		throw new TypeError("native_openai wire requires toolsIn: tools_param");
	}
	if (profile.wire.protocol === "bash_block" && profile.tools.editDialect !== "bash_only") {
		throw new TypeError("bash_block wire requires editDialect: bash_only");
	}
	if (profile.wire.protocol === "keystrokes") {
		if (surface.length !== 1 || !(TERMINAL_TOOLS as readonly string[]).includes(surface[0].canonical)) {
			throw new TypeError("keystrokes wire requires exactly one terminal (bash) tool");
		}
	}
	if (profile.wire.protocol === "plain_text") {
		if (surface.length > 0) {
			throw new TypeError("plain_text wire has no tool calling; remove tools.surface");
		}
		if (!(PLAIN_TEXT_DIALECTS as readonly EditDialect[]).includes(profile.tools.editDialect)) {
			throw new TypeError(
				"plain_text wire requires a text edit dialect (search_replace_blocks, whole_file, or udiff)",
			);
		}
	}
	if (profile.tools.deferredLoading && !surface.some((tool) => tool.canonical === "tool_search")) {
		throw new TypeError("deferred_loading requires a tool_search tool in the surface");
	}
}

/** Validates raw JSON profile data, applies defaults, and returns a fully resolved AgentProfile. */
export function validateAgentProfile(value: unknown): AgentProfile {
	const raw = asRecord(value, "profile");
	checkKeys(raw, ROOT_KEYS, "profile");

	const split = enumField(raw.split, ["train", "heldout"], "split", "train");
	const profile: AgentProfile = {
		id: nonemptyString(raw.id, "id", "id and family must not be empty"),
		split,
		family: nonemptyString(raw.family, "family", "id and family must not be empty"),
		prompt: parsePrompt(raw.prompt),
		tools: parseTools(raw.tools),
		wire: parseWire(raw.wire),
		results: parseResults(raw.results),
		skills: parseSkills(raw.skills),
		reminders: (raw.reminders === undefined ? [] : recordArrayField(raw.reminders, "reminders")).map((item, index) =>
			parseReminder(item, index),
		),
		context: parseContext(raw.context),
		permissions: parsePermissions(raw.permissions),
		loop: parseLoop(raw.loop),
		faults: parseFaults(raw.faults),
		historyReasoning: enumField(raw.historyReasoning, HISTORY_REASONING, "historyReasoning", "strip"),
	};
	validateProfileRules(profile);
	return profile;
}
