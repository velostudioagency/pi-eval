/** Compare a rendered profile request with a captured real request. */

export type FidelityStatus = "PASS" | "WARN" | "FAIL";

export type FidelityDiff = {
	name: string;
	status: FidelityStatus;
	detail: string;
};

export type RenderedRequest = {
	systemPrompt: string;
	toolSpecs: unknown[];
	messages: unknown[];
};

const MARKERS: ReadonlyArray<readonly [name: string, marker: string]> = [
	["environment", "<environment>"],
	["tools", "# Available tools"],
	["tools", "<tools>"],
	["skills", "<available_skills>"],
	["project_context", "<project_context>"],
	["agents", "AGENTS.md"],
];

function asRecordOr(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
	return asRecordOr(value, {});
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Parse a real request from JSON text or an object, unwrapping request/payload. */
export function loadRealRequest(input: unknown): Record<string, unknown> {
	let loaded = input;
	if (typeof input === "string") {
		try {
			loaded = JSON.parse(input.replace(/^\uFEFF/, ""));
		} catch {
			throw new Error("real request must be valid JSON");
		}
	}
	if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
		throw new Error("real request JSON must be an object");
	}
	const record = loaded as Record<string, unknown>;
	for (const key of ["request", "payload"]) {
		const nested = asRecord(record[key]);
		if ("messages" in nested || "input" in nested) return nested;
	}
	return record;
}

/** Project a Responses-API `input` onto chat `messages` for comparison. */
function responsesToChat(real: Record<string, unknown>): Record<string, unknown> {
	if ("messages" in real) return real;
	const messages: Record<string, unknown>[] = [];
	for (const item of asArray(real.input)) {
		const record = asRecord(item);
		if (record.type !== "message") continue;
		let role = asString(record.role);
		if (role === "developer") role = "system";
		if (role !== "system" && role !== "user" && role !== "assistant") continue;
		const content = record.content;
		const texts: string[] = [];
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) {
			for (const part of content) {
				const text = asString(asRecord(part).text);
				if (text) texts.push(text);
			}
		}
		if (texts.length) messages.push({ role, content: texts.join("\n") });
	}
	return { ...real, messages };
}

