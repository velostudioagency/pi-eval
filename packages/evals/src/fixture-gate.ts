/**
 * Build-time fixture trap gate. An episode must not start when the generated
 * fixtures failed any trap assertion; otherwise a broken verifier measures
 * noise instead of the model.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assertionsPath = join(packageRoot, "fixtures", "extraction", "trap_assertions.json");

export type TrapAssertion = { trap: string; path: string; ok: boolean; detail: string };

/** Throws when the trap ledger is missing or any assertion failed. */
export function assertFixturesReady(): { all_ok: boolean; traps: TrapAssertion[] } {
	if (!existsSync(assertionsPath)) {
		throw new Error(`Fixture trap ledger missing: ${assertionsPath}. Regenerate fixtures.`);
	}
	const parsed = JSON.parse(readFileSync(assertionsPath, "utf8")) as {
		all_ok?: boolean;
		traps?: TrapAssertion[];
	};
	if (!Array.isArray(parsed.traps) || parsed.traps.length === 0) {
		throw new Error(`Fixture trap ledger has no assertions: ${assertionsPath}`);
	}
	const failed = parsed.traps.filter((trap) => !trap.ok).map((trap) => trap.trap);
	if (parsed.all_ok !== true || failed.length > 0) {
		throw new Error(`Fixture trap assertions failed: ${failed.join(", ") || "all_ok=false"}`);
	}
	return { all_ok: true, traps: parsed.traps };
}
