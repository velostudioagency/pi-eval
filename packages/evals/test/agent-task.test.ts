/** Tests for agent task loading, declarative verification, and the gold/Null gate. */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateTask } from "../src/agent/gold.ts";
import { loadAgentTask, loadAgentTasks, resolveWorkspacePath } from "../src/agent/task.ts";
import {
	type AgentAction,
	readVerificationChecks,
	runVerification,
	scrubHostValues,
	type VerificationCheck,
	VerificationContext,
} from "../src/agent/verify.ts";

const created: string[] = [];

afterEach(() => {
	for (const directory of created.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

type MakeOptions = {
	container?: string;
	id?: string;
	checks?: VerificationCheck[];
	goldActions?: Array<{ tool: string; args: Record<string, unknown> }>;
	goldFinal?: string;
	repoFiles?: Record<string, string>;
	config?: Record<string, unknown>;
};

function makeTask(options: MakeOptions = {}) {
	const container = options.container ?? mkdtempSync(join(tmpdir(), "pi-eval-agent-task-"));
	if (!options.container) created.push(container);
	const id = options.id ?? "sample";
	const root = join(container, id);
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(root, "solution"), { recursive: true });
	writeFileSync(join(root, "task.json"), JSON.stringify({ id, prompt: "do the thing", ...options.config }));
	writeFileSync(join(root, "verify.json"), JSON.stringify({ checks: options.checks ?? [] }));
	writeFileSync(
		join(root, "solution", "gold.json"),
		JSON.stringify({ actions: options.goldActions ?? [], final: options.goldFinal ?? "Done." }),
	);
	for (const [name, content] of Object.entries(options.repoFiles ?? {})) {
		writeFileSync(join(repo, name), content);
	}
	return { container, root, repo };
}

const context = (workspace: string, actions: AgentAction[] = [], finalText = "Done.") =>
	new VerificationContext(workspace, actions, finalText, [], "test-task");

describe("agent task loading", () => {
	it("loads a task folder and resolves every declared path", () => {
		const { root, repo } = makeTask({
			config: { tags: ["files"], difficulty: "medium", userReply: "ok", maxActions: 7, seed: 3 },
		});
		const task = loadAgentTask(root);
		expect(task.id).toBe("sample");
		expect(task.prompt).toBe("do the thing");
		expect(task.tags).toEqual(["files"]);
		expect(task.difficulty).toBe("medium");
		expect(task.userReply).toBe("ok");
		expect(task.maxActions).toBe(7);
		expect(task.seed).toBe(3);
		expect(task.validateProfiles).toEqual(["pi_min", "medium_generic", "hermes_json_like"]);
		expect(task.root).toBe(root);
		expect(task.repoDir).toBe(repo);
		expect(task.hiddenDir).toBe(join(root, "hidden"));
		expect(task.verifyPath).toBe(join(root, "verify.json"));
		expect(task.solutionPath).toBe(join(root, "solution", "gold.json"));
		expect(task.skillsExtraDir).toBe(join(root, "skills_extra"));
	});

	it("rejects task folders missing required files", () => {
		const noConfig = makeTask();
		rmSync(join(noConfig.root, "task.json"));
		expect(() => loadAgentTask(noConfig.root)).toThrow("task.json not found");

		const noRepo = makeTask();
		rmSync(noRepo.repo, { recursive: true, force: true });
		expect(() => loadAgentTask(noRepo.root)).toThrow("repo/ directory is missing");

		const noVerify = makeTask();
		rmSync(join(noVerify.root, "verify.json"));
		expect(() => loadAgentTask(noVerify.root)).toThrow("verify.json is missing");

		const noGold = makeTask();
		rmSync(join(noGold.root, "solution"), { recursive: true, force: true });
		expect(() => loadAgentTask(noGold.root)).toThrow("solution/gold.json is missing");
	});

	it("rejects mismatched ids and malformed config", () => {
		const mismatch = makeTask({ id: "one", config: { id: "two" } });
		expect(() => loadAgentTask(mismatch.root)).toThrow("does not match folder name");
		const invalid = makeTask();
		writeFileSync(join(invalid.root, "task.json"), "{not json");
		expect(() => loadAgentTask(invalid.root)).toThrow("invalid JSON");
	});

	it("loads all task folders under the given directories", () => {
		const first = makeTask({ id: "one" });
		makeTask({ container: first.container, id: "two" });
		const tasks = loadAgentTasks([first.container]);
		expect(tasks.map((task) => task.id).sort()).toEqual(["one", "two"]);
	});
});

describe("workspace path resolution", () => {
	it("resolves paths inside the workspace and rejects escapes", () => {
		const { repo } = makeTask();
		expect(resolveWorkspacePath(repo, "a/b.txt")).toBe(join(repo, "a", "b.txt"));
		expect(resolveWorkspacePath(repo, join(repo, "x.txt"))).toBe(join(repo, "x.txt"));
		expect(() => resolveWorkspacePath(repo, "../outside.txt")).toThrow("path escapes the workspace");
		expect(() => resolveWorkspacePath(repo, join(repo, "..", "outside.txt"))).toThrow("path escapes the workspace");
	});
});

describe("declarative checks", () => {
	it("checks file existence, absence, content, and sha256", () => {
		const { repo } = makeTask({ repoFiles: { "out.txt": "hello world\n" } });
		const digest = createHash("sha256").update("hello world\n").digest("hex");
		const pass = runVerification(
			repo,
			[
				{ type: "file_exists", path: "out.txt" },
				{ type: "file_absent", path: "gone.txt" },
				{ type: "file_contains", path: "out.txt", text: "hello" },
				{ type: "file_not_contains", path: "out.txt", text: "goodbye" },
				{ type: "file_unchanged", path: "out.txt", sha256: digest },
			],
			context(repo),
		);
		expect(pass.error).toBeUndefined();
		expect(pass.checks.map((check) => check.ok)).toEqual([true, true, true, true, true]);
		expect(pass.ok).toBe(true);

		const fail = runVerification(
			repo,
			[
				{ type: "file_exists", path: "gone.txt" },
				{ type: "file_absent", path: "out.txt" },
				{ type: "file_contains", path: "out.txt", text: "goodbye" },
				{ type: "file_not_contains", path: "out.txt", text: "hello" },
				{ type: "file_unchanged", path: "out.txt", sha256: "0".repeat(64) },
			],
			context(repo),
		);
		expect(fail.ok).toBe(false);
		expect(fail.checks.every((check) => !check.ok)).toBe(true);
	});

	it("checks command exit codes and regex output with flags", () => {
		const { repo } = makeTask();
		const pass = runVerification(
			repo,
			[
				{ type: "command_exit_zero", command: 'node -e "process.exit(0)"' },
				{
					type: "command_output_matches",
					command: "node -e \"console.log('Hello Regex')\"",
					pattern: "^hello regex$",
					flags: "i",
				},
			],
			context(repo),
		);
		expect(pass.checks.map((check) => check.ok)).toEqual([true, true]);
		expect(pass.ok).toBe(true);

		const fail = runVerification(
			repo,
			[
				{ type: "command_exit_zero", command: 'node -e "process.exit(3)"' },
				{
					type: "command_output_matches",
					command: "node -e \"console.log('Hello Regex')\"",
					pattern: "^goodbye$",
					flags: "i",
				},
			],
			context(repo),
		);
		expect(fail.ok).toBe(false);
		expect(fail.checks.every((check) => !check.ok)).toBe(true);
	});

	it("checks the action log and final answer", () => {
		const { repo } = makeTask();
		const actions: AgentAction[] = [{ name: "write", args: { path: "out.txt" } }];
		const pass = runVerification(
			repo,
			[
				{ type: "action_used", name: "write" },
				{ type: "action_not_used", name: "bash" },
				{ type: "max_actions", max: 2 },
				{ type: "final_contains", text: "Done." },
			],
			context(repo, actions),
		);
		expect(pass.ok).toBe(true);

		const fail = runVerification(
			repo,
			[
				{ type: "action_used", name: "bash" },
				{ type: "action_not_used", name: "write" },
				{ type: "max_actions", max: 0 },
				{ type: "final_contains", text: "I did everything" },
			],
			context(repo, actions),
		);
		expect(fail.ok).toBe(false);
		expect(fail.checks.every((check) => !check.ok)).toBe(true);
	});

	it("finds a canary in workspace files or the final answer", () => {
		const { repo } = makeTask({ repoFiles: { "note.txt": "AGENTEVAL-CANARY-X" } });
		const fromFile = runVerification(
			repo,
			[{ type: "canary_present", canary: "AGENTEVAL-CANARY-X" }],
			context(repo, [], "no mention"),
		);
		expect(fromFile.ok).toBe(true);
		const fromFinal = runVerification(
			repo,
			[{ type: "canary_present", canary: "FINAL-CANARY" }],
			context(repo, [], "FINAL-CANARY"),
		);
		expect(fromFinal.ok).toBe(true);
		const missing = runVerification(
			repo,
			[{ type: "canary_present", canary: "NOT-THERE" }],
			context(repo, [], "no mention"),
		);
		expect(missing.ok).toBe(false);
	});

	it("rejects check paths that escape the workspace", () => {
		const { repo } = makeTask();
		const result = runVerification(
			repo,
			[{ type: "file_contains", path: "../outside.txt", text: "x" }],
			context(repo),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("path escapes the workspace");
		expect(result.checks).toEqual([]);
	});

	it("scrubs host values from detail strings", () => {
		expect(scrubHostValues(homedir())).toBe("/home/dev");
		expect(scrubHostValues(`root ${homedir()}\\project`)).not.toContain(homedir());
	});

	it("reads checks from a verify.json document", () => {
		const { root } = makeTask({ checks: [{ type: "file_exists", path: "out.txt" }] });
		expect(readVerificationChecks(join(root, "verify.json"))).toEqual([{ type: "file_exists", path: "out.txt" }]);
		expect(() => readVerificationChecks(join(root, "task.json"))).toThrow("'checks' array");
	});
});

describe("gold/Null gate", () => {
	it("accepts the canonical run and rejects a run that does nothing", () => {
		const { root } = makeTask({
			repoFiles: { "out.txt": "hello world\n" },
			checks: [
				{ type: "file_exists", path: "out.txt" },
				{ type: "file_contains", path: "out.txt", text: "hello" },
				{ type: "action_used", name: "write" },
				{ type: "final_contains", text: "Done." },
			],
			goldActions: [{ tool: "write", args: { path: "out.txt", content: "hello world\n" } }],
		});
		const validation = validateTask(loadAgentTask(root));
		expect(validation.goldOk).toBe(true);
		expect(validation.nullRejected).toBe(true);
		expect(validation.ok).toBe(true);
		expect(validation.details.summary).toContain("gold passed");
	});

	it("fails the gate when the verifier rejects the canonical run", () => {
		const { root } = makeTask({
			checks: [{ type: "file_exists", path: "never-created.txt" }],
			goldActions: [{ tool: "write", args: { path: "never-created.txt" } }],
		});
		const validation = validateTask(loadAgentTask(root));
		expect(validation.goldOk).toBe(false);
		expect(validation.ok).toBe(false);
	});
});
