import { homedir } from "node:os";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludePiDocumentation,
	resolveModelSelection,
	resolveSystemPromptTransform,
	verifySystemPrompt,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { PI_PROVIDER: "openai-codex" }, { PI_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("PI_EVAL_PROFILE", "with_docs");
		vi.stubEnv("PI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env.PI_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
				expect(process.env.PI_EVAL_PROFILE).toBeUndefined();
				expect(process.env.PI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.PI_EVAL_PROFILE).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("system prompt profile", () => {
	it("maps prompt specs to the transform the harness applies", () => {
		expect(resolveSystemPromptTransform({ kind: "pi-default" })).toBeUndefined();
		expect(resolveSystemPromptTransform(undefined)).toBeUndefined();
		expect(resolveSystemPromptTransform({ kind: "pi-default-minus-docs" })).toBe(excludePiDocumentation);
		expect(resolveSystemPromptTransform({ kind: "literal", text: "directions" })?.("default")).toBe("directions");
		const custom = (prompt: string) => `custom:${prompt}`;
		expect(resolveSystemPromptTransform({ kind: "transform", id: "c", transform: custom })).toBe(custom);
	});

	it("strips only the documentation routing section from the default Pi prompt", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(prompt).toContain("\n<docs>\nPi documentation (read only");
		expect(prompt).toContain("\n<rules>\n");
		expect(prompt).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludePiDocumentation(prompt);
		expect(stripped).toContain("\n<rules>\n");
		expect(stripped).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(stripped).not.toContain("<docs>");
		expect(stripped).not.toContain("Pi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("verifies the prompt that was sent", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		const stripped = excludePiDocumentation(prompt);

		expect(verifySystemPrompt(stripped, { kind: "pi-default-minus-docs" })).toBe(stripped);
		expect(() => verifySystemPrompt(prompt, { kind: "pi-default-minus-docs" })).toThrow("does not match");
		expect(verifySystemPrompt(prompt, { kind: "pi-default" })).toBe(prompt);
		expect(verifySystemPrompt(prompt, { kind: "literal", text: "custom" })).toBe(prompt);
	});

	it("fails closed when prompt markers are missing", () => {
		expect(() => excludePiDocumentation("Instructions")).toThrow("no Pi documentation section");
		expect(() => excludePiDocumentation("\n<docs>\nPi documentation\n</docs>")).toThrow(
			"no working-directory section",
		);
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
