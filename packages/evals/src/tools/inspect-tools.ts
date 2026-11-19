/**
 * Inspect-compatible tool definitions for the pi-coding-agent session.
 *
 * The session already ships `bash`, so the Inspect gap is `python` and
 * `text_editor`. Definitions are inert until executed: the interpreter and the
 * editor resolve lazily at execution time, and nothing asserts on session
 * state.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const pythonSchema = Type.Object({
	code: Type.String({ description: "Python code to execute in the session workspace." }),
	timeout_s: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
});

const textEditorSchema = Type.Object({
	command: Type.Union(
		[
			Type.Literal("view"),
			Type.Literal("create"),
			Type.Literal("str_replace"),
			Type.Literal("insert"),
			Type.Literal("append"),
		],
		{ description: "The editor command to run." },
	),
	file_path: Type.String({ description: "Path of the file, relative to the session workspace." }),
	view_range: Type.Optional(
		Type.Tuple([Type.Number(), Type.Number()], {
			description: "For view: inclusive [start, end] line range (1-indexed).",
		}),
	),
	file_text: Type.Optional(Type.String({ description: "For create: the file content." })),
	old_str: Type.Optional(Type.String({ description: "For str_replace: the exact text to replace." })),
	new_str: Type.Optional(
		Type.String({ description: "For str_replace, insert, and append: the replacement, inserted, or appended text." }),
	),
	insert_line: Type.Optional(
		Type.Number({
			description:
				"For insert: 1-indexed line after which to insert; 0 inserts at the top; defaults to the end of the file.",
		}),
	),
});

export type InspectPythonParams = Static<typeof pythonSchema>;
export type InspectTextEditorParams = Static<typeof textEditorSchema>;

export type PythonDetails = { exitCode: number };
export type TextEditorDetails = { path: string };

function runPythonCode(
	workspace: string,
	code: string,
	timeoutMs: number | undefined,
): Promise<{ output: string; exitCode: number }> {
	return new Promise((resolve) => {
		execFile(
			"python",
			["-c", code],
			{ cwd: workspace, encoding: "utf8", ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}) },
			(error, stdout, stderr) => {
				const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
				resolve({ output, exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
			},
		);
	});
}

export function pythonToolDefinition(workspace: string) {
	return {
		name: "python",
		label: "Python",
		description: "Execute Python code in the session workspace and return its combined stdout/stderr output.",
		parameters: pythonSchema,
		promptSnippet: "Execute Python code in the session workspace",
		promptGuidelines: [
			"Use python to run Python code in the session workspace, for example to verify computed values.",
		],
		async execute(_toolCallId: string, params: InspectPythonParams) {
			const { output, exitCode } = await runPythonCode(
				workspace,
				params.code,
				params.timeout_s !== undefined ? params.timeout_s * 1000 : undefined,
			);
			return {
				content: [{ type: "text" as const, text: output }],
				details: { exitCode },
				...(exitCode !== 0 ? { isError: true } : {}),
			};
		},
	};
}

async function readFileOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

function errorResult(path: string, message: string) {
	return { content: [{ type: "text" as const, text: message }], details: { path }, isError: true };
}

export function textEditorToolDefinition(workspace: string) {
	return {
		name: "text_editor",
		label: "Text Editor",
		description:
			"View, create, and edit files in the session workspace: view, create, str_replace, insert, and append.",
		parameters: textEditorSchema,
		promptSnippet: "View, create, and edit files in the session workspace",
		promptGuidelines: [
			"Use text_editor instead of cat or sed to read and modify files in the session workspace.",
			"str_replace must match exactly one occurrence in the file; view_range is the inclusive [start, end] line range for view.",
		],
		async execute(_toolCallId: string, params: InspectTextEditorParams) {
			const resolved = resolve(workspace, params.file_path);
			switch (params.command) {
				case "view": {
					const content = await readFileOrNull(resolved);
					if (content === null) return errorResult(params.file_path, `File not found: ${params.file_path}`);
					const lines = content.split("\n");
					let start = 1;
					let end = lines.length;
					if (params.view_range) {
						start = Math.max(1, params.view_range[0]);
						end = Math.min(lines.length, Math.max(start, params.view_range[1]));
					}
					const width = String(end).length + 1;
					const text = lines
						.slice(start - 1, end)
						.map((line, index) => `${String(start + index).padStart(width)} ${line}`)
						.join("\n");
					return { content: [{ type: "text" as const, text }], details: { path: params.file_path } };
				}
				case "create": {
					if (existsSync(resolved)) {
						return errorResult(params.file_path, `File already exists: ${params.file_path}`);
					}
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, params.file_text ?? "");
					return {
						content: [{ type: "text" as const, text: `Created ${params.file_path}` }],
						details: { path: params.file_path },
					};
				}
				case "str_replace": {
					const content = await readFileOrNull(resolved);
					if (content === null) return errorResult(params.file_path, `File not found: ${params.file_path}`);
					const occurrences = content.split(params.old_str ?? "").length - 1;
					if (occurrences === 0) return errorResult(params.file_path, `old_str not found in ${params.file_path}`);
					if (occurrences > 1) {
						return errorResult(
							params.file_path,
							`old_str matches ${occurrences} places in ${params.file_path}; it must match exactly once`,
						);
					}
					await writeFile(resolved, content.replace(params.old_str ?? "", params.new_str ?? ""));
					return {
						content: [{ type: "text" as const, text: `Replaced text in ${params.file_path}` }],
						details: { path: params.file_path },
					};
				}
				case "insert": {
					const content = await readFileOrNull(resolved);
					if (content === null) return errorResult(params.file_path, `File not found: ${params.file_path}`);
					const lines = content === "" ? [] : content.split("\n");
					const insertLine = params.insert_line ?? lines.length;
					lines.splice(Math.max(0, Math.min(insertLine, lines.length)), 0, params.new_str ?? "");
					await writeFile(resolved, lines.join("\n"));
					return {
						content: [{ type: "text" as const, text: `Inserted text into ${params.file_path}` }],
						details: { path: params.file_path },
					};
				}
				case "append": {
					const content = await readFileOrNull(resolved);
					const text = params.new_str ?? "";
					const next =
						content === null
							? text
							: content === "" || content.endsWith("\n")
								? content + text
								: `${content}\n${text}`;
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, next);
					return {
						content: [{ type: "text" as const, text: `Appended text to ${params.file_path}` }],
						details: { path: params.file_path },
					};
				}
			}
		},
	};
}

/** The Inspect tool definitions to expose when a profile requests them. */
export function inspectToolDefinitions(workspace: string): ToolDefinition[] {
	return [pythonToolDefinition(workspace), textEditorToolDefinition(workspace)];
}
