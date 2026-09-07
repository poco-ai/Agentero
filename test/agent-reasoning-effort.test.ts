import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadReasoningEffortPref,
	resolveReasoningEffort,
	saveReasoningEffortPref,
} from "@/lib/agent/reasoning-effort";

const choices = ["low", "medium", "high", "xhigh"].map((id) => ({
	id,
	name: id,
}));

beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("Agent reasoning effort preference", () => {
	it("starts at the highest supported effort regardless of ACP list order", () => {
		expect(loadReasoningEffortPref("codex")).toBeNull();
		expect(resolveReasoningEffort(null, "low", [...choices].reverse())).toBe(
			"xhigh",
		);
		expect(
			resolveReasoningEffort(null, "low", [
				...choices,
				{ id: "max", name: "Max" },
			]),
		).toBe("max");
	});

	it("restores the selected effort after reopening despite a lower warm default", () => {
		saveReasoningEffortPref("codex", "high");
		const restored = loadReasoningEffortPref("codex");
		expect(restored).toBe("high");
		expect(resolveReasoningEffort(restored, "low", choices)).toBe("high");
	});

	it("keeps selections separate when switching agents", () => {
		saveReasoningEffortPref("codex", "xhigh");
		saveReasoningEffortPref("claude", "medium");
		expect(loadReasoningEffortPref("codex")).toBe("xhigh");
		expect(loadReasoningEffortPref("claude")).toBe("medium");
		expect(loadReasoningEffortPref("custom")).toBeNull();
		expect(loadReasoningEffortPref(null)).toBeNull();
	});

	it("uses the new model's current value without losing an unsupported preference", () => {
		saveReasoningEffortPref("codex", "xhigh");
		const reducedChoices = choices.filter((choice) => choice.id !== "xhigh");
		expect(
			resolveReasoningEffort(
				loadReasoningEffortPref("codex"),
				"medium",
				reducedChoices,
			),
		).toBe("medium");
		// Returning to the original model restores the explicit selection.
		expect(
			resolveReasoningEffort(loadReasoningEffortPref("codex"), "low", choices),
		).toBe("xhigh");
	});

	it("clears the selector value when no reasoning options are available", () => {
		expect(resolveReasoningEffort("high", "low", [])).toBeNull();
	});

	it("accepts agent-defined effort ids without assuming a fixed enum", () => {
		const customChoices = [{ id: "deep", name: "Deep thinking" }];
		expect(resolveReasoningEffort("deep", "deep", customChoices)).toBe("deep");
	});

	it("keeps the Agent current value when custom effort ordering is unknown", () => {
		const customChoices = [{ id: "deep", name: "Deep" }, ...choices];
		expect(resolveReasoningEffort(null, "deep", customChoices)).toBe("deep");
	});
});
