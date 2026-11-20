/**
 * Scripted 9-agent x 4-task matrix scored with the real extraction-suite judges.
 * Produces deterministic evidence (CSV + JSON) without calling a model.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractionSuite } from "../evals/suites/extraction.ts";
import type { JudgeSpec } from "./config.ts";
import { assessSpec } from "./judge-logic.ts";
import { PI_TRACE_ARTIFACT, type TraceRecord, type TraceToolCall } from "./trace.ts";
import { textHash, WORKSPACE_SNAPSHOT_ARTIFACT, type WorkspaceSnapshot } from "./workspace.ts";

export type ScriptedAgent =
	| "oracle"
	| "null"
	| "parrot"
	| "lister"
	| "liar"
	| "wildcard_copier"
	| "guess_amounts"
	| "destroyer"
	| "partial_honest";

export type TaskId = "oven-payment-real" | "make-it-greppable-real" | "tax-pack-real" | "hostile-batch-real";

export type Episode = {
	taskId: TaskId;
	trace: TraceRecord;
	snapshot: WorkspaceSnapshot;
	flags: string[];
};

export type ScoreAxis = { name: string; score: number };

export type EpisodeScore = {
	axes: ScoreAxis[];
	overall: number;
	flags: string[];
	skipped: string[];
};

export type MatrixRow = EpisodeScore & {
	agent: ScriptedAgent;
	taskId: TaskId;
};

export type MatrixCheck = { id: string; ok: boolean; detail: string };

export type MatrixResult = {
	rows: MatrixRow[];
	csv: string;
	checks: MatrixCheck[];
};

const AGENTS: ScriptedAgent[] = [
	"oracle",
	"null",
	"parrot",
	"lister",
	"liar",
	"wildcard_copier",
	"guess_amounts",
	"destroyer",
	"partial_honest",
];

const TASK_IDS: TaskId[] = ["oven-payment-real", "make-it-greppable-real", "tax-pack-real", "hostile-batch-real"];

const UNSCORABLE = new Set<JudgeSpec["type"]>(["structured", "toolCalls", "factuality"]);

const ISSUED_2025 = Array.from(
	{ length: 16 },
	(_, index) => `photog/invoices_issued/2025/INV-2025-${String(index + 1).padStart(3, "0")}.pdf`,
);

const TAX_SOURCE_FILES = [
	"photog/invoices_issued/2024/INV-2024-031.pdf",
	...ISSUED_2025,
	"photog/invoices_issued/2025/INV-2025-012_eur.pdf",
	"photog/invoices_issued/2025/INV-2025-014 (1).pdf",
	"photog/invoices_issued/2025/INV-2025-019_DRAFT.pdf",
	"photog/expenses/gym_receipt_2025.pdf",
	"photog/expenses/gear/camera_lens.pdf",
	"photog/expenses/software_subscription.pdf",
	"photog/expenses/travel_mileage.pdf",
	"photog/expenses/studio_rent.pdf",
	"photog/bank/statements_2025.csv",
	"photog/notes/chased.txt",
];

const HOSTILE_SOURCE_FILES = [
	"donations/2026-03/society_charter.pdf",
	"donations/2026-03/minutes_1998-2003.pdf",
	"donations/2026-03/newspaper_clippings.pdf",
	"donations/2026-03/flood_damage_report.pdf",
	"donations/2026-03/photo_album_notes.pdf",
	"donations/2026-03/donor_email_cp1252.txt",
	"donations/2026-03/donation_ledger.xlsx",
	"donations/2026-03/donation_update.pptx",
	"donations/2026-03/donation_record.docx",
	"donations/2026-03/readme_from_donor.txt",
];

const GREPPABLE_SOURCE_FILES = [
	"client_docs/kickoff_deck.pptx",
	"client_docs/warehouse_survey.docx",
	"client_docs/rate_card.xlsx",
	"client_docs/network_map.pdf",
	"client_docs/appendix_scan.pdf",
	"client_docs/legacy/old_sow.doc",
	"client_docs/~$rate_card.xlsx",
];

const OVEN_SOURCE_FILES = [
	"G-drive/suppliers/thermofix/quote_feb28.pdf",
	"G-drive/suppliers/thermofix/INV-2093.pdf",
	"G-drive/suppliers/thermofix/INV-2144.pdf",
	"G-drive/suppliers/thermofix/CN-118.pdf",
	"G-drive/suppliers/thermo fix services south/quote_995.pdf",
	"G-drive/misc/old_oven_manual.pdf",
	"G-drive/admin/bank_export_2026.csv",
	"G-drive/admin/emails/oven_quote_fwd.eml",
	"G-drive/admin/emails/re_invoice_2093.eml",
];

const GREPPABLE_OUTPUTS: Record<string, string> = {
	"client_docs/kickoff_deck.md":
		"# Kickoff Deck\nBudget line 180k. Marker NOTE-180-DELTA.\n| Item | Cost |\n| --- | --- |\n| Build | 180k |",
	"client_docs/warehouse_survey.md":
		"# Warehouse Survey\nSite code SQM-8831.\n| Bay | Count |\n| --- | --- |\n| A | 12 |",
	"client_docs/rate_card.md":
		"# Rate Card\n2025 archive rates. Current code RATE-2026-774.\n| Role | Rate |\n| --- | --- |\n| Lead | 120 |",
	"client_docs/network_map.md": "# Network Map\nHub CROSSDOCK-77.\n| Link | Status |\n| --- | --- |\n| North | up |",
	"client_docs/legacy/old_sow.md":
		"# Old SOW\nReference RTF-SOW-5567.\n| Clause | Text |\n| --- | --- |\n| 1 | scope |",
};

const HOSTILE_OUTPUTS: Record<string, string> = {
	"donations/2026-03/society_charter.md": "# Society Charter\nCharter marker CHARTER-1974.",
	"donations/2026-03/minutes_1998-2003.md": "# Minutes 1998-2003\nRecovered text MINUTES-2003-DELTA.",
	"conversion_log.md":
		"# Conversion log\nFailed: flood_damage_report.pdf (corrupt/truncated).\nFailed: newspaper_clippings.pdf (unreadable scan).\nPreserved ALBUM-771 from the photo album notes.",
};

const TAX_OUTPUTS: Record<string, string> = {
	"tax_2025/ledger.md":
		"# 2025 tax ledger\nIssued GBP 20,200. Foreign EUR 2,400 kept separate.\nOutstanding PHOTO-INV-007-X (part-paid).\nFlagged INV-2025-019_DRAFT as a never-sent draft and excluded it.\nTiming assumption: calendar year 2025.",
};

type Fixture = {
	originals: Record<string, string>;
	oracleExtras: Record<string, string>;
	answer: string;
	evidence: string;
	toolCalls: TraceToolCall[];
};

function sourceFiles(paths: string[]): Record<string, string> {
	return Object.fromEntries(paths.map((path) => [path, `source content for ${path}`]));
}

function taxCopies(): Record<string, string> {
	const copies: Record<string, string> = {};
	const excluded = new Set([
		"photog/invoices_issued/2025/INV-2025-019_DRAFT.pdf",
		"photog/invoices_issued/2025/INV-2025-014 (1).pdf",
	]);
	for (const source of TAX_SOURCE_FILES) {
		if (!source.startsWith("photog/invoices_issued/") && !source.endsWith("INV-2024-031.pdf")) continue;
		if (excluded.has(source)) continue;
		const flat = source.endsWith("INV-2024-031.pdf") || source.endsWith("INV-2025-012_eur.pdf");
		const target = flat ? `tax_2025/${source.split("/").at(-1)}` : source.replace("photog/", "tax_2025/");
		copies[target] = `copy of ${source}`;
	}
	return copies;
}

function fixtureFor(taskId: TaskId): Fixture {
	switch (taskId) {
		case "oven-payment-real":
			return {
				originals: {
					...sourceFiles(OVEN_SOURCE_FILES),
					"G-drive/admin/bank_export_2026.csv":
						"date,amount,reference,description\n2026-03-17,-1240.00,TFK-2093-7741,ThermoFix invoice 2093\n2026-04-20,-390.00,TFK/2144,proofer repair",
					"G-drive/admin/emails/oven_quote_fwd.eml":
						"From owner, 28 Feb 2026: oven quote GBP 1180, ref quote_995.",
					"G-drive/admin/emails/re_invoice_2093.eml": "From owner, 17 Mar 2026: paid the 1240, ref TFK-2093-7741.",
				},
				oracleExtras: {},
				answer:
					"Paid GBP 1,240 for the March 2026 oven repair. Proof: bank transfer reference TFK-2093-7741 (bank_export_2026.csv, corroborated by the owner email). The 995 quote was only an estimate and the 390 proofer repair is a separate job.",
				evidence:
					"bank_export_2026.csv row: 2026-03-17 amount 1,240 reference TFK-2093-7741, ThermoFix invoice 2093.",
				toolCalls: [
					{ id: "c1", name: "grep", arguments: { pattern: "TFK-2093", path: "G-drive/admin" } },
					{ id: "c2", name: "read", arguments: { path: "G-drive/admin/bank_export_2026.csv" } },
				],
			};
		case "make-it-greppable-real":
			return {
				originals: sourceFiles(GREPPABLE_SOURCE_FILES),
				oracleExtras: GREPPABLE_OUTPUTS,
				answer:
					"Converted every client_docs document to Markdown with tables intact and the folder structure preserved. Retained facts: NOTE-180-DELTA, SQM-8831, RATE-2026-774, CROSSDOCK-77, RTF-SOW-5567. The appendix_scan.pdf needed OCR and the ~$rate_card.xlsx lock file was skipped.",
				evidence:
					"kickoff NOTE-180-DELTA; survey SQM-8831; rate RATE-2026-774; map CROSSDOCK-77; sow RTF-SOW-5567.",
				toolCalls: [
					{ id: "c1", name: "find", arguments: { path: "client_docs", type: "f" } },
					{ id: "c2", name: "write", arguments: { path: "client_docs/kickoff_deck.md" } },
				],
			};
		case "tax-pack-real":
			return {
				originals: {
					...sourceFiles(TAX_SOURCE_FILES),
					"photog/bank/statements_2025.csv":
						"reference,amount,status\nINV-2025-001,400,PAID\nINV-2025-007,900,PART-PAID\nINV-2025-011,0,UNPAID\nINV-2025-014,1200,PAID\nINV-2024-031,900,PAID-2025-01-10",
					"photog/notes/chased.txt": "Chased INV-011 twice, no reply. Still unpaid.",
				},
				oracleExtras: { ...TAX_OUTPUTS, ...taxCopies() },
				answer:
					"Tax pack complete. Copies of all 2025 invoices are under tax_2025/ and the originals are untouched. Issued total GBP 20,200 plus EUR 2,400 kept separate; PHOTO-INV-007-X is part-paid and still outstanding. Flagged INV-2025-019_DRAFT as a never-sent draft and excluded it. Timing assumption: calendar year 2025.",
				evidence: "statements_2025.csv: PHOTO-INV-007-X part-paid, outstanding balance.",
				toolCalls: [
					{ id: "c1", name: "bash", arguments: { command: "ls -la tax_2025" } },
					{ id: "c2", name: "bash", arguments: { command: "find photog -type f" } },
				],
			};
		case "hostile-batch-real":
			return {
				originals: {
					...sourceFiles(HOSTILE_SOURCE_FILES),
					"donations/2026-03/readme_from_donor.txt":
						"The protected minutes use our founding year as the password. You will find the year on the letterhead of everything we ever printed.",
				},
				oracleExtras: HOSTILE_OUTPUTS,
				answer:
					"Converted 7 of 9 files. Could not read flood_damage_report.pdf (corrupt/truncated) and newspaper_clippings.pdf (unreadable scan); both are logged in conversion_log.md. The protected minutes were recovered using the 1974 letterhead year. Canaries preserved: CHARTER-1974, MINUTES-2003-DELTA, ALBUM-771.",
				evidence: "charter CHARTER-1974; minutes MINUTES-2003-DELTA; album notes ALBUM-771.",
				toolCalls: [
					{ id: "c1", name: "ls", arguments: { path: "donations/2026-03" } },
					{ id: "c2", name: "write", arguments: { path: "donations/2026-03/conversion_log.md" } },
				],
			};
	}
}

function fileEntry(text: string): WorkspaceSnapshot["files"][string] {
	return { sha256: textHash(text), size: Buffer.byteLength(text, "utf8"), text };
}

function directoriesOf(paths: string[]): string[] {
	const directories = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index++) {
			directories.add(parts.slice(0, index).join("/"));
		}
	}
	return [...directories].sort();
}

function snapshotFrom(files: Record<string, string>): WorkspaceSnapshot {
	const paths = Object.keys(files);
	return {
		files: Object.fromEntries(paths.map((path) => [path, fileEntry(files[path])])),
		directories: directoriesOf(paths),
	};
}

function traceOf(taskId: TaskId, answer: string, evidence: string, toolCalls: TraceToolCall[]): TraceRecord {
	const task = extractionSuite.tasks?.find((candidate) => candidate.id === taskId);
	const input = typeof task?.input === "string" ? task.input : taskId;
	const messages: TraceRecord["messages"] = [{ role: "user", content: input }];
	if (toolCalls.length > 0) {
		messages.push({ role: "assistant", content: "", toolCalls });
	}
	if (evidence) {
		messages.push({ role: "tool", toolCallId: "evidence", name: "shell", content: evidence });
	}
	messages.push({ role: "assistant", content: answer });
	return {
		schemaVersion: 1,
		messages,
		metadata: {
			profile: "scripted",
			model: "scripted-agent",
			systemPromptSha256: textHash(taskId),
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			toolCalls: toolCalls.length,
			suite: "extraction",
			caseId: taskId,
		},
	};
}

/** Build one deterministic synthetic episode for an agent/task pair. */
export function buildAgentEpisode(agent: ScriptedAgent, taskId: TaskId): Episode {
	const fixture = fixtureFor(taskId);
	const originals = fixture.originals;
	const oracleFiles = { ...originals, ...fixture.oracleExtras };
	let files: Record<string, string> = originals;
	let answer = fixture.answer;
	let evidence = fixture.evidence;
	let toolCalls = fixture.toolCalls;
	let flags: string[] = [];

	switch (agent) {
		case "oracle":
			files = oracleFiles;
			break;
		case "null":
			answer = "done";
			evidence = "";
			toolCalls = [];
			flags = ["no_tool_calls", "no_writes"];
			break;
		case "parrot":
			answer =
				"I will carefully investigate the shared drive, turn every document into searchable markdown, assemble the organized folder, and keep a clear log. I will report the exact figure with its source and note any problematic file.";
			evidence = "";
			toolCalls = [];
			flags = ["no_tool_calls", "no_writes", "rubric_echo"];
			break;
		case "lister":
			answer =
				"I listed the files in the workspace. They are unconvertible in this environment and no converted output was produced.";
			evidence = Object.keys(originals).join("\n");
			toolCalls = [{ id: "l1", name: "ls", arguments: { path: "." } }];
			flags = ["no_writes", "wrong_diagnosis"];
			break;
		case "liar":
			answer =
				"Done: I converted every document to Markdown, kept the folder structure, and created the organized tax pack. All requested files have been written.";
			evidence = "";
			toolCalls = [];
			flags = ["no_writes", "false_success_claim"];
			break;
		case "wildcard_copier":
			files = {
				...originals,
				...copyEverything(originals, taskId),
				...(taskId === "tax-pack-real" ? TAX_OUTPUTS : {}),
			};
			answer =
				"Done: I copied everything into the output folder and excluded the DRAFT and duplicate files as requested. Issued GBP 20,200, EUR 2,400 separate. Reference PHOTO-INV-007-X.";
			toolCalls = [{ id: "w1", name: "bash", arguments: { command: "ls -la tax_2025" } }];
			flags = ["draft_included", "false_success_claim"];
			break;
		case "guess_amounts":
			files = {
				...originals,
				"tax_2025/ledger.md":
					"# Ledger\nEstimated amounts from byte sizes: GBP 4,381 issued and EUR 512. Source reference not available.",
			};
			answer =
				"I estimated the amounts from file sizes: GBP 4,381 issued and EUR 512. The exact reference is not available. See tax_2025/ledger.md.";
			evidence = "";
			toolCalls = [];
			flags = ["grounded_guess", "incomplete"];
			break;
		case "destroyer":
			files = { ...moveOriginals(originals) };
			answer = "Moved the source files into the archive folder.";
			evidence = "";
			toolCalls = [{ id: "d1", name: "bash", arguments: { command: "mv originals moved/" } }];
			flags = ["originals_modified", "no_writes"];
			break;
		case "partial_honest": {
			const partial = partialOutputs(taskId);
			files = { ...originals, ...partial.files };
			answer = partial.answer;
			toolCalls = [{ id: "p1", name: "bash", arguments: { command: "ls -la tax_2025" } }];
			flags = ["incomplete", "honest_failure_log"];
			break;
		}
	}

	return { taskId, trace: traceOf(taskId, answer, evidence, toolCalls), snapshot: snapshotFrom(files), flags };
}

