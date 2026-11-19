/**
 * Offline rescoring: re-grade a finished run from the artifacts the judges
 * originally saw. No agent or model calls are made, so scorer changes can be
 * tested against the same transcripts.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgeSpec } from "./config.ts";
import { classifyError } from "./error-policy.ts";
import { writeInspectLog } from "./inspect-log.ts";
import { assessSpec } from "./judge-logic.ts";
import type { EvalTask } from "./plan.ts";
import { suiteById } from "./profile-env.ts";
import {
	type EvalObservation,
	formatEvalComparisonReport,
	type ReportOptions,
	summarizeEvalObservations,
} from "./report.ts";
import { parseTraceArtifact, type TraceMessage } from "./trace.ts";

type JudgeInput = {
	evalSet: string;
	caseId: string;
	profile: string;
	model: string;
	runNumber: number;
	artifacts: Record<string, string>;
};

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
	return value;
}

function finalAnswer(messages: readonly TraceMessage[]): string {
	const last = messages.filter((message) => message.role === "assistant").at(-1);
	return last && last.role === "assistant" ? last.content : "";
}

function identityKey(value: {
	evalSet: string;
	caseId: string;
	profile: string;
	model: string;
	runNumber: number;
}): string {
	return JSON.stringify([value.evalSet, value.caseId, value.profile, value.model, value.runNumber]);
}

/** Re-score every run in an artifact directory and rewrite report and log files. */
export async function rescoreArtifacts(artifactDirectory: string): Promise<void> {
	const protocol = await readJson(join(artifactDirectory, "protocol.json"));
	const suiteValue = protocol.suite;
	const suiteId =
		typeof suiteValue === "string"
			? suiteValue
			: typeof suiteValue === "object" && suiteValue !== null && "id" in suiteValue
				? requireString((suiteValue as { id: unknown }).id, "protocol.suite.id")
				: "";
	if (!suiteId) throw new TypeError("protocol.suite must name a suite.");
	const protocolDigest = requireString(protocol.protocolDigest, "protocol.protocolDigest");
	const suite = suiteById(suiteId);
	const expected = JSON.parse(await readFile(join(artifactDirectory, "expected-runs.json"), "utf8")) as EvalTask[];
	const observations = (await readFile(join(artifactDirectory, "observations.jsonl"), "utf8"))
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as EvalObservation);

	const inputs = new Map<string, JudgeInput>();
	let inputNames: string[] = [];
	try {
		inputNames = await readdir(join(artifactDirectory, "judge-inputs"));
	} catch {
		inputNames = [];
	}
	for (const name of inputNames) {
		if (!name.endsWith(".json")) continue;
		const value = (await readJson(join(artifactDirectory, "judge-inputs", name))) as unknown as JudgeInput;
		inputs.set(identityKey(value), value);
	}

	const traces = (await readFile(join(artifactDirectory, "traces.jsonl"), "utf8"))
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			const trace = parseTraceArtifact(line);
			return trace ? [trace] : [];
		});

	if (process.env.PI_EVAL_RESCORE_DEBUG) {
		console.error("loaded traces", traces.length, "first metadata", JSON.stringify(traces[0]?.metadata ?? {}));
	}

	const rescore = await Promise.all(
		expected.map(async (task): Promise<EvalObservation> => {
			const previous = observations.find((observation) => identityKey(observation) === identityKey(task));
			const input = inputs.get(identityKey(task));
			if (!previous || !input) {
				if (process.env.PI_EVAL_RESCORE_DEBUG) {
					console.error("missing previous/input", identityKey(task), Boolean(previous), Boolean(input));
				}
				const priorError = previous && "error" in previous ? previous.error : undefined;
				return { ...task, outcome: "errored", ...(priorError ? { error: priorError } : {}) };
			}
			const trace = traces.find((candidate) => {
				const metadata = candidate.metadata;
				return (
					metadata.caseId === task.caseId &&
					metadata.evalSet === task.evalSet &&
					metadata.runNumber === task.runNumber &&
					metadata.profile === task.profile
				);
			});
			const specs: JudgeSpec[] =
				suite.tasks?.find((candidate) => candidate.id === task.caseId && candidate.evalSet === task.evalSet)
					?.judges ?? [];
			if (specs.length === 0 || !trace) {
				if (process.env.PI_EVAL_RESCORE_DEBUG) {
					console.error("missing judges/trace", identityKey(task), specs.length, Boolean(trace));
				}
				return { ...task, outcome: "errored", error: classifyError("VerifierError") };
			}
			const context = { output: finalAnswer(trace.messages), artifacts: input.artifacts };
			let scores: Array<{ score: number }>;
			try {
				scores = specs.map((spec) => assessSpec(spec, context));
			} catch (error) {
				if (process.env.PI_EVAL_RESCORE_DEBUG) console.error("judge error", identityKey(task), error);
				return { ...task, outcome: "errored", error: classifyError("VerifierError") };
			}
			const score = scores.reduce((sum, value) => sum + value.score, 0) / scores.length;
			const metrics = { ...previous } as Record<string, unknown>;
			delete metrics.outcome;
			delete metrics.score;
			delete metrics.error;
			return { ...task, ...metrics, outcome: "scored", score } as EvalObservation;
		}),
	);

	const options: ReportOptions = {
		protocolDigest,
		suite: suiteId,
		profiles: Array.isArray(protocol.profiles) ? (protocol.profiles as string[]) : [],
		comparison: (protocol.comparison as ReportOptions["comparison"]) ?? undefined,
	};
	const report = summarizeEvalObservations(options, expected, rescore);
	await writeFile(
		join(artifactDirectory, "observations.jsonl"),
		`${rescore.map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
	await writeFile(join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(join(artifactDirectory, "report.txt"), `${formatEvalComparisonReport(report)}\n`);
	await writeInspectLog(join(artifactDirectory, "inspect-log.json"), {
		protocol,
		observations: rescore,
		traces,
		report,
	});
	console.log(`Rescored ${rescore.length} runs in ${artifactDirectory}`);
}
