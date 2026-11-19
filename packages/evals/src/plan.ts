/**
 * Expands discovered eval cases into the exact (case, profile, model, run)
 * cohort a suite invocation must execute.
 */

export type DiscoveredEvalCase = {
	file: string;
	fullName: string;
	evalSet: string;
	caseId: string;
	/** Capability family, when the suite declares one for this task. */
	family?: string;
	/** Root domain owning the family. */
	domain?: string;
};

export type EvalTask = DiscoveredEvalCase & {
	profile: string;
	model: string;
	runNumber: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDiscoveredCases(value: unknown): DiscoveredEvalCase[] {
	if (!Array.isArray(value)) throw new TypeError("Discovered eval cases must be an array.");
	const identities = new Set<string>();
	return value.map((item) => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.file !== "string") {
			throw new TypeError("Discovered eval case is invalid.");
		}
		const [evalSet, caseId, ...extra] = item.name.split(" > ");
		if (!evalSet?.trim() || !caseId?.trim() || extra.length > 0) {
			throw new TypeError(`Eval case must use "<eval set> > <case>": ${item.name}`);
		}
		const identity = JSON.stringify([evalSet, caseId]);
		if (identities.has(identity)) throw new TypeError(`Duplicate eval case identity: ${item.name}`);
		identities.add(identity);
		return { file: item.file, fullName: item.name, evalSet, caseId };
	});
}

export function createTaskPlan(
	cases: readonly DiscoveredEvalCase[],
	profiles: readonly string[],
	model: string,
	runsPerProfile: number,
): EvalTask[] {
	if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
		throw new TypeError("Model identity must contain a provider and model.");
	}
	if (profiles.length === 0) throw new TypeError("A task plan needs at least one profile.");
	if (new Set(profiles).size !== profiles.length) throw new TypeError("Task plan profiles must be unique.");
	if (!Number.isSafeInteger(runsPerProfile) || runsPerProfile < 1) {
		throw new TypeError("Runs per profile must be a positive integer.");
	}
	const tasks: EvalTask[] = [];
	for (const evalCase of cases) {
		for (let runNumber = 1; runNumber <= runsPerProfile; runNumber += 1) {
			const offset = (runNumber - 1) % profiles.length;
			const ordered = [...profiles.slice(offset), ...profiles.slice(0, offset)];
			for (const profile of ordered) tasks.push({ ...evalCase, profile, model, runNumber });
		}
	}
	return tasks;
}
