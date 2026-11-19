/**
 * JSON loading for agent-eval harness profiles.
 *
 * A profile file is one JSON object. loadAgentProfiles walks directories in the order given and
 * sorts filenames inside each one, so the resulting list is stable across machines and runs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentProfile, validateAgentProfile } from "./profile.ts";

/** Raised when a profile file is missing, unreadable, malformed, or invalid. */
export class ProfileLoadError extends Error {
	readonly path: string | undefined;

	constructor(message: string, path?: string) {
		super(message);
		this.name = "ProfileLoadError";
		this.path = path;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseProfileFile(filePath: string): AgentProfile {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		throw new ProfileLoadError(`could not read profile ${filePath}: ${errorMessage(error)}`, filePath);
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new ProfileLoadError(`invalid JSON in ${filePath}: ${errorMessage(error)}`, filePath);
	}

	try {
		return validateAgentProfile(json);
	} catch (error) {
		throw new ProfileLoadError(`invalid profile in ${filePath}: ${errorMessage(error)}`, filePath);
	}
}

/** Reads, validates, and returns the single JSON profile at `path`. */
export function loadAgentProfile(path: string): AgentProfile {
	return parseProfileFile(resolve(path));
}

/**
 * Loads every `*.json` profile in the given directories.
 *
 * Files are sorted by name within each directory and directories are visited in argument order.
 * A file reachable through more than one directory is loaded once.
 */
export function loadAgentProfiles(dirs: Iterable<string>): AgentProfile[] {
	const profiles: AgentProfile[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const directory = resolve(dir);
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch (error) {
			throw new ProfileLoadError(`could not read profile directory ${directory}: ${errorMessage(error)}`, directory);
		}
		const files = entries.filter((name) => name.toLowerCase().endsWith(".json")).sort();
		for (const name of files) {
			const filePath = resolve(directory, name);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			profiles.push(parseProfileFile(filePath));
		}
	}
	return profiles;
}
