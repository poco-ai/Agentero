import { describe, expect, it } from "vitest";
import {
	planPreparedDefenseEnter,
	preparedDefenseEnterPhase,
	runPreparedDefenseEnter,
} from "@/lib/voice-defense/enter-prepared";

const ready = {
	vaultPath: "/vault",
	preparation: {
		runId: "run-1",
		stale: false,
		briefPath: "voice-defense/preparations/run-1/defense-brief.md",
	},
	context: "# Brief\nFirst question.",
	materialsMatchSnapshot: true,
};

describe("planPreparedDefenseEnter", () => {
	it("connects a ready brief before any async work", () => {
		const plan = planPreparedDefenseEnter(ready);
		expect(plan).toEqual({
			action: "connect",
			runId: "run-1",
			material: "# Brief\nFirst question.",
			source: "voice-defense/preparations/run-1/defense-brief.md",
		});
		expect(preparedDefenseEnterPhase(plan)).toBe("connecting");

		const events: string[] = [];
		events.push(preparedDefenseEnterPhase(plan));
		const later = Promise.resolve("voice");
		events.push("scheduled");
		void later.then(() => events.push("awaited"));
		expect(events[0]).toBe("connecting");
		expect(events.indexOf("connecting")).toBeLessThan(
			events.indexOf("scheduled"),
		);
	});

	it("rejects when vault, preparation, or brief text is missing", () => {
		expect(planPreparedDefenseEnter({ ...ready, vaultPath: null })).toEqual({
			action: "reject",
			reason: "unavailable",
		});
		expect(planPreparedDefenseEnter({ ...ready, preparation: null })).toEqual({
			action: "reject",
			reason: "unavailable",
		});
		expect(planPreparedDefenseEnter({ ...ready, context: "  " })).toEqual({
			action: "reject",
			reason: "unavailable",
		});
		expect(
			preparedDefenseEnterPhase(
				planPreparedDefenseEnter({ ...ready, preparation: null }),
			),
		).toBe("prepare");
	});

	it("rejects a stale snapshot before a selection mismatch", () => {
		expect(
			planPreparedDefenseEnter({
				...ready,
				preparation: { ...ready.preparation, stale: true },
				materialsMatchSnapshot: false,
			}),
		).toEqual({ action: "reject", reason: "stale" });
	});

	it("rejects when the selected materials no longer match the snapshot", () => {
		expect(
			planPreparedDefenseEnter({ ...ready, materialsMatchSnapshot: false }),
		).toEqual({ action: "reject", reason: "selection_changed" });
	});

	it("uses an empty source when the brief path is missing", () => {
		expect(
			planPreparedDefenseEnter({
				...ready,
				preparation: { runId: "run-1", stale: false, briefPath: null },
			}),
		).toEqual({
			action: "connect",
			runId: "run-1",
			material: "# Brief\nFirst question.",
			source: "",
		});
	});
});

describe("runPreparedDefenseEnter", () => {
	it("starts Voice before confirm work", async () => {
		const events: string[] = [];
		await runPreparedDefenseEnter({
			connect: async () => {
				events.push("voice-sync");
				await Promise.resolve();
				events.push("voice-async");
			},
			confirm: () => {
				events.push("confirm");
			},
		});
		expect(events[0]).toBe("voice-sync");
		expect(events.indexOf("voice-sync")).toBeLessThan(
			events.indexOf("confirm"),
		);
	});
});
