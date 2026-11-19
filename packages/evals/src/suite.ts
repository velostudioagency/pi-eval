/**
 * Builds a vitest-evals suite from declarative tasks and the active profile.
 *
 * The host runner launches one container per (suite, profile, task), so the
 * harness is created from the profile selected by environment variables.
 */

import { describeEval } from "vitest-evals";
import type { EnvironmentSpec, Profile, SuiteSpec } from "./config.ts";
import { createPiCodingAgentHarness, type PiCodingAgentHarnessOptions } from "./harness.ts";
import { createJudgesFromSpecs } from "./judges.ts";
import { harnessOptionsForProfile } from "./profile-env.ts";

/** Harness for one profile, with optional per-run overrides such as task fixtures. */
export function createProfileHarness(
	profile: Profile,
	environment: EnvironmentSpec | undefined,
	overrides: Partial<PiCodingAgentHarnessOptions> = {},
) {
	return createPiCodingAgentHarness({
		...harnessOptionsForProfile(profile, environment),
		...overrides,
	});
}

/** Registers one Vitest case per declarative task, grouped by eval set name. */
export function describeSuiteTasks(
	suite: SuiteSpec,
	profile: Profile,
	environment: EnvironmentSpec | undefined,
	overrides: Partial<PiCodingAgentHarnessOptions> = {},
): void {
	for (const task of suite.tasks ?? []) {
		const harness = createProfileHarness(profile, environment, {
			captureWorkspace: (task.judges ?? []).some((judge) => judge.type === "workspace"),
			workspaceFiles: { ...environment?.workspaceFiles, ...task.workspaceFiles },
			workspaceAssets: task.workspaceAssets,
			toolTier: environment?.toolTier,
			...overrides,
		});
		describeEval(
			task.evalSet,
			{
				harness,
				judges: createJudgesFromSpecs(task.judges),
				judgeThreshold: task.judgeThreshold ?? null,
			},
			(it) => {
				it(task.id, async ({ run }) => {
					await run(task.input);
				});
			},
		);
	}
}
