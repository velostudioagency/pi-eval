/**
 * Baseline Nine: the nine filesystem tasks scored by fixture manifests.
 *
 * Each manifest supplies the prompt, workspace assets, family, domain and the
 * environment metadata. The suite is manifest-driven: adding a task means
 * writing its manifest, not editing scoring code here.
 */

import type { SuiteSpec, TaskSpec } from "../../src/config.ts";
import { loadManifest, manifestAssets, manifestPrompt } from "../../src/manifest.ts";

/** The nine baseline task ids. Kept in one place so the suite is easy to audit. */
export const BASELINE9_TASK_IDS = [
	"downloads-disaster",
	"what-did-we-actually-pay",
	"season-folder",
	"stale-equipment-page",
	"one-clients-doc",
	"make-it-greppable",
	"hostile-batch",
	"the-handover",
	"the-tax-pack",
] as const;

const manifests = BASELINE9_TASK_IDS.map((id) => loadManifest(id));

const tasks: TaskSpec[] = BASELINE9_TASK_IDS.map((id, index) => {
	const packageMode = manifests[index].environment?.packageMode;
	if (packageMode !== "full" && packageMode !== "bare") {
		throw new TypeError(`Manifest for task "${id}" has no valid environment.packageMode.`);
	}
	return {
		id,
		evalSet: id,
		family: manifests[index].family,
		domain: manifests[index].domain,
		metadata: {
			taskId: id,
			packageMode,
		},
		input: manifestPrompt(id),
		workspaceAssets: manifestAssets(id),
		judges: [{ type: "manifest", taskId: id }],
	};
});

const domains = [...new Set(manifests.map((manifest) => manifest.domain))].map((id) => ({ id }));
const families = [
	...new Map(
		manifests.map((manifest) => [manifest.family, { id: manifest.family, domain: manifest.domain }]),
	).values(),
];

export const baseline9Suite: SuiteSpec = {
	id: "baseline-9",
	runs: 3,
	domains,
	families,
	profiles: [{ id: "default", description: "Stock Pi prompt with its default tool set." }],
	tasks,
};
