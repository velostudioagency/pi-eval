/**
 * Workspace snapshots let graders check the files an agent actually produced:
 * moves, renames, conversions, conservation, and untouched files.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const WORKSPACE_SNAPSHOT_ARTIFACT = "piEvalWorkspace";

export type WorkspaceSnapshot = {
	files: Record<string, { sha256: string; size: number; text?: string }>;
	directories: string[];
};

async function walk(root: string, directory: string, snapshot: WorkspaceSnapshot): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		const name = relative(root, absolute).split(sep).join("/");
		if (entry.isDirectory()) {
			snapshot.directories.push(name);
			await walk(root, absolute, snapshot);
			continue;
		}
		if (!entry.isFile()) continue;
		const content = await readFile(absolute);
		const size = (await stat(absolute)).size;
		const text = size <= 64 * 1024 && !content.includes(0) ? content.toString("utf8") : undefined;
		snapshot.files[name] = {
			sha256: createHash("sha256").update(content).digest("hex"),
			size,
			...(text === undefined ? {} : { text }),
		};
	}
}

/** Captures every file and directory under the agent workspace after a run. */
export async function captureWorkspace(root: string): Promise<WorkspaceSnapshot> {
	const snapshot: WorkspaceSnapshot = { files: {}, directories: [] };
	await walk(root, root, snapshot);
	snapshot.directories.sort();
	return snapshot;
}

/** SHA-256 of a text fixture, used to assert a file was left unchanged. */
export function textHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const snapshot = parsed as Partial<WorkspaceSnapshot>;
		if (typeof snapshot.files !== "object" || snapshot.files === null) return undefined;
		if (!Array.isArray(snapshot.directories)) return undefined;
		return snapshot as WorkspaceSnapshot;
	} catch {
		return undefined;
	}
}
