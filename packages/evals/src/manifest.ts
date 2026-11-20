/**
 * Fixture manifests for the baseline suite.
 *
 * A manifest is the single source of truth for one task: its prompt, the files
 * seeded into the workspace, the ground truth, the traps, and the invariants
 * the scorer enforces. This module only loads and describes manifests; scoring
 * lives in `manifest-score.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ManifestFactValue = string | number | boolean;

export type ManifestEnvironment = {
	pythonVersion: string;
	packageMode: "full" | "bare";
	installedPackages: string[];
	installRequiredByModel: boolean;
	notes: string;
};

export type ManifestGoldEndState = {
	files: string[];
	absent: string[];
	unchanged: string[];
};

export type ManifestGroundTruth = {
	facts: Record<string, ManifestFactValue>;
	requiredStrings: string[];
	forbiddenStrings: string[];
	goldEndState: ManifestGoldEndState;
};

export type ManifestCheckType =
	| "exists"
	| "absent"
	| "contains"
	| "not_contains"
	| "regex"
	| "hash_equal"
	| "password_used"
	| "false_claim";

/** The search area an absence claim must have covered to earn trap credit. */
export type ManifestTrapScope = {
	directories?: string[];
	fileTypes?: string[];
	paths?: string[];
};

/** `type` is open-ended so a newer fixture does not break an older scorer. */
export type ManifestTrapCheck = {
	type: ManifestCheckType | (string & {});
	path?: string;
	pattern?: string;
	value?: string;
	scope?: ManifestTrapScope;
};

export type ManifestTrap = {
	id: string;
	path: string;
	kind: string;
	expected: ManifestFactValue | null;
	check: ManifestTrapCheck;
};

export type ManifestFileRole = "target" | "filler" | "trap" | "lock";

export type ManifestFile = {
	path: string;
	sha256: string;
	size: number;
	role: ManifestFileRole;
};

export type ManifestInvariants = {
	fileCountConservation: boolean;
	originalsUntouched: string[];
};

export type Manifest = {
	schemaVersion: 1;
	taskId: string;
	family: string;
	domain: string;
	prompt: string;
	persona: string;
	groundTruth: ManifestGroundTruth;
	traps: ManifestTrap[];
	files: ManifestFile[];
	invariants: ManifestInvariants;
	environment: ManifestEnvironment;
};

/** Package-relative fixture path for one task file. */
export function manifestAssetPath(taskId: string, path: string): string {
	return `fixtures/baseline/${taskId}/${path}`;
}

/**
 * Reads one manifest from disk.
 *
 * Missing or malformed manifests are a load error, not an empty score: the
 * suite cannot be graded honestly without its declared ground truth.
 */
export function loadManifest(taskId: string): Manifest {
	if (!taskId.trim()) throw new TypeError("Manifest task id must not be empty.");
	const path = join(packageRoot, "fixtures", "baseline", taskId, "manifest.json");
	const stagedPath = join(packageRoot, "fixtures", "baseline", "meta", taskId, "manifest.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Fixture generation may stage manifests under meta/ before publishing
		// them into each task directory. Accept either location.
		try {
			raw = readFileSync(stagedPath, "utf8");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Manifest for task "${taskId}" could not be read at ${path} or ${stagedPath}: ${reason}`);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Manifest for task "${taskId}" at ${path} is not valid JSON: ${reason}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new TypeError(`Manifest for task "${taskId}" at ${path} must be a JSON object.`);
	}
	const manifest = parsed as Partial<Manifest>;
	if (manifest.schemaVersion !== 1) {
		throw new TypeError(
			`Manifest for task "${taskId}" has unsupported schemaVersion ${String(manifest.schemaVersion)}; expected 1.`,
		);
	}
	if (typeof manifest.prompt !== "string") {
		throw new TypeError(`Manifest for task "${taskId}" has no prompt string.`);
	}
	if (typeof manifest.family !== "string" || typeof manifest.domain !== "string") {
		throw new TypeError(`Manifest for task "${taskId}" needs string family and domain.`);
	}
	return manifest as Manifest;
}

/** Maps every declared file to its on-disk fixture, for `workspaceAssets`. */
export function manifestAssets(taskId: string): Record<string, string> {
	const manifest = loadManifest(taskId);
	return Object.fromEntries(manifest.files.map((file) => [file.path, manifestAssetPath(taskId, file.path)]));
}

/** Returns the task prompt declared by the manifest. */
export function manifestPrompt(taskId: string): string {
	return loadManifest(taskId).prompt;
}
