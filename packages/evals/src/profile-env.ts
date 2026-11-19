/**
 * Resolves the suite and profile selected for the current container run.
 *
 * The host runner picks one suite and one profile per container and passes
 * them as environment variables; eval files then build their harness from the
 * resolved profile instead of hardcoding one arm of an experiment.
 */

import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SUITE_REGISTRY } from "../evals/suites/index.ts";
import {
	type EnvironmentSpec,
	type Profile,
	resolveEnvironment,
	resolveProfile,
	type SuiteSpec,
	type SystemPromptSpec,
} from "./config.ts";

export function suiteById(id: string): SuiteSpec {
	const suite = SUITE_REGISTRY[id];
	if (!suite) throw new TypeError(`Unknown suite "${id}". Known: ${Object.keys(SUITE_REGISTRY).join(", ")}.`);
	return suite;
}

export function activeSuite(environment: NodeJS.ProcessEnv = process.env): SuiteSpec {
	const id = environment.PI_EVAL_SUITE?.trim();
	if (!id) throw new Error("PI_EVAL_SUITE is required to run a suite.");
	return suiteById(id);
}

export function activeProfile(
	suite: SuiteSpec,
	environment: NodeJS.ProcessEnv = process.env,
): { profile: Profile; environment: EnvironmentSpec | undefined } {
	const profileId = environment.PI_EVAL_PROFILE?.trim();
	if (!profileId) throw new Error("PI_EVAL_PROFILE is required to run a suite profile.");
	const profile = resolveProfile(suite, profileId);
	return { profile, environment: resolveEnvironment(suite, profile) };
}

/** Harness option shape derived from a profile; matches the fields the harness accepts. */
export type ProfileHarnessOptions = {
	profile: string;
	systemPrompt?: SystemPromptSpec;
	tools?: CreateAgentSessionOptions["tools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	customTools?: ToolDefinition[];
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	workspaceFiles?: Readonly<Record<string, string>>;
};

/** Turns a profile and its environment into the harness options they describe. */
export function harnessOptionsForProfile(
	profile: Profile,
	environment: EnvironmentSpec | undefined,
): ProfileHarnessOptions {
	return {
		profile: profile.id,
		...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
		...(profile.tools?.tools ? { tools: profile.tools.tools } : {}),
		...(profile.tools?.noTools ? { noTools: profile.tools.noTools } : {}),
		...(profile.tools?.excludeTools ? { excludeTools: profile.tools.excludeTools } : {}),
		...(profile.tools?.customTools ? { customTools: profile.tools.customTools } : {}),
		...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
		...(environment?.workspaceFiles ? { workspaceFiles: environment.workspaceFiles } : {}),
	};
}
