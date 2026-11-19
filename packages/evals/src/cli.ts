/**
 * Host orchestrator: selects a suite, plans the full cohort, runs each arm in a
 * fresh container, writes observations and traces, then the report and datasets.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	describeSuite,
	type ExportSpec,
	type HostOs,
	type RuntimeBackend,
	resolveEnvironment,
	resolveProfile,
	validateSuite,
} from "./config.ts";
import { exportTraceRecords } from "./dataset.ts";
import { buildImages, createDockerContext, discoverCases, environmentKey, requireEvalAuthFile } from "./docker.ts";
import { createTaskPlan, type DiscoveredEvalCase, parseDiscoveredCases } from "./plan.ts";
import { suiteById } from "./profile-env.ts";
import { type EvalObservation, formatEvalComparisonReport, summarizeEvalObservations } from "./report.ts";
import { assertRuntime, type RuntimeTarget, runTaskOnRuntime, selectRuntime } from "./runtime.ts";
import type { TraceRecord } from "./trace.ts";

type EvalCliOptions = {
	suiteId: string;
	provider?: string;
	model?: string;
	runs?: number;
	profiles: string[];
	tasks: string[];
	families: string[];
	domains: string[];
	requestedFiles: string[];
	discoveryArgs: string[];
	exports: ExportSpec[];
	backend?: RuntimeBackend;
	os?: HostOs;
	runner?: string;
	apiBase?: string;
	apiKey?: string;
	api?: string;
	artifactDirectory?: string;
};

const VALUE_OPTIONS = new Set([
	"--suite",
	"--provider",
	"--model",
	"--runs",
	"--profile",
	"--task",
	"--family",
	"--domain",
	"--export",
	"--backend",
	"--os",
	"--runner",
	"--api-base",
	"--api-key",
	"--api",
	"--artifact-dir",
]);
const FILTER_OPTIONS = new Set(["-t", "--testNamePattern"]);
const DATASET_FORMATS = new Set(["messages", "sharegpt", "alpaca", "rendered"]);

function addValues(target: string[], value: string): void {
	for (const item of value.split(",")) {
		const trimmed = item.trim();
		if (trimmed && !target.includes(trimmed)) target.push(trimmed);
	}
}

function parseExport(value: string): ExportSpec {
	const separator = value.indexOf(":");
	const format = separator === -1 ? value : value.slice(0, separator);
	const file = separator === -1 ? undefined : value.slice(separator + 1);
	if (!DATASET_FORMATS.has(format)) {
		throw new TypeError(`Unknown dataset format "${format}". Known: ${[...DATASET_FORMATS].join(", ")}.`);
	}
	if (file !== undefined && !file.trim()) throw new TypeError("--export needs a file name after the colon.");
	return { format: format as ExportSpec["format"], ...(file ? { file } : {}) };
}

function parseBackend(value: string): RuntimeBackend {
	if (value === "docker" || value === "host" || value === "remote") return value;
	throw new TypeError(`Unknown backend "${value}". Known: docker, host, remote.`);
}

function parseOs(value: string): HostOs {
	if (value === "linux" || value === "windows" || value === "macos") return value;
	throw new TypeError(`Unknown os "${value}". Known: linux, windows, macos.`);
}

function parseEvalCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): EvalCliOptions {
	let suiteId = environment.PI_EVAL_SUITE?.trim() || "docs";
	let provider: string | undefined;
	let model: string | undefined;
	let runsText: string | undefined;
	let cliSelectedModel = false;
	const profiles: string[] = [];
	const tasks: string[] = [];
	const families: string[] = [];
	const domains: string[] = [];
	const requestedFiles: string[] = [];
	const discoveryArgs: string[] = [];
	const exports: ExportSpec[] = [];

	let artifactDirectory: string | undefined;
	let backend: RuntimeBackend | undefined;
	let os: HostOs | undefined;
	let runner: string | undefined;
	let apiBase: string | undefined;
	let apiKey: string | undefined;
	let api: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument.endsWith(".eval.ts")) {
			requestedFiles.push(argument);
			continue;
		}
		if (FILTER_OPTIONS.has(argument)) {
			const value = args[index + 1];
			if (!value) throw new Error(`Missing value for ${argument}.`);
			discoveryArgs.push(argument, value);
			index += 1;
			continue;
		}
		if (argument.startsWith("--testNamePattern=")) {
			if (argument.length === "--testNamePattern=".length) throw new Error("Missing value for --testNamePattern.");
			discoveryArgs.push(argument);
			continue;
		}

		const equals = argument.indexOf("=");
		const name = equals === -1 ? argument : argument.slice(0, equals);
		if (VALUE_OPTIONS.has(name)) {
			const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
			if (!value || (equals === -1 && value.startsWith("-"))) throw new Error(`Missing value for ${name}.`);
			if (name === "--suite") suiteId = value.trim();
			else if (name === "--provider") provider = value.trim();
			else if (name === "--model") model = value.trim();
			else if (name === "--runs") runsText = value.trim();
			else if (name === "--profile") addValues(profiles, value);
			else if (name === "--task") addValues(tasks, value);
			else if (name === "--family") addValues(families, value);
			else if (name === "--domain") addValues(domains, value);
			else if (name === "--backend") backend = parseBackend(value.trim());
			else if (name === "--os") os = parseOs(value.trim());
			else if (name === "--runner") runner = value.trim();
			else if (name === "--api-base") apiBase = value.trim();
			else if (name === "--api-key") apiKey = value.trim();
			else if (name === "--api") api = value.trim();
			else if (name === "--artifact-dir") artifactDirectory = resolve(value.trim());
			else exports.push(parseExport(value.trim()));
			if (name === "--provider" || name === "--model") cliSelectedModel = true;
			if (equals === -1) index += 1;
			continue;
		}
		throw new Error(`Unsupported eval argument: ${argument}`);
	}

	apiBase = apiBase ?? environment.PI_EVAL_API_BASE?.trim();
	apiKey = apiKey ?? environment.PI_EVAL_API_KEY?.trim();
	api = api ?? (environment.PI_EVAL_API?.trim() || "openai-completions");
	if (!cliSelectedModel) {
		provider = environment.PI_PROVIDER?.trim() || undefined;
		model = environment.PI_MODEL?.trim() || undefined;
	}
	if (apiBase && !provider) provider = environment.PI_EVAL_API_PROVIDER?.trim() || "pi-eval-local";
	if (!provider || !model) {
		throw new Error("Set a provider and model, or provide --api-base with a model.");
	}

	const configuredRuns = runsText ?? environment.PI_EVAL_RUNS?.trim();
	const runs = configuredRuns ? Number(configuredRuns) : undefined;
	if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1)) {
		throw new Error("Runs must be a positive integer.");
	}

	return {
		suiteId,
		provider,
		model,
		runs,
		profiles,
		tasks,
		families,
		domains,
		requestedFiles,
		discoveryArgs,
		exports,
		backend,
		os,
		runner,
		apiBase,
		apiKey,
		api,
		artifactDirectory,
	};
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function containerPath(path: string): string {
	const absolute = resolve(packageRoot, path);
	const packageRelative = relative(packageRoot, absolute);
	if (packageRelative.startsWith("..")) throw new Error(`Eval file must be inside ${packageRoot}: ${path}`);
	return packageRelative.replaceAll("\\", "/");
}

function normalizeDiscoveredFile(path: string): string {
	const prefix = "/repo/packages/evals/";
	if (!path.startsWith(prefix)) throw new Error(`Discovered eval path is outside the container package: ${path}`);
	return path.slice(prefix.length);
}

function compareDiscovery(left: readonly DiscoveredEvalCase[], right: readonly DiscoveredEvalCase[]): void {
	const identities = (cases: readonly DiscoveredEvalCase[]) =>
		cases.map(({ fullName, file }) => JSON.stringify([fullName, normalizeDiscoveredFile(file)])).sort();
	if (JSON.stringify(identities(left)) !== JSON.stringify(identities(right))) {
		throw new Error("Environments discovered different eval cases.");
	}
}

const cli = parseEvalCli(process.argv.slice(2));
if (!cli.provider || !cli.model) throw new Error("Set PI_PROVIDER and PI_MODEL, or pass --provider and --model.");
const suite = validateSuite(suiteById(cli.suiteId));
const selectedProfiles = suite.profiles
	.map(({ id }) => id)
	.filter((id) => cli.profiles.length === 0 || cli.profiles.includes(id));
if (selectedProfiles.length === 0) throw new Error("No profile matched --profile.");
for (const id of cli.profiles) {
	if (!selectedProfiles.includes(id)) throw new Error(`Suite "${suite.id}" has no profile "${id}".`);
}
if (suite.comparison) {
	for (const id of [suite.comparison.control, suite.comparison.treatment]) {
		if (!selectedProfiles.includes(id)) throw new Error(`Comparison requires profile "${id}".`);
	}
}
const modelIdentity = `${cli.provider}/${cli.model}`;
const runs = cli.runs ?? suite.runs ?? 1;

const declarative = (suite.tasks?.length ?? 0) > 0;
const project = suite.project ?? (declarative ? "suite" : "docs");
const targetsByProfile = new Map<string, RuntimeTarget>(
	selectedProfiles.map((id) => [
		id,
		selectRuntime(resolveEnvironment(suite, resolveProfile(suite, id)), {
			backend: cli.backend,
			os: cli.os,
			runner: cli.runner,
		}),
	]),
);
for (const target of targetsByProfile.values()) assertRuntime(target);
if (!declarative && [...targetsByProfile.values()].some(({ backend }) => backend !== "docker")) {
	throw new Error("Code eval files require the docker backend. Use a declarative suite for host or remote runs.");
}

let cases: DiscoveredEvalCase[] = [];
let files: string[];
if (declarative) {
	if (cli.requestedFiles.length > 0) throw new Error("Positional eval files are not valid for declarative suites.");
	if (cli.discoveryArgs.length > 0) throw new Error("--testNamePattern is not valid for declarative suites.");
	files = ["evals/suite.eval.ts"];
	cases = (suite.tasks ?? [])
		.filter(
			(task) =>
				(cli.tasks.length === 0 ||
					cli.tasks.includes(task.id) ||
					cli.tasks.includes(`${task.evalSet}>${task.id}`)) &&
				(cli.families.length === 0 || (task.family !== undefined && cli.families.includes(task.family))) &&
				(cli.domains.length === 0 || (task.domain !== undefined && cli.domains.includes(task.domain))),
		)
		.map((task) => ({
			file: files[0],
			fullName: `${task.evalSet} > ${task.id}`,
			evalSet: task.evalSet,
			caseId: task.id,
			...(task.family ? { family: task.family } : {}),
			...(task.domain ? { domain: task.domain } : {}),
		}));
	if (cases.length === 0) throw new Error("No task matched --task, --family, or --domain.");
} else {
	if (cli.tasks.length > 0) throw new Error("--task is only valid for declarative suites.");
	if (cli.families.length > 0) throw new Error("--family is only valid for declarative suites.");
	if (cli.domains.length > 0) throw new Error("--domain is only valid for declarative suites.");
	files = (cli.requestedFiles.length > 0 ? cli.requestedFiles : (suite.evalFiles ?? [])).map(containerPath).sort();
	if (files.length === 0) throw new Error(`Suite "${suite.id}" has no eval files.`);
	for (const file of files) {
		if (!file.endsWith(".eval.ts")) throw new Error(`Suite runner cannot execute non-eval file: ${file}`);
	}
}

const artifactDirectory =
	cli.artifactDirectory ??
	resolve(packageRoot, ".eval", `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`);
const dockerTargets = [...targetsByProfile.values()].filter(({ backend }) => backend === "docker");
const authPath = dockerTargets.length > 0 && !cli.apiBase ? requireEvalAuthFile(cli.provider) : "";
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

const images = buildImages(
	[...new Set(dockerTargets.map(({ environment }) => environmentKey(environment)))].map(
		(key) => dockerTargets.find(({ environment }) => environmentKey(environment) === key)?.environment,
	),
);
const docker = createDockerContext(images, artifactDirectory, authPath, cli.provider, cli.model, runs, suite.id, {
	...(cli.apiBase ? { apiBase: cli.apiBase } : {}),
	...(cli.apiKey ? { apiKey: cli.apiKey } : {}),
	...(cli.api ? { api: cli.api } : {}),
});

if (!declarative) {
	const discoveries: DiscoveredEvalCase[][] = [];
	for (const id of [
		...new Set(selectedProfiles.map((profile) => environmentKey(targetsByProfile.get(profile)?.environment))),
	]) {
		const profile = selectedProfiles.find(
			(candidate) => environmentKey(targetsByProfile.get(candidate)?.environment) === id,
		);
		if (!profile) throw new Error(`No profile for environment "${id}".`);
		const path = discoverCases(
			docker,
			targetsByProfile.get(profile)?.environment,
			profile,
			project,
			files,
			cli.discoveryArgs,
		);
		discoveries.push(
			parseDiscoveredCases(JSON.parse(await readFile(path, "utf8"))).map((evalCase) => ({
				...evalCase,
				file: normalizeDiscoveredFile(evalCase.file),
			})),
		);
	}
	for (const discovery of discoveries.slice(1)) compareDiscovery(discoveries[0], discovery);
	cases = discoveries[0];
	if (cases.length === 0) throw new Error("No eval cases matched the selection.");
}

const tasks = createTaskPlan(cases, selectedProfiles, modelIdentity, runs);
const protocol = {
	schemaVersion: 2,
	suite: describeSuite(suite),
	families: cli.families,
	domains: cli.domains,
	model: modelIdentity,
	runs,
	profiles: selectedProfiles,
	runtimes: Object.fromEntries(
		[...targetsByProfile].map(([profile, target]) => [
			profile,
			{
				backend: target.backend,
				os: target.os,
				...(target.runnerUrl ? { runner: target.runnerUrl } : {}),
				environment: target.environment?.id ?? null,
			},
		]),
	),
	images,
	files,
	cases: cases.map(({ evalSet, caseId, file }) => ({ evalSet, caseId, file })),
	tasks,
};
const protocolDigest = createHash("sha256").update(JSON.stringify(protocol)).digest("hex");
await writeFile(
	resolve(artifactDirectory, "protocol.json"),
	`${JSON.stringify({ ...protocol, protocolDigest }, null, 2)}\n`,
);
await writeFile(resolve(artifactDirectory, "expected-runs.json"), `${JSON.stringify(tasks, null, 2)}\n`);

const observations: EvalObservation[] = [];
const traces: TraceRecord[] = [];
for (const [index, task] of tasks.entries()) {
	console.log(
		`\n[${index + 1}/${tasks.length}] ${task.evalSet} > ${task.caseId} | ${task.profile} | ${task.model} | run ${task.runNumber}`,
	);
	const target = targetsByProfile.get(task.profile);
	if (!target) throw new Error(`No runtime target for profile "${task.profile}".`);
	const result = await runTaskOnRuntime(
		{
			artifactDirectory,
			docker,
			provider: cli.provider,
			model: cli.model,
			suiteId: suite.id,
			...(cli.apiBase ? { apiBase: cli.apiBase } : {}),
			...(cli.apiKey ? { apiKey: cli.apiKey } : {}),
			...(cli.api ? { api: cli.api } : {}),
		},
		task,
		target,
		project,
	);
	observations.push(result.observation);
	if (result.trace) traces.push(result.trace);
	await writeFile(
		resolve(artifactDirectory, "observations.jsonl"),
		`${observations.map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
	await writeFile(
		resolve(artifactDirectory, "traces.jsonl"),
		`${traces.map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
}

const report = summarizeEvalObservations(
	{
		protocolDigest,
		suite: suite.id,
		profiles: selectedProfiles,
		...(suite.comparison ? { comparison: suite.comparison } : {}),
	},
	tasks,
	observations,
);
const reportText = formatEvalComparisonReport(report);
await writeFile(resolve(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(artifactDirectory, "report.txt"), `${reportText}\n`);

const exportSpecs: ExportSpec[] = [...(suite.exports ?? []), ...cli.exports];
for (const spec of exportSpecs) {
	const dataset = exportTraceRecords(traces, spec);
	await writeFile(
		resolve(artifactDirectory, dataset.file),
		dataset.lines.length > 0 ? `${dataset.lines.join("\n")}\n` : "",
	);
	console.log(
		`Dataset ${dataset.format}: ${dataset.lines.length} records, ${dataset.skipped} skipped -> ${dataset.file}`,
	);
}

console.log(`\n${reportText}`);
console.log(`\nArtifacts: ${artifactDirectory}`);
if (report.blockedPairs.length > 0) process.exitCode = 1;
