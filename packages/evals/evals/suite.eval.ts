/**
 * Container entry point for declarative suites. The host runner sets
 * PI_EVAL_SUITE and PI_EVAL_PROFILE for each task container.
 */

import { assertFixturesReady } from "../src/fixture-gate.ts";
import { activeProfile, activeSuite } from "../src/profile-env.ts";
import { describeSuiteTasks } from "../src/suite.ts";

const suite = activeSuite();
if (suite.id.startsWith("extraction")) assertFixturesReady();
const { profile, environment } = activeProfile(suite);
describeSuiteTasks(suite, profile, environment);