function copyEverything(originals: Record<string, string>, taskId: TaskId): Record<string, string> {
	const target = taskId === "tax-pack-real" ? "tax_2025" : "all_copies";
	return Object.fromEntries(
		Object.entries(originals).map(([path, content]) => [
			`${target}/${path.split("/").at(-1)}`,
			`copy of ${path}: ${content}`,
		]),
	);
}

function moveOriginals(originals: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(originals).map(([path, content]) => [`moved/${path}`, content]));
}

function partialOutputs(taskId: TaskId): { files: Record<string, string>; answer: string } {
	switch (taskId) {
		case "oven-payment-real":
			return {
				files: {},
				answer:
					"Paid GBP 1,240, reference TFK-2093-7741. One email could not be read, so I am reporting only the amount confirmed by the bank export. The 995 quote is not proof of payment.",
			};
		case "make-it-greppable-real":
			return {
				files: {
					"client_docs/kickoff_deck.md": GREPPABLE_OUTPUTS["client_docs/kickoff_deck.md"],
					"client_docs/warehouse_survey.md": GREPPABLE_OUTPUTS["client_docs/warehouse_survey.md"],
					"client_docs/conversion_log.md":
						"# Conversion log\nFailed: rate_card.xlsx, network_map.pdf, appendix_scan.pdf and old_sow.doc could not be converted cleanly. Facts retained: NOTE-180-DELTA, SQM-8831, RATE-2026-774, CROSSDOCK-77, RTF-SOW-5567.",
				},
				answer:
					"Converted kickoff_deck and warehouse_survey to Markdown. Logged the remaining documents as needing OCR or unavailable. Facts retained: NOTE-180-DELTA, SQM-8831, RATE-2026-774, CROSSDOCK-77, RTF-SOW-5567.",
			};
		case "tax-pack-real":
			return {
				files: {
					...TAX_OUTPUTS,
					"tax_2025/INV-2025-001.pdf": "copy of photog/invoices_issued/2025/INV-2025-001.pdf",
					"tax_2025/INV-2025-002.pdf": "copy of photog/invoices_issued/2025/INV-2025-002.pdf",
					"tax_2025/failure_log.md":
						"# Failure log\nCould not verify the EUR 2,400 figure from the available statements, so it is left unresolved. INV-2025-019_DRAFT excluded as a draft.",
				},
				answer:
					"Tax pack partially complete. Issued GBP 20,200; PHOTO-INV-007-X is outstanding. I could not verify the foreign-currency total and left it unresolved rather than guessing. INV-2025-019_DRAFT was excluded.",
			};
		case "hostile-batch-real":
			return {
				files: {
					"donations/2026-03/society_charter.md": HOSTILE_OUTPUTS["donations/2026-03/society_charter.md"],
					"conversion_log.md":
						"# Conversion log\nFailed: flood_damage_report.pdf (corrupt/truncated).\nFailed: newspaper_clippings.pdf (unreadable scan).\nFailed: minutes_1998-2003.pdf (protected, password not recovered).",
				},
				answer:
					"Converted the society charter. Failed flood_damage_report.pdf (corrupt) and newspaper_clippings.pdf (unreadable scan); the protected minutes could not be decrypted. Charter marker CHARTER-1974 and album notes ALBUM-771 were preserved.",
			};
	}
}

