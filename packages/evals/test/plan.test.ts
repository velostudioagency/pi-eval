import { describe, expect, it } from "vitest";
import { createTaskPlan, parseDiscoveredCases } from "../src/plan.ts";

const discovered = [{ name: "Add model > adds the model", file: "evals/models.docs.eval.ts" }];

describe("parseDiscoveredCases", () => {
	it("derives stable case identity from ordinary Vitest names", () => {
		expect(parseDiscoveredCases(discovered)).toEqual([
			{
				fullName: "Add model > adds the model",
				evalSet: "Add model",
				caseId: "adds the model",
				file: "evals/models.docs.eval.ts",
			},
		]);
	});

	it("rejects ambiguous and duplicate identities", () => {
		expect(() => parseDiscoveredCases([{ name: "adds the model", file: "model.ts" }])).toThrow("<eval set> > <case>");
		expect(() => parseDiscoveredCases([...discovered, ...discovered])).toThrow("Duplicate eval case identity");
	});
});

describe("createTaskPlan", () => {
	it("creates one isolated task per case, profile, model, and repetition", () => {
		const cases = parseDiscoveredCases(discovered);
		const tasks = createTaskPlan(cases, ["control", "treatment"], "fixture/model", 2);
		expect(tasks).toHaveLength(4);
		expect(tasks.map(({ profile, runNumber }) => [profile, runNumber])).toEqual([
			["control", 1],
			["treatment", 1],
			["treatment", 2],
			["control", 2],
		]);
	});

	it("rotates three profiles between repetitions", () => {
		const cases = parseDiscoveredCases(discovered);
		const tasks = createTaskPlan(cases, ["a", "b", "c"], "fixture/model", 2);
		expect(tasks.map(({ profile }) => profile)).toEqual(["a", "b", "c", "b", "c", "a"]);
	});

	it("carries a task family and domain into every planned arm", () => {
		const cases = parseDiscoveredCases(discovered);
		const tasks = createTaskPlan([{ ...cases[0], family: "tools", domain: "data" }], ["a"], "fixture/model", 1);
		expect(tasks[0].family).toBe("tools");
		expect(tasks[0].domain).toBe("data");
	});

	it("rejects invalid model identities, profiles, and repetitions", () => {
		const cases = parseDiscoveredCases(discovered);
		expect(() => createTaskPlan(cases, ["a"], "model", 1)).toThrow("provider and model");
		expect(() => createTaskPlan(cases, [], "fixture/model", 1)).toThrow("at least one profile");
		expect(() => createTaskPlan(cases, ["a", "a"], "fixture/model", 1)).toThrow("unique");
		expect(() => createTaskPlan(cases, ["a"], "fixture/model", 0)).toThrow("positive integer");
	});
});
