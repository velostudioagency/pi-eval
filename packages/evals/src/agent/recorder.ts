/** Deterministic JSONL trajectory recorder with host-value scrubbing. */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

const SAFE = /[^A-Za-z0-9._-]+/g;
const SYNTHETIC_HOME = "/home/dev";
const SYNTHETIC_USER = "dev";
const SYNTHETIC_HOST = "sandbox";
const SYNTHETIC_TMP = "/tmp";

type HostPair = [needle: string, replacement: string];

/** Add a needle plus its JSON-escaped form, since paths are scrubbed after stringify. */
function addPair(pairs: HostPair[], needle: string, replacement: string): void {
	if (!needle || needle === "/" || needle === "\\") return;
	pairs.push([needle, replacement]);
	if (needle.includes("\\")) pairs.push([needle.replace(/\\/g, "\\\\"), replacement]);
}

function hostPairs(): HostPair[] {
	const pairs: HostPair[] = [];
	const home = homedir();
	for (const variant of new Set([home, home.replace(/\\/g, "/")])) {
		addPair(pairs, variant, SYNTHETIC_HOME);
	}
	const envPairs: HostPair[] = [
		["USERPROFILE", SYNTHETIC_HOME],
		["HOME", SYNTHETIC_HOME],
		["TMPDIR", SYNTHETIC_TMP],
	];
	for (const [name, replacement] of envPairs) {
		const value = process.env[name];
		if (!value) continue;
		addPair(pairs, value, replacement);
		const posix = value.replace(/\\/g, "/");
		if (posix !== value) addPair(pairs, posix, replacement);
	}
	const temp = tmpdir();
	if (temp) {
		addPair(pairs, temp, SYNTHETIC_TMP);
		const posix = temp.replace(/\\/g, "/");
		if (posix !== temp) addPair(pairs, posix, SYNTHETIC_TMP);
	}
	const user = process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? "";
	if (user.length >= 3) addPair(pairs, user, SYNTHETIC_USER);
	const host = hostname();
	if (host.length >= 3) addPair(pairs, host, SYNTHETIC_HOST);
	return pairs.sort((left, right) => right[0].length - left[0].length);
}

const HOST_PAIRS = hostPairs();

/** SHA-256 of UTF-8 text as lowercase hex. */
export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export type ScrubOptions = {
	workspaceRoot?: string;
	syntheticRoot?: string;
};

/** Replace host-specific home, temp, user, host, and optional root paths. */
export function scrubHostValues(text: string, options: ScrubOptions = {}): string {
	if (!text) return text;
	let out = text;
	const { workspaceRoot, syntheticRoot } = options;
	if (workspaceRoot !== undefined && syntheticRoot !== undefined) {
		const pairs: HostPair[] = [];
		addPair(pairs, workspaceRoot, syntheticRoot);
		const posix = workspaceRoot.replace(/\\/g, "/");
		if (posix !== workspaceRoot) addPair(pairs, posix, syntheticRoot);
		for (const [needle, replacement] of pairs.sort((left, right) => right[0].length - left[0].length)) {
			out = out.split(needle).join(replacement);
		}
	}
	for (const [needle, replacement] of HOST_PAIRS) out = out.split(needle).join(replacement);
	return out;
}

/** Stringify with recursively sorted keys and compact separators. */
function stableValue(value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

/** Return a copy with object keys sorted at every level. */
function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
		return sorted;
	}
	return value;
}

function safePart(value: string): string {
	return value.replace(SAFE, "_").replace(/^[._]+|[._]+$/g, "") || "unnamed";
}

export type AgentRecorderOptions = {
	runId?: string;
	taskId?: string;
	profileId?: string;
	seed?: number;
	outputDir?: string;
};

export type RecordTurnInput = {
	turn: number;
	systemPromptHash: string;
	requestMessages: Record<string, unknown>[];
	rawModelText: string;
	reasoning: string;
	parsedCalls: Record<string, unknown>[];
	canonicalActions: Record<string, unknown>[];
	toolResults: Record<string, unknown>[];
	injections?: Record<string, unknown>[];
	faults?: Record<string, unknown>[];
	usage?: Record<string, unknown>;
	formatError?: string;
	malformedCount?: number;
};

/** Write one scrubbed JSON object per event, plus a run summary. */
export class AgentRecorder {
	readonly runId: string;
	readonly taskId: string;
	readonly profileId: string;
	readonly seed: number;
	readonly outputDir: string;
	readonly runDir: string;
	readonly path: string;
	#fd: number;
	#seq = 0;
	#closed = false;

	constructor(options: AgentRecorderOptions = {}) {
		this.runId = options.runId ?? "default";
		this.taskId = options.taskId ?? "adhoc";
		this.profileId = options.profileId ?? "native_min";
		this.seed = options.seed ?? 0;
		this.outputDir = options.outputDir ?? "runs";
		this.runDir = join(this.outputDir, safePart(this.runId));
		mkdirSync(this.runDir, { recursive: true });
		const fileName = `${safePart(this.taskId)}__${safePart(this.profileId)}__${this.seed}.jsonl`;
		this.path = join(this.runDir, fileName);
		this.#fd = openSync(this.path, "w");
	}

	/** Append one scrubbed JSON line and return the unscrubbed payload. */
	recordEvent(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
		this.#seq += 1;
		const payload: Record<string, unknown> = { seq: this.#seq, event };
		Object.assign(payload, fields);
		writeSync(this.#fd, `${scrubHostValues(stableValue(payload))}\n`);
		return payload;
	}

	/** Record a single model turn with all request and response artifacts. */
	recordTurn(input: RecordTurnInput): Record<string, unknown> {
		const extra: Record<string, unknown> = { malformed_count: input.malformedCount ?? 0 };
		if (input.formatError !== undefined) extra.format_error = input.formatError;
		return this.recordEvent("turn", {
			turn: input.turn,
			system_prompt_hash: input.systemPromptHash,
			request_messages: input.requestMessages,
			raw_model_text: input.rawModelText,
			reasoning: input.reasoning,
			parsed_calls: input.parsedCalls,
			canonical_actions: input.canonicalActions,
			tool_results: input.toolResults,
			injections: input.injections ?? [],
			faults: input.faults ?? [],
			usage: input.usage ?? {},
			...extra,
		});
	}

	/** Write a deterministic, scrubbed summary.json into the run directory. */
	writeSummary(summary: Record<string, unknown>): string {
		const path = join(this.runDir, "summary.json");
		const body = `${JSON.stringify(sortKeysDeep(summary), null, 2)}\n`;
		writeFileSync(path, scrubHostValues(body), "utf8");
		return path;
	}

	/** Close the underlying file descriptor. */
	close(): void {
		if (!this.#closed) {
			closeSync(this.#fd);
			this.#closed = true;
		}
	}
}
