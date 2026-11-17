import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", async () =>
	(await import("./helpers/tauri")).makeTauriPlatform(),
);

import { decideSync, registerDecision } from "@/lib/decision/registry";
import { requestPdfSelectionIntent } from "@/lib/navigator/decision-gateway";

describe("decision gateway fallback", () => {
	it("keeps the user-provided candidate set when Host is unavailable", async () => {
		await expect(
			requestPdfSelectionIntent({
				requestId: "r1",
				stateVersion: "1",
				state: { requestedAction: "translate" },
				targetIdentity: "selection:p:s",
				contextIdentity: "ctx",
				allowedActionIds: ["translate", "explain"],
			}),
		).resolves.toEqual({
			recommendation: null,
			allowedActionIds: ["translate", "explain"],
			traceId: "navigator:r1",
		});
	});
});

describe("local decision registry", () => {
	it("returns the first matching rule, then the default", () => {
		registerDecision<{ kind: string }>({
			id: "test.local",
			description: "test decision",
			defaultAction: "default",
			rules: [
				({ kind }) => (kind === "a" ? "first" : null),
				({ kind }) => (kind === "b" ? "second" : null),
			],
		});

		expect(decideSync("test.local", { kind: "a" })).toBe("first");
		expect(decideSync("test.local", { kind: "b" })).toBe("second");
		expect(decideSync("test.local", { kind: "c" })).toBe("default");
	});

	it("resolves unknown decision ids to noop", () => {
		expect(decideSync("test.missing", {})).toBe("noop");
	});
});
