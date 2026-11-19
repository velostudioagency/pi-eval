/** Tests for declarative suite validation and profile resolution. */

import { describe, expect, it } from "vitest";
import {
	describeSuite,
	resolveChatTemplate,
	resolveEnvironment,
	resolveProfile,
	type SuiteSpec,
	validateSuite,
} from "../src/config.ts";
import { suiteById } from "../src/profile-env.ts";

const baseSuite = (): SuiteSpec => ({
	id: "fixture",
	profiles: [{ id: "default", systemPrompt: { kind: "pi-default" } }],
	tasks: [{ id: "t1", evalSet: "smoke", input: "hello", judges: [{ type: "exact", expected: "hi" }] }],
});

describe("suite validation", () => {
	it("accepts a declarative suite and describes it without functions", () => {
		const suite = validateSuite(baseSuite());
		expect(suite).toEqual(baseSuite());
		const description = describeSuite({
			...suite,
			profiles: [
				{
					id: "custom",
					systemPrompt: { kind: "transform", id: "uppercase", transform: (text) => text.toUpperCase() },
				},
			],
		}) as { profiles: Array<{ systemPrompt: { id?: string; transform?: unknown } }> };
		expect(description.profiles[0].systemPrompt).toEqual({ kind: "transform", id: "uppercase" });
		expect(description.profiles[0].systemPrompt.transform).toBeUndefined();
	});

	it("rejects suites that cannot be planned", () => {
		expect(() => validateSuite({ ...baseSuite(), id: " " })).toThrow("id must not be empty");
		expect(() => validateSuite({ ...baseSuite(), profiles: [] })).toThrow("no profiles");
		expect(() => validateSuite({ ...baseSuite(), evalFiles: ["evals/x.eval.ts"] })).toThrow("either evalFiles");
		expect(() =>
			validateSuite({
				...baseSuite(),
				tasks: [
					{ id: "t", evalSet: "e", input: "a" },
					{ id: "t", evalSet: "e", input: "b" },
				],
			}),
		).toThrow("Duplicate task identity");
		expect(() => validateSuite({ ...baseSuite(), comparison: { control: "a", treatment: "b" } })).toThrow();
		expect(() => validateSuite({ ...baseSuite(), runs: 0 })).toThrow("positive integer");
	});

	it("resolves profile environments by id or inline definition", () => {
		const suite: SuiteSpec = {
			...baseSuite(),
			environments: [{ id: "no-docs", includeDocs: false }],
			profiles: [
				{ id: "a", environment: "no-docs" },
				{ id: "b", environment: { id: "inline", includeDocs: true } },
				{ id: "c" },
			],
		};
		expect(resolveEnvironment(suite, resolveProfile(suite, "a"))).toEqual({ id: "no-docs", includeDocs: false });
		expect(resolveEnvironment(suite, resolveProfile(suite, "b"))?.id).toBe("inline");
		expect(resolveEnvironment(suite, resolveProfile(suite, "c"))).toBeUndefined();
		expect(() => resolveProfile(suite, "missing")).toThrow("Unknown profile");
		expect(() =>
			resolveEnvironment(
				{ ...suite, profiles: [{ id: "d", environment: "missing" }] },
				{ id: "d", environment: "missing" },
			),
		).toThrow("unknown environment");
	});

	it("rejects unsupported OS and backend combinations", () => {
		expect(() =>
			validateSuite({
				...baseSuite(),
				profiles: [{ id: "p", environment: { id: "win", backend: "docker", os: "windows" } }],
			}),
		).toThrow("Docker supports linux only");
		expect(() =>
			validateSuite({
				...baseSuite(),
				profiles: [{ id: "p", environment: { id: "win", backend: "remote", os: "windows" } }],
			}),
		).toThrow("without a runner URL");
		expect(() =>
			validateSuite({
				...baseSuite(),
				profiles: [{ id: "p", environment: { id: "win", backend: "host", os: "windows", runner: "https://r" } }],
			}),
		).not.toThrow();
	});

	it("validates capability families", () => {
		const suite: SuiteSpec = {
			...baseSuite(),
			families: [{ id: "tools", description: "Tool use" }],
			tasks: [{ id: "t", evalSet: "e", input: "hello", family: "tools" }],
		};
		expect(validateSuite(suite)).toBe(suite);
		expect((describeSuite(suite) as { families: unknown[] }).families).toEqual(suite.families);
		expect(() =>
			validateSuite({
				...suite,
				tasks: [{ id: "t", evalSet: "e", input: "hello", family: "missing" }],
			}),
		).toThrow("undeclared family");
		expect(() => validateSuite({ ...suite, families: [{ id: "a" }, { id: "a" }] })).toThrow("duplicate families");
	});

	it("validates root domains", () => {
		const suite: SuiteSpec = {
			...baseSuite(),
			domains: [{ id: "data-manipulation" }],
			families: [{ id: "read", domain: "data-manipulation" }],
			tasks: [{ id: "t", evalSet: "e", input: "hello", family: "read", domain: "data-manipulation" }],
		};
		expect(validateSuite(suite)).toBe(suite);
		expect((describeSuite(suite) as { domains: unknown[] }).domains).toEqual(suite.domains);
		expect(() =>
			validateSuite({
				...suite,
				families: [{ id: "read", domain: "missing" }],
			}),
		).toThrow("undeclared domain");
		expect(() => validateSuite({ ...suite, domains: [{ id: "x" }, { id: "x" }] })).toThrow("duplicate domains");
	});

	it("resolves built-in chat templates", () => {
		for (const name of ["chatml", "hermes", "deepseek", "llama3"]) {
			expect(resolveChatTemplate(name).id).toBe(name);
		}
		expect(() => resolveChatTemplate("missing")).toThrow("Unknown chat template");
	});
});

describe("registered suites", () => {
	it("keeps the docs comparison and a declarative example available", () => {
		const docs = suiteById("docs");
		expect(docs.comparison).toEqual({ control: "without_docs", treatment: "with_docs" });
		expect(docs.evalFiles).toHaveLength(6);
		expect(validateSuite(docs)).toBe(docs);
		const example = suiteById("example");
		expect(example.tasks?.length).toBeGreaterThan(0);
		expect(validateSuite(example)).toBe(example);
		const organized = suiteById("data-manipulation-read-organize");
		expect(organized.tasks).toHaveLength(9);
		expect(organized.domains?.[0].id).toBe("data-manipulation");
		expect(organized.families?.map(({ id }) => id)).toEqual([
			"data-manipulation-read-organize",
			"data-manipulation-read-editing-writing",
			"data-extraction",
			"data-manipulation",
		]);
		expect(organized.tasks?.every((task) => task.domain === "data-manipulation")).toBe(true);
		expect(validateSuite(organized)).toBe(organized);
		const extraction = suiteById("extraction");
		expect(extraction.tasks).toHaveLength(4);
		expect(extraction.profiles[0].tools).toBeUndefined();
		expect(Object.keys(extraction.tasks?.[0].workspaceAssets ?? {}).length).toBeGreaterThan(0);
		expect(validateSuite(extraction)).toBe(extraction);
		const minimal = suiteById("extraction-minimal");
		expect(minimal.environments?.[0].toolTier).toBe("minimal");
		expect(validateSuite(minimal)).toBe(minimal);
		expect(() => suiteById("missing")).toThrow("Unknown suite");
	});
});
