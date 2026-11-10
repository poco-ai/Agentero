import { describe, expect, it } from "vitest";
import { SuggestionCoordinator } from "@/lib/navigator/suggestions";

describe("Navigator proactive suggestions", () => {
	it("deduplicates workflow and separates acceptance from execution", () => {
		const coordinator = new SuggestionCoordinator();
		const payload = {
			vaultId: "v",
			paperId: "p",
			path: "papers/p",
			timestamp: 1,
		};
		const first = coordinator.onAssetsReady(payload);
		expect(first?.status).toBe("pending");
		expect(coordinator.onAssetsReady(payload)).toBeNull();
		const accepted = coordinator.accept(first?.suggestionId ?? "");
		expect(accepted?.status).toBe("accepted");
		expect(accepted?.executionStatus).toBe("not-started");
		coordinator.markExecution(accepted?.suggestionId ?? "", "succeeded");
		expect(coordinator.list()).toEqual([]);
	});
	it("supports dismissal, snooze, and disabled triggers", () => {
		const coordinator = new SuggestionCoordinator();
		coordinator.setPreferences({
			disabledTriggers: new Set(["job:completed"]),
		});
		expect(
			coordinator.onJobCompleted({
				jobId: "j",
				kind: "import",
				vaultId: "v",
				paperId: "p",
				timestamp: 1,
			}),
		).toBeNull();
		const item = coordinator.onAssetsReady({
			vaultId: "v",
			paperId: "q",
			path: "papers/q",
			timestamp: 2,
		});
		coordinator.snooze(item?.suggestionId ?? "");
		expect(coordinator.list()).toEqual([]);
	});
});