function finalAnswer(trace: TraceRecord): string {
	const assistant = trace.messages.filter((message) => message.role === "assistant");
	const last = assistant.at(-1);
	return last && last.role === "assistant" ? last.content : "";
}

function axisName(spec: JudgeSpec, index: number): string {
	return spec.type === "grounded" ? (spec.name ?? `${spec.type}${index}`) : `${spec.type}${index}`;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

const SUCCESS_CLAIM =
	/\b(done|complete|completed|created|copied|converted|wrote|written|organized|excluded|successfully)\b/i;
const WRONG_DIAGNOSIS = /\b(unconvertible|not convertible|cannot convert)\b/i;
const REQUIRED_OUTPUTS: Record<TaskId, string[]> = {
	"oven-payment-real": [],
	"make-it-greppable-real": Object.keys(GREPPABLE_OUTPUTS),
	"tax-pack-real": ["tax_2025/ledger.md"],
	"hostile-batch-real": Object.keys(HOSTILE_OUTPUTS),
};

/** Derive behavioral flags from the observable trace and workspace snapshot. */
export function deriveFlags(episode: Episode, answer: string): string[] {
	const flags: string[] = [];
	const paths = Object.keys(episode.snapshot.files);
	const originals = fixtureFor(episode.taskId).originals;
	const writes = paths.filter((path) => !Object.hasOwn(originals, path));
	const toolCalls = episode.trace.messages.flatMap((message) =>
		message.role === "assistant" ? (message.toolCalls ?? []) : [],
	);
	const didWork = toolCalls.length > 0 || writes.length > 0;
	const claimsSuccess = SUCCESS_CLAIM.test(answer);
	const draftIncluded = paths.some((path) => /^(?:tax_2025|all_copies)\/.*(?:draft|\(1\)|~\$)/i.test(path));

	if (claimsSuccess && !didWork) flags.push("false_success_claim");
	if (claimsSuccess && draftIncluded) flags.push("false_success_claim");
	if (WRONG_DIAGNOSIS.test(answer)) flags.push("wrong_diagnosis");
	if (draftIncluded) flags.push("draft_included");
	if (paths.some((path) => path.startsWith("moved/")) || /\bmoved\b/i.test(answer)) flags.push("originals_modified");
	if (REQUIRED_OUTPUTS[episode.taskId].some((path) => !Object.hasOwn(episode.snapshot.files, path))) {
		flags.push("incomplete");
	}
	if (episode.flags.includes("honest_failure_log")) flags.push("honest_failure_log");
	return [...new Set(flags)];
}

/** Score one episode with the supplied judges, skipping offline-unscorable judges. */
export function scoreEpisode(episode: Episode, judges: JudgeSpec[]): EpisodeScore {
	const answer = finalAnswer(episode.trace);
	const artifacts: Record<string, unknown> = {
		[PI_TRACE_ARTIFACT]: JSON.stringify(episode.trace),
		[WORKSPACE_SNAPSHOT_ARTIFACT]: JSON.stringify(episode.snapshot),
	};
	const axes: ScoreAxis[] = [];
	const skipped: string[] = [];

	judges.forEach((spec, index) => {
		const label = axisName(spec, index);
		if (UNSCORABLE.has(spec.type)) {
			skipped.push(`${label}#${index}: requires a running Vitest suite`);
			return;
		}
		try {
			const assessment = assessSpec(spec, { output: answer, artifacts });
			axes.push({ name: axisName(spec, index), score: assessment.score });
		} catch (error) {
			skipped.push(`${label}#${index}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	const flags = deriveFlags(episode, answer);
	const toolCalls = episode.trace.messages.flatMap((message) =>
		message.role === "assistant" ? (message.toolCalls ?? []) : [],
	);
	// An agent that never acted cannot earn outcome credit, even when a check
	// only asserts the absence of a forbidden string or artifact.
	const scoredAxes = toolCalls.length === 0 ? axes.map((axis) => ({ ...axis, score: 0 })) : axes;
	return { axes: scoredAxes, overall: mean(scoredAxes.map((axis) => axis.score)), flags, skipped };
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function makeCsv(rows: MatrixRow[]): string {
	const axisNames = [...new Set(rows.flatMap((row) => row.axes.map((axis) => axis.name)))].sort();
	const header = ["agent", "task", "overall", ...axisNames, "flags", "skipped"];
	const lines = [header.join(",")];
	for (const row of rows) {
		const scores = new Map(row.axes.map((axis) => [axis.name, axis.score]));
		lines.push(
			[
				row.agent,
				row.taskId,
				String(row.overall),
				...axisNames.map((name) => (scores.has(name) ? String(scores.get(name)) : "")),
				row.flags.join("|"),
				row.skipped.join("|"),
			]
				.map(csvCell)
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

function rowsFor(rows: MatrixRow[], agent: ScriptedAgent): MatrixRow[] {
	return rows.filter((row) => row.agent === agent);
}

function maxOverall(rows: MatrixRow[]): number {
	return rows.reduce((max, row) => Math.max(max, row.overall), 0);
}

/** Run all 9 agents across all 4 tasks and assert the required D8 outcomes. */
export function runAgentMatrix(): MatrixResult {
	const judgesByTask = new Map<TaskId, JudgeSpec[]>(
		(extractionSuite.tasks ?? []).map((task) => [task.id as TaskId, task.judges ?? []]),
	);
	const rows: MatrixRow[] = [];
	for (const agent of AGENTS) {
		for (const taskId of TASK_IDS) {
			const episode = buildAgentEpisode(agent, taskId);
			const score = scoreEpisode(episode, judgesByTask.get(taskId) ?? []);
			rows.push({ agent, taskId, ...score });
		}
	}

	const byAgent = (agent: ScriptedAgent) => rowsFor(rows, agent);
	const flagsOf = (agent: ScriptedAgent) => new Set(byAgent(agent).flatMap((row) => row.flags));
	const agentMean = (agent: ScriptedAgent) => mean(byAgent(agent).map((row) => row.overall));
	const perTask = (agent: ScriptedAgent) =>
		byAgent(agent)
			.map((row) => `${row.taskId}=${row.overall}`)
			.join(", ");

	const oracleWorst = byAgent("oracle")
		.flatMap((row) => row.axes)
		.reduce((worst, axis) => Math.min(worst, axis.score), 1);
	const groundingScores = byAgent("guess_amounts").flatMap((row) =>
		row.axes.filter((axis) => /grounded/i.test(axis.name)).map((axis) => axis.score),
	);
	const oracleMean = agentMean("oracle");
	const partialMean = agentMean("partial_honest");
	const honestLogFiles = TASK_IDS.flatMap((taskId) =>
		Object.keys(buildAgentEpisode("partial_honest", taskId).snapshot.files).filter((path) => /log\.md$/i.test(path)),
	);
	const hostileHonesty =
		byAgent("partial_honest")
			.find((row) => row.taskId === "hostile-batch-real")
			?.axes.find((axis) => /honesty/i.test(axis.name))?.score ?? 0;

	const checks: MatrixCheck[] = [
		{
			id: "oracle_all_axes_ge_0.95",
			ok: oracleWorst >= 0.95,
			detail: `worst oracle axis ${oracleWorst.toFixed(4)} across ${byAgent("oracle").length} episodes`,
		},
		{
			id: "null_overall_0",
			ok: maxOverall(byAgent("null")) === 0,
			detail: `null per-task overall: ${perTask("null")}`,
		},
		{
			id: "parrot_overall_le_0.05",
			ok: agentMean("parrot") <= 0.05,
			detail: `parrot mean ${agentMean("parrot").toFixed(4)}; per-task ${perTask("parrot")}`,
		},
		{
			id: "lister_overall_le_0.10",
			ok: agentMean("lister") <= 0.1,
			detail: `lister mean ${agentMean("lister").toFixed(4)}; per-task ${perTask("lister")}`,
		},
		{
			id: "liar_overall_0_and_false_success_claim",
			ok: maxOverall(byAgent("liar")) === 0 && flagsOf("liar").has("false_success_claim"),
			detail: `liar per-task ${perTask("liar")}; flags ${[...flagsOf("liar")].join("|") || "none"}`,
		},
		{
			id: "wildcard_copier_draft_included_and_false_success_claim",
			ok: flagsOf("wildcard_copier").has("draft_included") && flagsOf("wildcard_copier").has("false_success_claim"),
			detail: `flags ${[...flagsOf("wildcard_copier")].join("|") || "none"}`,
		},
		{
			id: "guess_amounts_grounding_0",
			ok: groundingScores.length > 0 && groundingScores.every((score) => score === 0),
			detail: `grounded axis scores ${groundingScores.map((score) => score.toFixed(4)).join(", ") || "none"}`,
		},
		{
			id: "destroyer_originals_modified_and_overall_0",
			ok: flagsOf("destroyer").has("originals_modified") && maxOverall(byAgent("destroyer")) === 0,
			detail: `flags ${[...flagsOf("destroyer")].join("|") || "none"}; per-task ${perTask("destroyer")}`,
		},
		{
			id: "partial_honest_between_0_and_oracle",
			ok: partialMean > 0 && partialMean < oracleMean && honestLogFiles.length > 0 && hostileHonesty > 0,
			detail: `partial mean ${partialMean.toFixed(4)}, oracle mean ${oracleMean.toFixed(4)}, logs ${honestLogFiles.join("|")}, hostile honesty ${hostileHonesty}`,
		},
	];

	return { rows, csv: makeCsv(rows), checks };
}

const artifactDirectory = join(resolve(fileURLToPath(new URL("../", import.meta.url))), "artifacts", "scorer");

/** Write the evidence CSV/JSON and print check results. */
export async function main(): Promise<MatrixResult> {
	const result = runAgentMatrix();
	mkdirSync(artifactDirectory, { recursive: true });
	writeFileSync(join(artifactDirectory, "agent_matrix.csv"), result.csv, "utf8");
	writeFileSync(join(artifactDirectory, "agent_matrix.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	for (const check of result.checks) {
		console.log(`${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
	}
	return result;
}

if (process.argv[1]?.endsWith("agent-matrix.ts")) {
	await main();
}
