/**
 * Registered eval suites. The host runner selects one by id with `--suite`,
 * and the container resolves the same id through `PI_EVAL_SUITE`.
 */

import type { SuiteSpec } from "../../src/config.ts";
import { docsSuite } from "./docs.ts";
import { dataManipulationReadOrganizeSuite } from "./data-manipulation-read-organize.ts";
import { baseline9Suite } from "./baseline-9.ts";
import { extractionMinimalSuite, extractionSuite } from "./extraction.ts";
import { exampleSuite } from "./example.ts";

export const SUITE_REGISTRY: Record<string, SuiteSpec> = {
	[docsSuite.id]: docsSuite,
	[baseline9Suite.id]: baseline9Suite,
	[exampleSuite.id]: exampleSuite,
	[dataManipulationReadOrganizeSuite.id]: dataManipulationReadOrganizeSuite,
	[extractionSuite.id]: extractionSuite,
	[extractionMinimalSuite.id]: extractionMinimalSuite,
};
