import { describe, expect, it } from "vitest";
import { markModelPicked, takeModelPickForce } from "@/lib/agent/api";

// The pending pick map is module-level state (one-shot per webview). Each test
// uses its own agent id so cases never consume another case's pick.
describe("explicit model pick forces one ACP set", () => {
	it("forces the next matching turn exactly once", () => {
		markModelPicked("force-once", "opus");
		expect(takeModelPickForce("force-once", "opus")).toBe(true);
		// Consumed: the following turn goes back to the normal dedupe path.
		expect(takeModelPickForce("force-once", "opus")).toBe(false);
	});

	it("does not force a turn for another agent and keeps the pick pending", () => {
		markModelPicked("force-other-agent", "opus");
		expect(takeModelPickForce("someone-else", "opus")).toBe(false);
		expect(takeModelPickForce("force-other-agent", "opus")).toBe(true);
	});

	it("does not force a different model and keeps the picked model pending", () => {
		markModelPicked("force-other-model", "opus");
		expect(takeModelPickForce("force-other-model", "sonnet")).toBe(false);
		expect(takeModelPickForce("force-other-model", "opus")).toBe(true);
	});

	it("keeps the latest pick when the user re-picks the same agent", () => {
		markModelPicked("force-repick", "opus");
		markModelPicked("force-repick", "haiku");
		expect(takeModelPickForce("force-repick", "opus")).toBe(false);
		expect(takeModelPickForce("force-repick", "haiku")).toBe(true);
	});

	it("never forces without both an agent and a model", () => {
		markModelPicked("force-empty", "opus");
		expect(takeModelPickForce(null, "opus")).toBe(false);
		expect(takeModelPickForce(undefined, "opus")).toBe(false);
		expect(takeModelPickForce("", "opus")).toBe(false);
		expect(takeModelPickForce("force-empty", null)).toBe(false);
		expect(takeModelPickForce("force-empty", undefined)).toBe(false);
		expect(takeModelPickForce("force-empty", "")).toBe(false);
		// The valid pending pick survived all of the misses above.
		expect(takeModelPickForce("force-empty", "opus")).toBe(true);
	});

	it("ignores blank marks that cannot identify a pick", () => {
		markModelPicked("", "opus");
		markModelPicked("force-blank", "");
		expect(takeModelPickForce("force-blank", "opus")).toBe(false);
	});
});
