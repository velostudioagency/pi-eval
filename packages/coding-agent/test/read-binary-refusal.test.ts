import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("read binary refusal", () => {
	let dir: string;
	const read = () => createReadToolDefinition(dir, { refuseBinaryFiles: true });

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-read-binary-"));
		writeFileSync(join(dir, "report.pdf"), "%PDF-1.3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
		writeFileSync(join(dir, "notes.txt"), "plain text\n");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a structured refusal for PDF bytes", async () => {
		const result = await read().execute("call", { path: "report.pdf" }, undefined, undefined, undefined as never);
		const text = result.content.find((block) => block.type === "text");
		expect(text?.type).toBe("text");
		const refusal = JSON.parse(text && text.type === "text" ? text.text : "");
		expect(refusal.error).toBe("binary_file");
		expect(refusal.magic).toContain("%PDF-1.3");
		expect(refusal.size).toBeGreaterThan(0);
	});

	it("still reads ordinary text files", async () => {
		const result = await read().execute("call", { path: "notes.txt" }, undefined, undefined, undefined as never);
		const text = result.content.find((block) => block.type === "text");
		expect(text?.type === "text" && text.text).toContain("plain text");
	});

	it("leaves the refusal off by default", async () => {
		const tool = createReadToolDefinition(dir);
		const result = await tool.execute("call", { path: "report.pdf" }, undefined, undefined, undefined as never);
		const text = result.content.find((block) => block.type === "text");
		expect(text?.type === "text" && text.text).toContain("%PDF-1.3");
	});
});
