import { beforeEach, describe, expect, it, vi } from "vitest";
import { noteWikiPath } from "@/lib/lifecycle/refresh-wave";
import { getVaultPath } from "@/lib/vault/store";
import { rebuildWikiIndex } from "@/lib/wiki";
import { subscribeWikiEmbedTarget } from "@/lib/wiki/embed-refresh";
import { scheduleWikiRebuild, trackSelfWrittenPath } from "@/lib/wiki/store";

const mocks = vi.hoisted(() => ({
	noteWikiPath: vi.fn(),
}));

vi.mock("@/lib/lifecycle/refresh-wave", () => ({
	noteWikiPath: mocks.noteWikiPath,
	registerWikiRevisionBump: vi.fn(),
	clearRefreshWave: vi.fn(),
}));
vi.mock("@/lib/wiki", () => ({
	rebuildWikiIndex: vi.fn(async () => ({ added: 0, removed: 0 })),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: vi.fn(() => "/vault"),
}));

describe("wiki self-write echo filter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	it("skips the full rebuild for an app-authored write but refreshes embeds", async () => {
		trackSelfWrittenPath("/vault/notes/Self.md");
		const embedListener = vi.fn();
		const unsubscribe = subscribeWikiEmbedTarget(
			"/vault/notes/Self.md",
			embedListener,
		);

		scheduleWikiRebuild("/vault/notes/Self.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
		expect(noteWikiPath).not.toHaveBeenCalled();
		expect(embedListener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("hands external changes to the path-scoped refresh wave", async () => {
		scheduleWikiRebuild("/vault/notes/External.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
		expect(noteWikiPath).toHaveBeenCalledTimes(1);
		expect(noteWikiPath).toHaveBeenCalledWith("/vault/notes/External.md");
	});

	it("refreshes the self-write embed and forwards only the external path", async () => {
		trackSelfWrittenPath("/vault/notes/SelfBatch.md");
		const selfListener = vi.fn();
		const unsubscribeSelf = subscribeWikiEmbedTarget(
			"/vault/notes/SelfBatch.md",
			selfListener,
		);

		scheduleWikiRebuild("/vault/notes/SelfBatch.md");
		scheduleWikiRebuild("/vault/notes/ExternalBatch.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
		expect(noteWikiPath).toHaveBeenCalledTimes(1);
		expect(noteWikiPath).toHaveBeenCalledWith("/vault/notes/ExternalBatch.md");
		expect(selfListener).toHaveBeenCalledTimes(1);
		unsubscribeSelf();
	});

	it("stops suppressing once the self-write TTL expired", async () => {
		trackSelfWrittenPath("/vault/notes/Expired.md");
		await vi.advanceTimersByTimeAsync(4500);

		scheduleWikiRebuild("/vault/notes/Expired.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(noteWikiPath).toHaveBeenCalledWith("/vault/notes/Expired.md");
	});

	it("refreshes a mounted table embed without rebuilding the wiki index", async () => {
		const embedListener = vi.fn();
		const unsubscribe = subscribeWikiEmbedTarget(
			"/vault/data/results.table.json",
			embedListener,
		);

		scheduleWikiRebuild("/vault/data/results.table.json");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
		expect(noteWikiPath).not.toHaveBeenCalled();
		expect(embedListener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("does not rebuild when no vault is open", async () => {
		vi.mocked(getVaultPath).mockReturnValueOnce(null);

		scheduleWikiRebuild("/vault/notes/NoVault.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
		expect(noteWikiPath).not.toHaveBeenCalled();
	});
});
