/** Tests for backend selection and OS/runtime validation. */

import { describe, expect, it } from "vitest";
import { assertRuntime, hostOs, selectRuntime } from "../src/runtime.ts";

describe("hostOs", () => {
	it("maps Node platforms to suite OS labels", () => {
		expect(hostOs("win32")).toBe("windows");
		expect(hostOs("darwin")).toBe("macos");
		expect(hostOs("linux")).toBe("linux");
	});
});

describe("selectRuntime", () => {
	it("defaults to a Linux Docker environment", () => {
		expect(selectRuntime(undefined)).toEqual({
			backend: "docker",
			environment: undefined,
			os: "linux",
		});
	});

	it("applies CLI overrides over environment values", () => {
		const target = selectRuntime(
			{ id: "win", backend: "remote", os: "windows", runner: "https://env-runner" },
			{ backend: "host", os: "windows", runner: "https://override" },
		);
		expect(target).toMatchObject({
			backend: "host",
			os: "windows",
			runnerUrl: "https://override",
		});
	});

	it("requires a runner URL for the remote backend", () => {
		expect(() => selectRuntime({ id: "no-runner", backend: "remote", os: "linux" })).toThrow("runner URL");
	});
});

describe("assertRuntime", () => {
	it("rejects OS/backend combinations that cannot execute", () => {
		expect(() => assertRuntime(selectRuntime({ id: "bad", backend: "docker", os: "windows" }))).toThrow("linux only");
		expect(() => assertRuntime(selectRuntime({ id: "bad", backend: "host", os: "windows" }), "linux")).toThrow(
			'Use "remote"',
		);
		expect(() => assertRuntime(selectRuntime({ id: "ok", backend: "host", os: "windows" }), "windows")).not.toThrow();
	});
});
