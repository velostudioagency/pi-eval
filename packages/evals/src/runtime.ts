/**
 * Runtime dispatch: the same planned task can run in a Linux container, on the
 * local host OS, or on a remote runner that owns the requested OS.
 *
 * Traces, judges, and reports are shared by every backend; only task execution
 * differs. Docker keeps the container isolation. Host runs the declarative
 * suite directly on this machine. Remote forwards one arm over HTTP.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentSpec, HostOs, RuntimeBackend } from "./config.ts";
import { type DockerContext, runTask as runDockerTask, taskDirectoryName } from "./docker.ts";
import type { EvalTask } from "./plan.ts";
import { type EvalObservation, erroredObservation, readTaskResult, type TaskResult } from "./report.ts";
import type { TraceRecord } from "./trace.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

export type RunContext = {
	artifactDirectory: string;
	docker: DockerContext;
	provider: string;
	model: string;
	suiteId: string;
	apiBase?: string;
	apiKey?: string;
	api?: string;
};

export type RuntimeTarget = {
	backend: RuntimeBackend;
	environment: EnvironmentSpec | undefined;
	os: HostOs;
	runnerUrl?: string;
};

/** Maps Node's platform names to the OS labels used in environment specs. */
export function hostOs(platform: NodeJS.Platform = process.platform): HostOs {
	if (platform === "win32") return "windows";
	if (platform === "darwin") return "macos";
	return "linux";
}

/** Resolves an environment's backend, with optional CLI overrides. */
export function selectRuntime(
	environment: EnvironmentSpec | undefined,
	overrides: { backend?: RuntimeBackend; os?: HostOs; runner?: string } = {},
): RuntimeTarget {
	const backend = overrides.backend ?? environment?.backend ?? "docker";
	const os = overrides.os ?? environment?.os ?? "linux";
	const runnerUrl = overrides.runner ?? environment?.runner;
	if (backend === "remote" && !runnerUrl) {
		throw new Error(`Remote backend needs a runner URL (environment "${environment?.id ?? "default"}").`);
	}
	return { backend, environment, os, ...(runnerUrl ? { runnerUrl } : {}) };
}

/** Fails before any run when a backend cannot execute the requested OS. */
export function assertRuntime(target: RuntimeTarget, currentOs: HostOs = hostOs()): void {
	if (target.backend === "docker" && target.os !== "linux") {
		throw new Error(`Docker backend supports linux only; use "host" or "remote" for ${target.os}.`);
	}
	if (target.backend === "host" && target.os !== currentOs) {
		throw new Error(`Host backend runs ${currentOs}, not ${target.os}. Use "remote" with a ${target.os} runner.`);
	}
}

function exactPattern(task: EvalTask): string {
	return `^${`${task.evalSet} ${task.caseId}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function hostReport(context: RunContext, task: EvalTask, project: string): string | undefined {
	const outputDirectory = join(context.artifactDirectory, "tasks", taskDirectoryName(task));
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const outputFile = join(outputDirectory, "vitest.json");
	const args = [
		resolve(repositoryRoot, "node_modules", "vitest", "dist", "cli.js"),
		"run",
		"--config",
		"vitest.evals.config.ts",
		"--project",
		project,
		task.file,
		"--testNamePattern",
		exactPattern(task),
		"--reporter=vitest-evals/reporter",
		"--reporter=json",
		"--outputFile",
		outputFile,
	];
	const environment = { ...process.env };
	delete environment.PI_EVAL_CONTAINER;
	environment.PI_EVAL_SUITE = context.suiteId;
	environment.PI_EVAL_PROFILE = task.profile;
	environment.PI_PROVIDER = context.provider;
	environment.PI_MODEL = context.model;
	if (context.apiBase) environment.PI_EVAL_API_BASE = context.apiBase;
	if (context.apiKey) environment.PI_EVAL_API_KEY = context.apiKey;
	if (context.api) environment.PI_EVAL_API = context.api;
	const result = spawnSync(process.execPath, args, {
		cwd: packageRoot,
		env: environment,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(-2000);
		console.error(`Host eval exited with status ${result.status}.${detail ? `\n${detail}` : ""}`);
	}
	return existsSync(outputFile) ? outputFile : undefined;
}

function readRemoteResult(body: unknown, task: EvalTask): TaskResult {
	if (typeof body !== "object" || body === null) throw new Error("Remote runner returned no result.");
	const result = body as { observation?: EvalObservation; trace?: TraceRecord };
	if (!result.observation || typeof result.observation.outcome !== "string") {
		throw new Error("Remote runner returned an invalid observation.");
	}
	const identity = result.observation;
	if (
		identity.evalSet !== task.evalSet ||
		identity.caseId !== task.caseId ||
		identity.profile !== task.profile ||
		identity.runNumber !== task.runNumber
	) {
		throw new Error(`Remote runner returned a result for the wrong task: ${task.evalSet} > ${task.caseId}.`);
	}
	return { observation: identity, ...(result.trace ? { trace: result.trace } : {}) };
}

async function runRemoteTask(
	context: RunContext,
	task: EvalTask,
	target: RuntimeTarget,
	project: string,
): Promise<TaskResult> {
	const token = process.env.PI_EVAL_RUNNER_TOKEN?.trim();
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`${target.runnerUrl!.replace(/\/$/, "")}/tasks/run`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			suiteId: context.suiteId,
			profile: task.profile,
			task,
			project,
			provider: context.provider,
			model: context.model,
			os: target.os,
			...(context.apiBase ? { apiBase: context.apiBase } : {}),
			...(context.apiKey ? { apiKey: context.apiKey } : {}),
			...(context.api ? { api: context.api } : {}),
		}),
		signal: AbortSignal.timeout(30 * 60_000),
	});
	if (!response.ok) throw new Error(`Remote runner returned ${response.status}: ${await response.text()}`);
	return readRemoteResult(await response.json(), task);
}

/** Executes one planned task on the selected backend. */
export async function runTaskOnRuntime(
	context: RunContext,
	task: EvalTask,
	target: RuntimeTarget,
	project: string,
): Promise<TaskResult> {
	assertRuntime(target);
	if (target.backend === "remote") return runRemoteTask(context, task, target, project);
	const reportPath =
		target.backend === "docker"
			? runDockerTask(context.docker, task, target.environment, project)
			: hostReport(context, task, project);
	if (!reportPath) return { observation: erroredObservation(task) };
	return readTaskResult(task, reportPath, context.artifactDirectory);
}
