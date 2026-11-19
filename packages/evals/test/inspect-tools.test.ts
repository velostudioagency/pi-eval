/** Tests for the Inspect-compatible python and text_editor tool definitions. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectToolDefinitions, pythonToolDefinition, textEditorToolDefinition } from "../src/tools/inspect-tools.ts";

function sessionWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "inspect-tools-"));
}

const pythonOnPath = (() => {
	try {
		return spawnSync("python", ["-c", "pass"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
})();

describe("python tool", () => {
	it("exposes the Inspect parameter shape", () => {
		const tool = pythonToolDefinition(sessionWorkspace());
		expect(tool.name).toBe("python");
		expect(tool.parameters.type).toBe("object");
		expect(Object.keys(tool.parameters.properties)).toEqual(["code", "timeout_s"]);
		expect(tool.parameters.properties.code.type).toBe("string");
		expect(tool.parameters.required).toContain("code");
	});

	it.skipIf(!pythonOnPath)("executes code in the session workspace", async () => {
		const workspace = sessionWorkspace();
		writeFileSync(join(workspace, "hello.txt"), "hi there");
		const tool = pythonToolDefinition(workspace);
		const result = await tool.execute("test", { code: "print(open('hello.txt').read().strip())" });
		expect("isError" in result && result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: "hi there" });
	});

	it.skipIf(!pythonOnPath)("reports nonzero exits as errors", async () => {
		const tool = pythonToolDefinition(sessionWorkspace());
		const result = await tool.execute("test", { code: "raise ValueError('boom')" });
		expect("isError" in result && result.isError).toBe(true);
	});
});

describe("text_editor tool", () => {
	it("exposes the Inspect parameter shape", () => {
		const tool = textEditorToolDefinition(sessionWorkspace());
		expect(tool.name).toBe("text_editor");
		expect(tool.parameters.type).toBe("object");
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"command",
			"file_path",
			"view_range",
			"file_text",
			"old_str",
			"new_str",
			"insert_line",
		]);
	});

	it("views a file with line numbers", async () => {
		const workspace = sessionWorkspace();
		writeFileSync(join(workspace, "note.txt"), "first\nsecond");
		const tool = textEditorToolDefinition(workspace);
		const result = await tool.execute("test", { command: "view", file_path: "note.txt" });
		expect("isError" in result && result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("first") });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("second") });
	});

	it("creates, replaces, and reports errors", async () => {
		const workspace = sessionWorkspace();
		const tool = textEditorToolDefinition(workspace);
		await tool.execute("test", { command: "create", file_path: "made.txt", file_text: "alpha\nbeta" });
		expect(existsSync(join(workspace, "made.txt"))).toBe(true);
		expect(readFileSync(join(workspace, "made.txt"), "utf8")).toBe("alpha\nbeta");

		const replaced = await tool.execute("test", {
			command: "str_replace",
			file_path: "made.txt",
			old_str: "alpha",
			new_str: "gamma",
		});
		expect("isError" in replaced && replaced.isError).toBe(false);
		expect(readFileSync(join(workspace, "made.txt"), "utf8")).toBe("gamma\nbeta");

		const missing = await tool.execute("test", {
			command: "str_replace",
			file_path: "made.txt",
			old_str: "nope",
			new_str: "x",
		});
		expect("isError" in missing && missing.isError).toBe(true);

		const again = await tool.execute("test", { command: "create", file_path: "made.txt", file_text: "x" });
		expect("isError" in again && again.isError).toBe(true);
	});

	it("inserts and appends in the session workspace", async () => {
		const workspace = sessionWorkspace();
		writeFileSync(join(workspace, "log.txt"), "one\nthree");
		const tool = textEditorToolDefinition(workspace);
		await tool.execute("test", { command: "insert", file_path: "log.txt", insert_line: 1, new_str: "two" });
		expect(readFileSync(join(workspace, "log.txt"), "utf8")).toBe("one\ntwo\nthree");
		await tool.execute("test", { command: "append", file_path: "log.txt", new_str: "four" });
		expect(readFileSync(join(workspace, "log.txt"), "utf8")).toBe("one\ntwo\nthree\nfour");
	});

	it("reports an error for a missing file", async () => {
		const tool = textEditorToolDefinition(sessionWorkspace());
		const result = await tool.execute("test", { command: "view", file_path: "nope.txt" });
		expect("isError" in result && result.isError).toBe(true);
	});
});

describe("inspectToolDefinitions", () => {
	it("returns the Inspect gap: python and text_editor", () => {
		const defs = inspectToolDefinitions(sessionWorkspace());
		expect(defs.map((def) => def.name)).toEqual(["python", "text_editor"]);
		expect(defs.every((def) => typeof def.execute === "function")).toBe(true);
	});
});
