/**
 * HTTP runner for a suite. The caller (CLI on another machine or a Jupyter
 * notebook) sends configuration; this process owns the OS backends, provider
 * credentials, and artifact files.
 *
 * GET  /health      -> runner OS, available backends, registered suites
 * POST /runs        -> run a whole suite through the CLI; returns report, traces, datasets
 * POST /tasks/run   -> run one planned arm (used by the remote runtime adapter)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_REGISTRY } from "../evals/suites/index.ts";
import type { HostOs, RuntimeBackend } from "./config.ts";
import { resolveEnvironment, resolveProfile } from "./config.ts";
import { createDockerContext, requireEvalAuthFile } from "./docker.ts";
import type { EvalTask } from "./plan.ts";
import { suiteById } from "./profile-env.ts";
import { assertRuntime, hostOs, type RuntimeTarget, runTaskOnRuntime, selectRuntime } from "./runtime.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const currentOs = hostOs();

type RunRequest = {
	suite?: string;
	provider?: string;
	model?: string;
	profiles?: string[];
	tasks?: string[];
	families?: string[];
	domains?: string[];
	runs?: number;
	backend?: RuntimeBackend;
	os?: HostOs;
	apiBase?: string;
	apiKey?: string;
	api?: string;
	exports?: Array<{ format: string; file?: string; template?: string | { id: string } }>;
};

function send(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	response.end(text);
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > limit) throw new Error(`Request body exceeds ${limit} bytes.`);
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: IncomingMessage): boolean {
	const token = process.env.PI_EVAL_RUNNER_TOKEN?.trim();
	if (!token) return true;
	return request.headers.authorization === `Bearer ${token}`;
}

function jsonLines(path: string): unknown[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8").trim();
	if (!text) return [];
	return text.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function runSuite(body: RunRequest, artifactDirectory: string) {
	const args = ["--experimental-strip-types", "src/cli.ts"];
	if (body.suite) args.push("--suite", body.suite);
	if (body.provider) args.push("--provider", body.provider);
	if (body.model) args.push("--model", body.model);
	if (body.profiles?.length) args.push("--profile", body.profiles.join(","));
	if (body.tasks?.length) args.push("--task", body.tasks.join(","));
	if (body.families?.length) args.push("--family", body.families.join(","));
	if (body.domains?.length) args.push("--domain", body.domains.join(","));
	if (body.runs !== undefined) args.push("--runs", String(body.runs));
	args.push("--backend", body.backend === "remote" ? "host" : (body.backend ?? "host"));
	if (body.os) args.push("--os", body.os);
	if (body.exports?.length) {
		for (const spec of body.exports) {
			args.push("--export", spec.file ? `${spec.format}:${spec.file}` : spec.format);
		}
	}
	args.push("--artifact-dir", artifactDirectory);
	const environment = { ...process.env };
	if (body.apiBase) environment.PI_EVAL_API_BASE = body.apiBase;
	if (body.apiKey) environment.PI_EVAL_API_KEY = body.apiKey;
	if (body.api) environment.PI_EVAL_API = body.api;
	const result = spawnSync(process.execPath, args, {
		cwd: packageRoot,
		env: environment,
		encoding: "utf8",
		timeout: 30 * 60_000,
	});
	const reportFile = join(artifactDirectory, "report.json");
	const report = readdirSync(artifactDirectory).includes("report.json")
		? JSON.parse(readFileSync(reportFile, "utf8"))
		: null;
	const datasets: Record<string, unknown[]> = {};
	for (const name of readdirSync(artifactDirectory)) {
		if (name.startsWith("dataset.") && name.endsWith(".jsonl")) {
			datasets[name] = jsonLines(join(artifactDirectory, name));
		}
	}
	return {
		ok: result.error === undefined && report !== null,
		exitCode: result.status,
		artifactDirectory,
		report,
		traces: jsonLines(join(artifactDirectory, "traces.jsonl")),
		datasets,
		stdout: result.stdout?.slice(-4000) ?? "",
		stderr: result.stderr?.slice(-4000) ?? "",
		...(result.error ? { error: result.error.message } : {}),
	};
}

async function runOneTask(body: Record<string, unknown>, artifactDirectory: string) {
	const suiteId = typeof body.suiteId === "string" ? body.suiteId : "";
	const profile = typeof body.profile === "string" ? body.profile : "";
	const project = typeof body.project === "string" ? body.project : "suite";
	const provider = typeof body.provider === "string" ? body.provider : (process.env.PI_PROVIDER ?? "");
	const model = typeof body.model === "string" ? body.model : (process.env.PI_MODEL ?? "");
	if (!suiteId || !profile || !provider || !model || !body.task) {
		throw new Error("POST /tasks/run needs suiteId, profile, task, provider, and model.");
	}
	const suite = suiteById(suiteId);
	const task = body.task as EvalTask;
	if (
		typeof task.evalSet !== "string" ||
		typeof task.caseId !== "string" ||
		typeof task.file !== "string" ||
		typeof task.profile !== "string" ||
		typeof task.model !== "string" ||
		!Number.isSafeInteger(task.runNumber)
	) {
		throw new Error("Invalid task in POST /tasks/run.");
	}
	const environment = resolveEnvironment(suite, resolveProfile(suite, profile));
	const target: RuntimeTarget = selectRuntime(environment, {
		backend: typeof body.backend === "string" ? (body.backend as RuntimeBackend) : "host",
		os: typeof body.os === "string" ? (body.os as HostOs) : undefined,
	});
	assertRuntime(target, currentOs);
	const apiBase = typeof body.apiBase === "string" ? body.apiBase : undefined;
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
	const api = typeof body.api === "string" ? body.api : undefined;
	const docker = createDockerContext(
		{},
		artifactDirectory,
		target.backend === "docker" && !apiBase ? requireEvalAuthFile(provider) : "",
		provider,
		model,
		1,
		suiteId,
		{ ...(apiBase ? { apiBase } : {}), ...(apiKey ? { apiKey } : {}), ...(api ? { api } : {}) },
	);
	return runTaskOnRuntime(
		{
			artifactDirectory,
			docker,
			provider,
			model,
			suiteId,
			...(apiBase ? { apiBase } : {}),
			...(apiKey ? { apiKey } : {}),
			...(api ? { api } : {}),
		},
		task,
		target,
		project,
	);
}

const server = createServer(async (request, response) => {
	try {
		if (!authorized(request)) {
			send(response, 401, { error: "Unauthorized." });
			return;
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "GET" && url.pathname === "/health") {
			send(response, 200, {
				ok: true,
				os: currentOs,
				backends: ["docker", "host"],
				suites: Object.keys(SUITE_REGISTRY),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/runs") {
			const body = (await readBody(request, 64 * 1024)) as RunRequest;
			const artifactDirectory = resolve(
				packageRoot,
				".eval",
				`server-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(16).slice(2)}`,
			);
			mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
			send(response, 200, runSuite(body, artifactDirectory));
			return;
		}
		if (request.method === "POST" && url.pathname === "/tasks/run") {
			const body = (await readBody(request, 1024 * 1024)) as Record<string, unknown>;
			const artifactDirectory = resolve(
				packageRoot,
				".eval",
				`task-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(16).slice(2)}`,
			);
			mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
			send(response, 200, await runOneTask(body, artifactDirectory));
			return;
		}
		send(response, 404, { error: "Unknown endpoint." });
	} catch (error) {
		send(response, 400, { error: error instanceof Error ? error.message : String(error) });
	}
});

const port = Number(process.env.PI_EVAL_RUNNER_PORT ?? 8787);
server.listen(port, () => console.log(`Pi eval runner listening on http://localhost:${port} (os=${currentOs})`));
