/**
 * Host orchestrator: selects a suite, plans the full cohort, runs each arm in a
 * fresh container, writes observations and traces, then the report and datasets.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, relative, resolve } from "node:path";
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
import { writeInspectLog } from "./inspect-log.ts";
import { createTaskPlan, type DiscoveredEvalCase, parseDiscoveredCases } from "./plan.ts";
import { suiteById } from "./profile-env.ts";
import { type EvalObservation, formatEvalComparisonReport, summarizeEvalObservations } from "./report.ts";
import { assertRuntime, type RuntimeTarget, runTaskOnRuntime, selectRuntime } from "./runtime.ts";
import type { TraceRecord } from "./trace.ts";

type PackageMode = "full" | "bare";

/** The notebook-supplied runtime freeze file. Extra keys are kept verbatim in protocol.json. */
type ToolchainInfo = {
	modelDigest?: string;
	ollamaVersion?: string;
	numCtx?: number;
	kvCacheType?: string;
	flashAttention?: boolean;
	gpuSplit?: string;
	gitCommit?: string;
	pythonVersion?: string;
	nodeVersion?: string;
	[key: string]: unknown;
};

/** Optional per-run termination facts carried by an upstream vitest report. */
type RuntimeOutcomeExtras = {
	finishReason?: string;
	finish_reason?: string;
	truncated?: boolean;
	isTruncated?: boolean;
};

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
	temperature?: number;
	topP?: number;
	presencePenalty?: number;
	maxTokens?: number;
	seed?: number;
	ocrMode?: "vision" | "tesseract";
	packageMap?: Map<string, PackageMode>;
	toolchain?: ToolchainInfo;
	modelDigest?: string;
	pilot: boolean;
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
	"--temperature",
	"--top-p",
	"--presence-penalty",
	"--max-tokens",
	"--seed",
	"--ocr-mode",
	"--package-map",
	"--toolchain-file",
	"--model-digest",
]);
const FLAG_OPTIONS = new Set(["--pilot"]);
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

function parseOcrMode(value: string): "vision" | "tesseract" {
	if (value === "vision" || value === "tesseract") return value;
	throw new TypeError(`Unknown ocr mode "${value}". Known: vision, tesseract.`);
}

function parseNumberOption(name: string, value: string): number {
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
	return parsed;
}

function parsePackageMap(value: string): Map<string, PackageMode> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("--package-map must be a JSON object.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("--package-map must be a JSON object.");
	}
	const map = new Map<string, PackageMode>();
	for (const [taskId, mode] of Object.entries(parsed)) {
		if (mode !== "full" && mode !== "bare") {
			throw new Error(`--package-map value for "${taskId}" must be "full" or "bare".`);
		}
		map.set(taskId, mode);
	}
	return map;
}

function parseToolchainFile(path: string): ToolchainInfo {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot read --toolchain-file ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("--toolchain-file must contain a JSON object.");
	}
	return parsed as ToolchainInfo;
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
	let temperature: number | undefined;
	let topP: number | undefined;
	let presencePenalty: number | undefined;
	let maxTokens: number | undefined;
	let seed: number | undefined;
	let ocrMode: "vision" | "tesseract" | undefined;
	let packageMap: Map<string, PackageMode> | undefined;
	let toolchain: ToolchainInfo | undefined;
	let modelDigest: string | undefined;
	let pilot = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (FLAG_OPTIONS.has(argument)) {
			pilot = true;
			continue;
		}
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
			else if (name === "--temperature") temperature = parseNumberOption(name, value);
			else if (name === "--top-p") topP = parseNumberOption(name, value);
			else if (name === "--presence-penalty") presencePenalty = parseNumberOption(name, value);
			else if (name === "--max-tokens") maxTokens = parseNumberOption(name, value);
			else if (name === "--seed") seed = parseNumberOption(name, value);
			else if (name === "--ocr-mode") ocrMode = parseOcrMode(value.trim());
			else if (name === "--package-map") packageMap = parsePackageMap(value);
			else if (name === "--toolchain-file") toolchain = parseToolchainFile(value.trim());
			else if (name === "--model-digest") modelDigest = value.trim();
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
	if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
		throw new Error("--max-tokens must be a positive integer.");
	}
	if (seed !== undefined && !Number.isSafeInteger(seed)) {
		throw new Error("--seed must be an integer.");
	}
	if (pilot) presencePenalty = 0;

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
		temperature,
		topP,
		presencePenalty,
		maxTokens,
		seed,
		ocrMode,
		packageMap,
		toolchain,
		modelDigest,
		pilot,
	};
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
/** Kaggle creates the two venvs here; PI_EVAL_VENV_ROOT allows a different checkout. */
const VENV_ROOT = process.env.PI_EVAL_VENV_ROOT?.trim() || "/kaggle/working/venvs";

function readGitCommit(): string | null {
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repositoryRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || null
		);
	} catch {
		return null;
	}
}

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

if (cli.pilot) cases = cases.slice(0, 1);

