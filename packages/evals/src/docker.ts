/**
 * Docker runner: builds one image per environment, discovers eval cases, and
 * runs one isolated container per planned task.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentSpec } from "./config.ts";
import type { EvalTask } from "./plan.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

/** Base image of the Pi repository runtime when an environment does not override it. */
export const DEFAULT_BASE_IMAGE = "node:24-slim";

export type BuiltImage = {
	environment: string;
	name: string;
	id: string;
	includeDocs: boolean;
	baseImage: string;
};

/** Images keyed by environment id, with "default" for profiles without an environment. */
export type BuiltImages = Record<string, BuiltImage>;

export type DockerContext = {
	images: BuiltImages;
	artifactDirectory: string;
	authPath: string;
	provider: string;
	model: string;
	runsPerProfile: number;
	suiteId: string;
	apiBase?: string;
	apiKey?: string;
	api?: string;
};

function execute(command: string, args: readonly string[], capture = false): { status: number; stdout: string } {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: capture ? result.stdout : "" };
}

function requireSuccess(command: string, args: readonly string[]): void {
	const { status } = execute(command, args);
	if (status !== 0) throw new Error(`${command} exited with status ${status}.`);
}

export function environmentKey(environment: EnvironmentSpec | undefined): string {
	return environment?.id ?? "default";
}

function imageSlug(key: string): string {
	return key.replaceAll(/[^a-z0-9_.-]+/gi, "-").toLowerCase();
}

export function buildImages(environments: readonly (EnvironmentSpec | undefined)[]): BuiltImages {
	const prefix = `pi-evals-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 12)}`;
	const images: BuiltImages = {};
	for (const environment of environments) {
		const key = environmentKey(environment);
		if (images[key]) continue;
		const includeDocs = environment?.includeDocs ?? true;
		const baseImage = environment?.baseImage ?? DEFAULT_BASE_IMAGE;
		const name = `${prefix}-${imageSlug(key)}:local`;
		requireSuccess("docker", [
			"build",
			"--target",
			includeDocs ? "docs" : "no-docs",
			"--tag",
			name,
			"--build-arg",
			`BASE_IMAGE=${baseImage}`,
			"--file",
			join(packageRoot, "docker", "Dockerfile"),
			repositoryRoot,
		]);
		const inspected = execute("docker", ["image", "inspect", "--format", "{{.Id}}", name], true);
		if (inspected.status !== 0 || !inspected.stdout.trim()) throw new Error(`Cannot inspect ${name}.`);
		images[key] = { environment: key, name, id: inspected.stdout.trim(), includeDocs, baseImage };
	}
	return images;
}

function environment(name: string, value: string): string[] {
	return ["--env", `${name}=${value}`];
}

export function requireEvalAuthFile(provider: string): string {
	const path = join(
		process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"),
		"auth.json",
	);
	if (!existsSync(path) || !statSync(path).isFile())
		throw new Error(`Eval authentication file does not exist: ${path}`);
	let credentials: unknown;
	try {
		credentials = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Eval authentication file is invalid: ${path}`, { cause: error });
	}
	if (
		typeof credentials !== "object" ||
		credentials === null ||
		Array.isArray(credentials) ||
		!Object.hasOwn(credentials, provider)
	) {
		throw new Error(`Eval authentication file has no credential for provider ${provider}.`);
	}
	return path;
}

function dockerArgs(
	context: DockerContext,
	image: BuiltImage,
	profile: string,
	outputDirectory: string,
	entrypointArgs: readonly string[],
): string[] {
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const args = [
		"run",
		"--rm",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,exec,mode=1777",
		"--tmpfs",
		"/repo/node_modules/.vite-temp:rw,exec,mode=1777",
		"--mount",
		`type=bind,source=${outputDirectory},target=/artifacts`,
		...environment("PI_EVAL_ARTIFACT_DIR", "/artifacts"),
		...environment("PI_EVAL_RUNS_PER_VARIANT", String(context.runsPerProfile)),
		...environment("PI_EVAL_SANDBOX_UID", "65532"),
		...environment("PI_EVAL_SANDBOX_GID", "65532"),
		...environment("PI_EVAL_SUITE", context.suiteId),
		...environment("PI_EVAL_PROFILE", profile),
		...environment("PI_EVAL_DOCS", image.includeDocs ? "1" : "0"),
		...(context.apiBase ? environment("PI_EVAL_API_BASE", context.apiBase) : []),
		...(context.apiKey ? environment("PI_EVAL_API_KEY", context.apiKey) : []),
		...(context.api ? environment("PI_EVAL_API", context.api) : []),
		...environment("PI_PROVIDER", context.provider),
		...environment("PI_MODEL", context.model),
	];
	if (typeof process.getuid === "function" && typeof process.getgid === "function") {
		args.push(
			...environment("PI_EVAL_ARTIFACT_UID", String(process.getuid())),
			...environment("PI_EVAL_ARTIFACT_GID", String(process.getgid())),
		);
	}
	args.push("--mount", `type=bind,source=${context.authPath},target=/run/pi-eval-secrets/auth.json,readonly`);
	args.push(image.name, ...entrypointArgs);
	return args;
}

export function createDockerContext(
	images: BuiltImages,
	artifactDirectory: string,
	authPath: string,
	provider: string,
	model: string,
	runsPerProfile: number,
	suiteId: string,
	endpoint: { apiBase?: string; apiKey?: string; api?: string } = {},
): DockerContext {
	return { images, artifactDirectory, authPath, provider, model, runsPerProfile, suiteId, ...endpoint };
}

export function discoverCases(
	context: DockerContext,
	environment: EnvironmentSpec | undefined,
	profile: string,
	project: string,
	files: readonly string[],
	vitestArgs: readonly string[],
): string {
	const key = environmentKey(environment);
	const image = context.images[key];
	if (!image) throw new Error(`No image was built for environment "${key}".`);
	const outputDirectory = join(context.artifactDirectory, "discovery", key);
	const args = dockerArgs(context, image, profile, outputDirectory, [
		"--discover",
		"--project",
		project,
		...files,
		...vitestArgs,
	]);
	const { status } = execute("docker", args);
	if (status !== 0) throw new Error(`${key} eval discovery failed.`);
	return join(outputDirectory, "discovered-tests.json");
}

export function taskDirectoryName(task: EvalTask): string {
	const identity = JSON.stringify([task.evalSet, task.caseId, task.profile, task.model, task.runNumber]);
	return createHash("sha256").update(identity).digest("hex");
}

export function runTask(
	context: DockerContext,
	task: EvalTask,
	environment: EnvironmentSpec | undefined,
	project: string,
): string | undefined {
	const key = environmentKey(environment);
	const image = context.images[key];
	if (!image) throw new Error(`No image was built for environment "${key}".`);
	const outputDirectory = join(context.artifactDirectory, "tasks", taskDirectoryName(task));
	const testName = `${task.evalSet} ${task.caseId}`;
	const exactName = `^${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const args = dockerArgs(context, image, task.profile, outputDirectory, [
		"--project",
		project,
		task.file,
		"--testNamePattern",
		exactName,
	]);
	execute("docker", args);
	const reportPath = join(outputDirectory, "vitest.json");
	return existsSync(reportPath) ? reportPath : undefined;
}
