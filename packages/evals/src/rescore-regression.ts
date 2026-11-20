/**
 * D9 evidence: re-score the 19 traces from the first baseline with the current
 * judges and publish old vs new scores. The old artifacts have no workspace
 * snapshot, so workspace/grounded file checks cannot be reconstructed; those
 * axes are reported as unavailable rather than silently scored as zero.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractionSuite } from "../evals/suites/extraction.ts";
import type { JudgeSpec } from "./config.ts";
import { type Assessment, assessSpec } from "./judge-logic.ts";
import { PI_TRACE_ARTIFACT, parseTraceArtifact, type TraceRecord } from "./trace.ts";

export type RegressionRow = {
	caseId: string;
	runNumber: number;
	oldScore: number | null;
	newScore: number | null;
	delta: number | null;
	axes: string;
	notes: string;
};

type OldObservation = { caseId: string; runNumber: number; outcome: string; score?: number };

function finalAnswer(trace: TraceRecord): string {
	const last = trace.messages.filter((message) => message.role === "assistant").at(-1);
	return last && last.role === "assistant" ? last.content : "";
}

function axisName(spec: JudgeSpec, index: number): string {
	if (spec.type === "grounded" && spec.name) return spec.name;
	return `${spec.type}-${index}`;
}

/** Re-score traces found in an artifact directory against the extraction suite judges. */
export function rescoreRegression(artifactDirectory: string): {
	rows: RegressionRow[];
	csv: string;
	checks: Array<{ id: string; ok: boolean; detail: string }>;
} {
	const observations = new Map<string, OldObservation>();
	const observationPath = join(artifactDirectory, "observations.jsonl");
	if (existsSyncLocal(observationPath)) {
		for (const line of readFileSync(observationPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const item = JSON.parse(line) as OldObservation;
			observations.set(`${item.caseId}/${item.runNumber}`, item);
		}
	}

	const traces = new Map<string, TraceRecord>();
	for (const line of readFileSync(join(artifactDirectory, "traces.jsonl"), "utf8").split("\n")) {
		if (!line.trim()) continue;
		const trace = parseTraceArtifact(line);
		if (!trace) continue;
		const metadata = trace.metadata;
		if (!metadata.caseId || metadata.runNumber === undefined) continue;
		traces.set(`${metadata.caseId}/${metadata.runNumber}`, trace);
	}

	const rows: RegressionRow[] = [];
	for (const [key, trace] of [...traces].sort(([a], [b]) => a.localeCompare(b))) {
		const task = extractionSuite.tasks?.find((candidate) => candidate.id === trace.metadata.caseId);
		const old = observations.get(key);
		if (!task) {
			rows.push({
				caseId: trace.metadata.caseId ?? key,
				runNumber: trace.metadata.runNumber ?? 0,
				oldScore: old?.score ?? null,
				newScore: null,
				delta: null,
				axes: "",
				notes: "no matching task spec",
			});
			continue;
		}
		const artifacts: Record<string, string> = { [PI_TRACE_ARTIFACT]: JSON.stringify(trace) };
		const scores: Array<{ name: string; value: number | null }> = [];
		const specs = task.judges ?? [];
		const results: Array<Assessment> = [];
		let hasMissingSnapshot = false;
		for (const [index, spec] of specs.entries()) {
			const needsSnapshot =
				spec.type === "workspace" ||
				(spec.type === "grounded" &&
					Boolean(
						(spec.requireFiles?.length ?? 0) + (spec.forbidFiles?.length ?? 0) + (spec.forbidText?.length ?? 0),
					));
			if (needsSnapshot) {
				hasMissingSnapshot = true;
				scores.push({ name: axisName(spec, index), value: null });
				continue;
			}
			try {
				const result = assessSpec(spec, { output: finalAnswer(trace), artifacts });
				results.push(result);
				scores.push({ name: axisName(spec, index), value: result.score });
			} catch {
				scores.push({ name: axisName(spec, index), value: null });
			}
		}
		const measured = scores.filter((score): score is { name: string; value: number } => score.value !== null);
		const newScore =
			measured.length > 0 ? measured.reduce((sum, score) => sum + score.value, 0) / measured.length : null;
		const oldScore = old?.score ?? null;
		rows.push({
			caseId: trace.metadata.caseId ?? key,
			runNumber: trace.metadata.runNumber ?? 0,
			oldScore,
			newScore,
			delta: oldScore !== null && newScore !== null ? Number((newScore - oldScore).toFixed(4)) : null,
			axes: scores
				.map((score) => `${score.name}=${score.value === null ? "n/a" : score.value.toFixed(4)}`)
				.join(";"),
			notes: hasMissingSnapshot ? "workspace/grounded fs axes unavailable (no snapshot in old artifacts)" : "",
		});
	}

	const header = "caseId,runNumber,oldScore,newScore,delta,axes,notes";
	const csv = `${[
		header,
		...rows.map((row) =>
			[
				row.caseId,
				row.runNumber,
				row.oldScore ?? "",
				row.newScore ?? "",
				row.delta ?? "",
				`"${row.axes}"`,
				`"${row.notes}"`,
			].join(","),
		),
	].join("\n")}\n`;

	const byCase = (caseId: string) => rows.filter((row) => row.caseId === caseId);
	const tax = byCase("tax-pack-real");
	const tax2 = tax.find((row) => row.runNumber === 2);
	const tax3 = tax.find((row) => row.runNumber === 3);
	const tax5 = tax.find((row) => row.runNumber === 5);
	const oven1 = byCase("oven-payment-real").find((row) => row.runNumber === 1);
	const greedy = byCase("make-it-greppable-real").find((row) => row.runNumber === 3);
	const checks = [
		{ id: "trace_count", ok: rows.length === 19, detail: `${rows.length} traces rescored` },
		{
			id: "tax_r2_down",
			ok: tax2?.newScore !== undefined && tax2.newScore !== null && tax2.newScore < (tax2.oldScore ?? 1),
			detail: `tax r2 old=${tax2?.oldScore ?? "n/a"} new=${tax2?.newScore ?? "n/a"}`,
		},
		{
			id: "tax_r5_lt_r3",
			ok:
				tax5?.newScore !== null &&
				tax3?.newScore !== null &&
				tax5 !== undefined &&
				tax3 !== undefined &&
				tax5.newScore !== null &&
				tax3.newScore !== null &&
				tax5.newScore < tax3.newScore,
			detail: `tax r5=${tax5?.newScore ?? "n/a"} r3=${tax3?.newScore ?? "n/a"}`,
		},
		{
			id: "greppable_r3_flagged",
			ok: greedy?.axes.toLowerCase().includes("greppablewritegrounded=0") === true,
			detail: `greppable r3 axes=${greedy?.axes ?? "n/a"}`,
		},
		{
			id: "oven_r1_penalized",
			ok:
				oven1 !== undefined &&
				oven1.newScore !== null &&
				oven1.oldScore !== null &&
				oven1.newScore < oven1.oldScore,
			detail: `oven r1 old=${oven1?.oldScore ?? "n/a"} new=${oven1?.newScore ?? "n/a"} axes=${oven1?.axes ?? "n/a"}`,
		},
	];
	return { rows, csv, checks };
}

function existsSyncLocal(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

if (process.argv[1]?.endsWith("rescore-regression.ts")) {
	const source = process.argv[2];
	if (!source) throw new Error("Usage: node --experimental-strip-types src/rescore-regression.ts <artifact-dir>");
	const directory = resolve(source);
	const result = rescoreRegression(directory);
	const outDir = join(directory, "..", "artifacts", "scorer");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "rescore_19.csv"), result.csv);
	writeFileSync(join(outDir, "rescore_19.json"), `${JSON.stringify(result, null, 2)}\n`);
	for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
	console.log(`wrote ${outDir}/rescore_19.csv (${result.rows.length} rows)`);
}