const toolchain = cli.toolchain ?? {};
const sampling = {
	temperature: cli.temperature ?? null,
	topP: cli.topP ?? null,
	presencePenalty: cli.presencePenalty ?? null,
	maxTokens: cli.maxTokens ?? null,
	seed: cli.seed ?? null,
};
const runtimeMetadata = {
	modelTag: cli.model,
	modelDigest: cli.modelDigest ?? toolchain.modelDigest ?? null,
	ollamaVersion: toolchain.ollamaVersion ?? null,
	numCtx: toolchain.numCtx ?? null,
	kvCacheType: toolchain.kvCacheType ?? null,
	flashAttention: toolchain.flashAttention ?? null,
	gpuSplit: toolchain.gpuSplit ?? null,
	gitCommit: readGitCommit() ?? toolchain.gitCommit ?? null,
};
const selectedPackageMap = cli.packageMap;
const packageModes = selectedPackageMap
	? Object.fromEntries(cases.map(({ caseId }) => [caseId, selectedPackageMap.get(caseId) ?? null]))
	: null;
console.log(
	`Protocol: ${modelIdentity} | pilot ${cli.pilot} | sampling ${JSON.stringify(sampling)} | ocr ${cli.ocrMode ?? "unset"}`,
);

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
	sampling,
	ocrMode: cli.ocrMode ?? null,
	pilot: cli.pilot,
	runtime: runtimeMetadata,
	toolchain,
	packageModes,
	venvRoot: selectedPackageMap ? VENV_ROOT : null,
};
await writeFile(resolve(artifactDirectory, "expected-runs.json"), `${JSON.stringify(tasks, null, 2)}\n`);

const observations: EvalObservation[] = [];
const traces: TraceRecord[] = [];
const basePath = process.env.PATH ?? "";
for (const [index, task] of tasks.entries()) {
	console.log(
		`\n[${index + 1}/${tasks.length}] ${task.evalSet} > ${task.caseId} | ${task.profile} | ${task.model} | run ${task.runNumber}`,
	);
	const target = targetsByProfile.get(task.profile);
	if (!target) throw new Error(`No runtime target for profile "${task.profile}".`);
	// Child processes copy process.env at spawn time, so this pins the venv for this arm only.
	const packageMode = selectedPackageMap?.get(task.caseId);
	process.env.PATH = packageMode ? `${resolve(VENV_ROOT, packageMode, "bin")}${delimiter}${basePath}` : basePath;
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

const runOutcomes = observations.map((observation) => {
	const extras = observation as EvalObservation & RuntimeOutcomeExtras;
	const error = observation.outcome === "errored" ? observation.error : undefined;
	return {
		evalSet: observation.evalSet,
		caseId: observation.caseId,
		profile: observation.profile,
		model: observation.model,
		runNumber: observation.runNumber,
		outcome: observation.outcome,
		score: observation.outcome === "scored" ? observation.score : null,
		finishReason: extras.finishReason ?? extras.finish_reason ?? null,
		truncated: extras.truncated ?? extras.isTruncated ?? null,
		// hasValidReward distinguishes measured model failures from infra retries (src/error-policy.ts).
		errorClass: error ? (error.policy.hasValidReward ? "model" : "infra") : null,
		errorKind: error?.kind ?? null,
	};
});
const finalProtocol = { ...protocol, runOutcomes };
const protocolDigest = createHash("sha256").update(JSON.stringify(finalProtocol)).digest("hex");
await writeFile(
	resolve(artifactDirectory, "protocol.json"),
	`${JSON.stringify({ ...finalProtocol, protocolDigest }, null, 2)}\n`,
);
const perRunScores = {
	schemaVersion: 1,
	suite: suite.id,
	model: modelIdentity,
	runs,
	pilot: cli.pilot,
	scoring: sampling,
	scores: runOutcomes,
};
await writeFile(resolve(artifactDirectory, "per-run-scores.json"), `${JSON.stringify(perRunScores, null, 2)}\n`);

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
const scoresHeader = "caseId | profile | run | outcome | score | errorClass | finishReason | truncated";
const scoresRows = runOutcomes.map((item) =>
	[
		item.caseId,
		item.profile,
		item.runNumber,
		item.outcome,
		item.score ?? "-",
		item.errorClass ?? "-",
		item.finishReason ?? "-",
		item.truncated ?? "-",
	].join(" | "),
);
const scoresText = `\nPer-run scores (N=${runs}, pilot=${cli.pilot})\n${scoresHeader}\n${scoresRows.join("\n")}\n`;
await writeFile(
	resolve(artifactDirectory, "report.json"),
	`${JSON.stringify({ ...report, perRunScores: runOutcomes }, null, 2)}\n`,
);
await writeFile(resolve(artifactDirectory, "report.txt"), `${reportText}\n${scoresText}`);
await writeInspectLog(resolve(artifactDirectory, "inspect-log.json"), {
	protocol: { ...finalProtocol, protocolDigest },
	observations,
	traces,
	report,
});

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
console.log(scoresText);
console.log(`\nArtifacts: ${artifactDirectory}`);
if (report.blockedPairs.length > 0) process.exitCode = 1;