function systemText(messages: Record<string, unknown>[]): string {
	for (const message of messages) {
		if (message.role !== "system") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return asArray(content)
			.map((part) => asString(asRecord(part).text))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function sectionOrder(text: string): string[] {
	const located: Array<[index: number, name: string]> = [];
	for (const [name, marker] of MARKERS) {
		const index = text.indexOf(marker);
		if (index >= 0) located.push([index, name]);
	}
	located.sort((left, right) => left[0] - right[0]);
	return located.map(([, name]) => name);
}

function addSpec(specs: Map<string, Record<string, unknown>>, tool: Record<string, unknown>): void {
	let spec = asRecordOr(tool.function, tool);
	let name = asString(spec.name);
	if (!name) {
		const candidate = asString(tool.type);
		if (!candidate || candidate === "function") return;
		name = candidate;
		spec = tool;
	}
	if (!specs.has(name)) specs.set(name, spec);
}

function toolSpecs(tools: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
	const specs = new Map<string, Record<string, unknown>>();
	for (const tool of tools) {
		const nested = asArray(tool.tools);
		if (tool.type === "namespace" && nested.length) {
			for (const sub of nested) addSpec(specs, asRecord(sub));
			continue;
		}
		addSpec(specs, tool);
	}
	return specs;
}

function paramNames(spec: Record<string, unknown>): string[] {
	return Object.keys(asRecord(asRecord(spec.parameters).properties));
}

function sameSequence(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setEquals(left: string[], right: string[]): boolean {
	const rightSet = new Set(right);
	return rightSet.size === new Set(left).size && left.every((value) => rightSet.has(value));
}

function sameMultiset(left: string[], right: string[]): boolean {
	return sameSequence([...left].sort(), [...right].sort());
}

function status(ok: boolean, warn: boolean): FidelityStatus {
	return ok ? "PASS" : warn ? "WARN" : "FAIL";
}

function label(values: string[]): string {
	return values.length ? `[${values.join(", ")}]` : "none";
}

/** Diff section order, tool names/parameters, and message roles against a real request. */
export function compareRequests(ours: RenderedRequest, real: unknown): FidelityDiff[] {
	const normalized = responsesToChat(loadRealRequest(real));
	const realMessages = asArray(normalized.messages).map(asRecord);
	const realTools = asArray(normalized.tools).map(asRecord);

	const ourOrder = sectionOrder(ours.systemPrompt);
	const realOrder = sectionOrder(systemText(realMessages));
	const diffs: FidelityDiff[] = [
		{
			name: "section order",
			status: status(sameSequence(ourOrder, realOrder), !ourOrder.length || !realOrder.length),
			detail: `ours=${label(ourOrder)} real=${label(realOrder)}`,
		},
	];

	const ourSpecs = toolSpecs(ours.toolSpecs.map(asRecord));
	const realSpecs = toolSpecs(realTools);
	const ourNames = [...ourSpecs.keys()];
	const realNames = [...realSpecs.keys()];
	diffs.push({
		name: "tool names",
		status: status(sameSequence(ourNames, realNames), setEquals(ourNames, realNames)),
		detail: `ours=${label(ourNames)} real=${label(realNames)}`,
	});
	diffs.push({
		name: "tool count",
		status: ourNames.length === realNames.length ? "PASS" : "FAIL",
		detail: `ours=${ourNames.length} real=${realNames.length}`,
	});

	const shared = ourNames.filter((name) => realSpecs.has(name));
	let paramStatus: FidelityStatus;
	let paramDetail: string;
	if (!shared.length) {
		paramStatus = "FAIL";
		paramDetail = "no shared tool names";
	} else {
		const schemas = shared.filter((name) => {
			const parameters = asRecord(realSpecs.get(name)).parameters;
			return parameters !== null && typeof parameters === "object" && !Array.isArray(parameters);
		});
		if (!schemas.length) {
			paramStatus = "WARN";
			paramDetail = `no parameter schemas in the capture for ${shared.length} shared tool(s)`;
		} else {
			const missing: Record<string, string[]> = {};
			const extra: Record<string, string[]> = {};
			for (const name of schemas) {
				const ourParams = new Set(paramNames(asRecord(ourSpecs.get(name))));
				const realParams = new Set(paramNames(asRecord(realSpecs.get(name))));
				const absent = [...realParams].filter((value) => !ourParams.has(value)).sort();
				const added = [...ourParams].filter((value) => !realParams.has(value)).sort();
				if (absent.length) missing[name] = absent;
				if (added.length) extra[name] = added;
			}
			if (!Object.keys(missing).length && !Object.keys(extra).length) {
				paramStatus = "PASS";
				paramDetail = `matched parameters for ${schemas.length} tool(s)`;
			} else if (!Object.keys(missing).length) {
				paramStatus = "WARN";
				paramDetail = `extra optional parameters: ${JSON.stringify(extra)}`;
			} else {
				paramStatus = "FAIL";
				paramDetail = `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`;
			}
		}
		if (!setEquals(ourNames, realNames)) {
			paramStatus = "FAIL";
			paramDetail = `tool sets differ; compared ${shared.length} shared tool(s): ${paramDetail}`;
		}
	}
	diffs.push({ name: "parameter names", status: paramStatus, detail: paramDetail });

	const ourRoles = ours.messages.map((message) => asString(asRecord(message).role));
	const realRoles = realMessages.map((message) => asString(message.role));
	diffs.push({
		name: "message roles",
		status: status(sameSequence(ourRoles, realRoles), sameMultiset(ourRoles, realRoles)),
		detail: `ours=${label(ourRoles)} real=${label(realRoles)}`,
	});

	return diffs;
}
