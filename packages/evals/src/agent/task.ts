/**
 * Agent-eval task folders: a workspace paired with declarative checks and a
 * canonical solution. The config files are the JSON counterparts of the
 * Python agent-eval task format: task.yaml -> task.json, verify.yaml ->
 * verify.json, and solution/gold.yaml -> solution/gold.json.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Raised when a task folder is missing or invalid. */
export class TaskLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskLoadError";
	}
}

/** Raised when a path would resolve outside the workspace root. */
export class PathEscapeError extends Error {
	constructor(relativePath: string) {
		super(`path escapes the workspace: ${relativePath}`);
		this.name = "PathEscapeError";
	}
}

/**
 * Resolves a workspace-relative path and rejects any path that lands outside
 * the workspace. Absolute paths are allowed only when they are already inside
 * it; this is the single boundary every file check passes through.
 */
export function resolveWorkspacePath(workspace: string, relativePath: string): string {
	const root = resolve(workspace);
	const candidate = isAbsolute(relativePath) ? resolve(relativePath) : resolve(root, relativePath);
	const inside = relative(root, candidate);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw new PathEscapeError(relativePath);
	}
	return candidate;
}

/** Everything a task folder declares, with paths already resolved. */
export type AgentTask = {
	id: string;
	tags: string[];
	difficulty: string;
	prompt: string;
	validateProfiles: string[];
	userReply: string | null;
	maxActions: number | null;
	seed: number;
	root: string;
	repoDir: string;
	hiddenDir: string;
	verifyPath: string;
	solutionPath: string;
	skillsExtraDir: string;
};

const DEFAULT_PROFILES = ["pi_min", "medium_generic", "hermes_json_like"];

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new TaskLoadError(`${label} not found or unreadable: ${path}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TaskLoadError(`invalid JSON in ${label}: ${path}`);
	}
	if (!isObject(parsed)) {
		throw new TaskLoadError(`${label} must be a JSON object: ${path}`);
	}
	return parsed;
}

function requiredString(raw: Record<string, unknown>, key: string, path: string): string {
	const value = raw[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new TaskLoadError(`${key} must be a non-empty string in ${path}`);
	}
	return value;
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (isArray(value) && value.every((item) => typeof item === "string")) {
		return value as string[];
	}
	return fallback;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function optionalInt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Loads one task folder, enforcing the repo/verify/solution layout. */
export function loadAgentTask(path: string): AgentTask {
	const root = resolve(path);
	const configPath = join(root, "task.json");
	const raw = readJsonObject(configPath, "task.json");
	const id = requiredString(raw, "id", configPath);
	const prompt = requiredString(raw, "prompt", configPath);
	if (id !== basename(root)) {
		throw new TaskLoadError(
			`task id ${JSON.stringify(id)} does not match folder name ${JSON.stringify(basename(root))}`,
		);
	}
	const repoDir = join(root, "repo");
	if (!isDirectory(repoDir)) {
		throw new TaskLoadError(`repo/ directory is missing from ${root}`);
	}
	const verifyPath = join(root, "verify.json");
	if (!isFile(verifyPath)) {
		throw new TaskLoadError(`verify.json is missing from ${root}`);
	}
	const solutionPath = join(root, "solution", "gold.json");
	if (!isFile(solutionPath)) {
		throw new TaskLoadError(`solution/gold.json is missing from ${root}`);
	}
	return {
		id,
		tags: stringList(raw.tags, []),
		difficulty: typeof raw.difficulty === "string" ? raw.difficulty : "easy",
		prompt,
		validateProfiles: stringList(raw.validateProfiles, DEFAULT_PROFILES),
		userReply: optionalString(raw.userReply),
		maxActions: optionalInt(raw.maxActions),
		seed: optionalInt(raw.seed) ?? 0,
		root,
		repoDir,
		hiddenDir: join(root, "hidden"),
		verifyPath,
		solutionPath,
		skillsExtraDir: join(root, "skills_extra"),
	};
}

/** Loads every task folder found directly under the given directories. */
export function loadAgentTasks(dirs: string[]): AgentTask[] {
	const tasks: AgentTask[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const resolved = resolve(dir);
		if (!isDirectory(resolved)) continue;
		for (const entry of readdirSync(resolved, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = join(resolved, entry.name);
			if (seen.has(child)) continue;
			seen.add(child);
			tasks.push(loadAgentTask(child));
		}
	}
	return tasks;
}
