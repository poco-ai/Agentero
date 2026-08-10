import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVaultPath } from "@/lib/vault/store";
import { rebuildWikiIndex } from "@/lib/wiki";
import { scheduleWikiRebuild, trackSelfWrittenPath } from "@/lib/wiki/store";
import { subscribeWikiEmbedTarget } from "@/lib/wiki-embed-refresh";

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
		expect(embedListener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("still rebuilds for external changes", async () => {
		scheduleWikiRebuild("/vault/notes/External.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).toHaveBeenCalledTimes(1);
		expect(rebuildWikiIndex).toHaveBeenCalledWith("/vault");
	});

	it("rebuilds once and refreshes all embeds on a mixed self/external batch", async () => {
		trackSelfWrittenPath("/vault/notes/SelfBatch.md");
		const selfListener = vi.fn();
		const externalListener = vi.fn();
		const unsubscribeSelf = subscribeWikiEmbedTarget(
			"/vault/notes/SelfBatch.md",
			selfListener,
		);
		const unsubscribeExternal = subscribeWikiEmbedTarget(
			"/vault/notes/ExternalBatch.md",
			externalListener,
		);

		scheduleWikiRebuild("/vault/notes/SelfBatch.md");
		scheduleWikiRebuild("/vault/notes/ExternalBatch.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).toHaveBeenCalledTimes(1);
		expect(selfListener).toHaveBeenCalledTimes(1);
		expect(externalListener).toHaveBeenCalledTimes(1);
		unsubscribeSelf();
		unsubscribeExternal();
	});

	it("stops suppressing once the self-write TTL expired", async () => {
		trackSelfWrittenPath("/vault/notes/Expired.md");
		await vi.advanceTimersByTimeAsync(4500);

		scheduleWikiRebuild("/vault/notes/Expired.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).toHaveBeenCalledTimes(1);
	});

	it("does not rebuild when no vault is open", async () => {
		vi.mocked(getVaultPath).mockReturnValueOnce(null);

		scheduleWikiRebuild("/vault/notes/NoVault.md");
		await vi.advanceTimersByTimeAsync(900);

		expect(rebuildWikiIndex).not.toHaveBeenCalled();
	});
});
