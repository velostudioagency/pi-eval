/**
 * CLI for the agent-eval-style profile/task toolchain: validate a task with
 * the gold/Null gate and compare a rendered request with a captured one.
 */

import { resolve } from "node:path";
import { compareRequests, loadRealRequest } from "./agent/fidelity.ts";
import { validateTask } from "./agent/gold.ts";
import { loadAgentProfile } from "./agent/profile-loader.ts";
import { loadAgentTask } from "./agent/task.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "validate-task") {
	const directory = args[0];
	if (!directory) throw new Error("Usage: eval:agent validate-task <task-directory>");
	const task = loadAgentTask(resolve(directory));
	const result = validateTask(task);
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = result.ok ? 0 : 1;
} else if (command === "show-profile") {
	const path = args[0];
	if (!path) throw new Error("Usage: eval:agent show-profile <profile.json>");
	const profile = loadAgentProfile(resolve(path));
	console.log(JSON.stringify(profile, null, 2));
} else if (command === "fidelity") {
	const profilePath = args[0];
	const realPath = args[1];
	if (!profilePath || !realPath) {
		throw new Error("Usage: eval:agent fidelity <profile.json> <real-request.json>");
	}
	const profile = loadAgentProfile(resolve(profilePath));
	const real = loadRealRequest(resolve(realPath));
	const ours = {
		systemPrompt: profile.prompt.template,
		toolSpecs: [],
		messages: [],
	};
	console.log(JSON.stringify(compareRequests(ours, real), null, 2));
} else {
	throw new Error("Usage: eval:agent <validate-task|show-profile|fidelity> ...");
}
