/** Tests for the agent-eval profile schema and JSON loader. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgentProfile } from "../src/agent/profile.ts";
import { loadAgentProfile, loadAgentProfiles, ProfileLoadError } from "../src/agent/profile-loader.ts";

const rawProfile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "p",
	family: "f",
	...overrides,
});

const tool = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	canonical: "read",
	name: "read",
	...overrides,
});

describe("validateAgentProfile", () => {
	it("accepts a minimal profile and applies the documented defaults", () => {
		const profile = validateAgentProfile(rawProfile());
		expect(profile.id).toBe("p");
		expect(profile.family).toBe("f");
		expect(profile.split).toBe("train");
		expect(profile.prompt.weight).toBe("minimal");
		expect(profile.prompt.template).toBe("default.j2");
		expect(profile.prompt.envBlock.fields).toEqual(["cwd", "os", "shell", "date", "git_status"]);
		expect(profile.prompt.projectContext.files).toEqual(["AGENTS.md"]);
		expect(profile.prompt.emitDialectInstructions).toBe(true);
		expect(profile.tools.termination).toBe("no_tool_call");
		expect(profile.tools.surface).toEqual([]);
		expect(profile.wire.protocol).toBe("native_openai");
		expect(profile.results.maxChars).toBe(20_000);
		expect(profile.skills.enabled).toBe(true);
		expect(profile.context.windowTokens).toBe(32_768);
		expect(profile.context.compaction.thresholdRatio).toBe(0.75);
		expect(profile.loop.maxTurns).toBe(40);
		expect(profile.historyReasoning).toBe("strip");
		expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
	});

	it("enforces unique canonical and skinned tool names", () => {
		const distinct = [tool(), tool({ canonical: "write", name: "write" })];
		expect(validateAgentProfile(rawProfile({ tools: { surface: distinct } })).tools.surface).toHaveLength(2);
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool(), tool()] },
				}),
			),
		).toThrow("duplicate canonical tools");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool(), tool({ canonical: "write" })] },
				}),
			),
		).toThrow("duplicate skinned tool names");
	});

	it("checks finishTool and finishWhenTrue against the surface", () => {
		const base = {
			termination: "finish_tool",
			surface: [tool({ canonical: "finish", name: "finish", params: { end_turn: "end" } })],
		};
		expect(() => validateAgentProfile(rawProfile({ tools: base }))).toThrow("requires tools.finishTool");
		expect(() => validateAgentProfile(rawProfile({ tools: { ...base, finishTool: "missing" } }))).toThrow(
			"is not in tools.surface",
		);
		expect(validateAgentProfile(rawProfile({ tools: { ...base, finishTool: "finish" } })).tools.finishTool).toBe(
			"finish",
		);
		expect(() =>
			validateAgentProfile(rawProfile({ tools: { ...base, finishTool: "finish", finishWhenTrue: "missing" } })),
		).toThrow("is not a parameter");
		expect(() => validateAgentProfile(rawProfile({ tools: { finishTool: "finish" } }))).toThrow(
			"only valid with termination",
		);
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { ...base, finishTool: "finish", finishWhenTrue: "end", termination: "exit_command" },
				}),
			),
		).toThrow("only valid with termination");
		expect(
			validateAgentProfile(
				rawProfile({
					tools: { ...base, finishTool: "finish", finishWhenTrue: "end" },
				}),
			).tools.finishWhenTrue,
		).toBe("end");
	});

	it("validates tool and parameter names against the wire protocol", () => {
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ name: "my.tool" })] },
				}),
			),
		).toThrow("invalid for native wire names");
		expect(
			validateAgentProfile(
				rawProfile({
					wire: { protocol: "terminus_json" },
					tools: { surface: [tool({ name: "my.tool" })] },
				}),
			).tools.surface[0].name,
		).toBe("my.tool");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ params: { a: "x", b: "x" } })] },
				}),
			),
		).toThrow("maps two parameters to the same name");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ params: { a: "" } })] },
				}),
			),
		).toThrow("has an empty parameter name");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ params: { a: "x" }, extraParams: { x: {} } })] },
				}),
			),
		).toThrow("uses the same name for an extra and mapped parameter");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ params: { a: "bad name" } })] },
				}),
			),
		).toThrow("invalid parameter name");
		expect(() =>
			validateAgentProfile(
				rawProfile({
					tools: { surface: [tool({ canonical: " " })] },
				}),
			),
		).toThrow("must not be empty");
	});

	it("enforces cross-field wire and editing constraints", () => {
		expect(() => validateAgentProfile(rawProfile({ wire: { toolsIn: "system_prompt_text" } }))).toThrow(
			"native_openai wire requires toolsIn",
		);
		expect(() => validateAgentProfile(rawProfile({ wire: { protocol: "bash_block" } }))).toThrow(
			"requires editDialect: bash_only",
		);
		expect(
			validateAgentProfile(
				rawProfile({
					wire: { protocol: "bash_block" },
					tools: { editDialect: "bash_only" },
				}),
			).tools.editDialect,
		).toBe("bash_only");
		expect(() => validateAgentProfile(rawProfile({ wire: { protocol: "keystrokes" } }))).toThrow(
			"exactly one terminal (bash) tool",
		);
		expect(
			validateAgentProfile(
				rawProfile({
					wire: { protocol: "keystrokes" },
					tools: { surface: [tool({ canonical: "bash", name: "bash" })] },
				}),
			).wire.protocol,
		).toBe("keystrokes");
		expect(() => validateAgentProfile(rawProfile({ wire: { protocol: "plain_text" } }))).toThrow(
			"requires a text edit dialect",
		);
		expect(() =>
			validateAgentProfile(
				rawProfile({
					wire: { protocol: "plain_text" },
					tools: { editDialect: "udiff", surface: [tool()] },
				}),
			),
		).toThrow("remove tools.surface");
		expect(
			validateAgentProfile(
				rawProfile({
					wire: { protocol: "plain_text" },
					tools: { editDialect: "udiff" },
				}),
			).tools.editDialect,
		).toBe("udiff");
		expect(() => validateAgentProfile(rawProfile({ tools: { deferredLoading: true } }))).toThrow(
			"deferred_loading requires a tool_search tool",
		);
		expect(
			validateAgentProfile(
				rawProfile({
					tools: { deferredLoading: true, surface: [tool({ canonical: "tool_search", name: "tool_search" })] },
				}),
			).tools.deferredLoading,
		).toBe(true);
	});

	it("validates nested specs, conditions, and numeric bounds", () => {
		expect(() => validateAgentProfile(rawProfile({ prompt: { envBlock: { fields: ["nope"] } } }))).toThrow(
			"unknown environment fields",
		);
		expect(() => validateAgentProfile(rawProfile({ prompt: { envBlock: { fields: ["cwd", "cwd"] } } }))).toThrow(
			"must be unique",
		);
		expect(() => validateAgentProfile(rawProfile({ prompt: { template: " " } }))).toThrow("must not be empty");
		const reminder = (when: Record<string, unknown>): Record<string, unknown> => ({ id: "r", template: "t", when });
		expect(() => validateAgentProfile(rawProfile({ reminders: [reminder({ bogus: 1 })] }))).toThrow(
			"unknown reminder condition(s)",
		);
		expect(() => validateAgentProfile(rawProfile({ reminders: [reminder({ min_turn: 0 })] }))).toThrow(
			"must be an integer >= 1",
		);
		expect(() => validateAgentProfile(rawProfile({ reminders: [reminder({ if_tool_used: " " })] }))).toThrow(
			"must be a tool name",
		);
		expect(() => validateAgentProfile(rawProfile({ reminders: [reminder({ if_no_tool_calls: "yes" })] }))).toThrow(
			"must be a boolean",
		);
		expect(() => validateAgentProfile(rawProfile({ reminders: [{ id: "", template: "t" }] }))).toThrow(
			"must not be empty",
		);
		expect(() => validateAgentProfile(rawProfile({ results: { maxChars: 0 } }))).toThrow("must be an integer >= 1");
		expect(() => validateAgentProfile(rawProfile({ context: { windowTokens: 0 } }))).toThrow(
			"must be an integer >= 1",
		);
		expect(() => validateAgentProfile(rawProfile({ context: { compaction: { thresholdRatio: 1.2 } } }))).toThrow(
			"at most 1",
		);
		expect(() => validateAgentProfile(rawProfile({ loop: { maxTurns: 0 } }))).toThrow("must be an integer >= 1");
		expect(() => validateAgentProfile(rawProfile({ loop: { stuckDetector: { nudge: "" } } }))).toThrow(
			"must not be empty when set",
		);
		expect(() => validateAgentProfile(rawProfile({ loop: { steeringMessages: [{ turn: 0, text: "hi" }] } }))).toThrow(
			"needs an integer turn >= 1",
		);
		expect(() => validateAgentProfile(rawProfile({ loop: { steeringMessages: [{ turn: 1, text: " " }] } }))).toThrow(
			"needs non-empty text",
		);
		expect(() => validateAgentProfile(rawProfile({ id: " " }))).toThrow("id and family must not be empty");
		expect(() => validateAgentProfile(rawProfile({ prompt: { bogus: true } }))).toThrow('unknown field "bogus"');
	});
});

describe("agent profile loader", () => {
	it("loads one JSON profile and reports clear errors for bad inputs", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-profile-single-"));
		try {
			const raw = rawProfile({ id: "single", tools: { surface: [tool()] } });
			const path = join(dir, "single.json");
			writeFileSync(path, JSON.stringify(raw));
			expect(loadAgentProfile(path)).toEqual(validateAgentProfile(raw));

			const badJson = join(dir, "bad.json");
			writeFileSync(badJson, "{not json");
			expect(() => loadAgentProfile(badJson)).toThrow(ProfileLoadError);
			expect(() => loadAgentProfile(badJson)).toThrow(/invalid JSON/);

			const badProfile = join(dir, "invalid.json");
			writeFileSync(badProfile, JSON.stringify({ id: "bad", family: "f", prompt: { template: "" } }));
			expect(() => loadAgentProfile(badProfile)).toThrow(/invalid profile.*must not be empty/);

			expect(() => loadAgentProfile(join(dir, "missing.json"))).toThrow(/could not read profile/);
			expect(() => loadAgentProfiles([join(dir, "no-such-dir")])).toThrow(ProfileLoadError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads all JSON profiles in deterministic order and round-trips through JSON", () => {
		const first = mkdtempSync(join(tmpdir(), "agent-profiles-a-"));
		const second = mkdtempSync(join(tmpdir(), "agent-profiles-b-"));
		try {
			const a = rawProfile({ id: "a" });
			const z = rawProfile({ id: "z" });
			const m = rawProfile({ id: "m" });
			writeFileSync(join(first, "z.json"), JSON.stringify(z));
			writeFileSync(join(first, "a.json"), JSON.stringify(a));
			writeFileSync(join(first, "notes.txt"), "ignored");
			writeFileSync(join(second, "m.json"), JSON.stringify(m));

			const loaded = loadAgentProfiles([first, second, first]);
			expect(loaded.map((profile) => profile.id)).toEqual(["a", "z", "m"]);
			expect(loaded[0]).toEqual(validateAgentProfile(a));
			expect(validateAgentProfile(JSON.parse(JSON.stringify(loaded[1])))).toEqual(loaded[1]);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});
});
