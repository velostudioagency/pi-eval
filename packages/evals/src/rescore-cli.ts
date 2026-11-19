/** CLI entry point for offline rescoring of a finished eval artifact directory. */

import { resolve } from "node:path";
import { rescoreArtifacts } from "./rescore.ts";

const directory = process.argv[2];
if (!directory) {
	throw new Error("Usage: eval:rescore <artifact-directory>");
}
await rescoreArtifacts(resolve(directory));
