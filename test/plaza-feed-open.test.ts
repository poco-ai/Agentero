import { beforeEach, describe, expect, it, vi } from "vitest";

const { openPlazaSource } = vi.hoisted(() => ({ openPlazaSource: vi.fn() }));
vi.mock("@/lib/workspace/navigation", () => ({ openPlazaSource }));

import {
	openFeedDetailFromMentionPath,
	subscribeFeedDetail,
	takePendingFeedDetailId,
} from "@/lib/plaza/feed-open";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";

const FEEDS_SOURCE = PLAZA_SOURCES.find((source) => source.id === "feeds");

beforeEach(() => {
	takePendingFeedDetailId();
	openPlazaSource.mockClear();
});

describe("openFeedDetailFromMentionPath", () => {
	it("opens the Plaza feeds tab and hands the item to the live view", () => {
		const seen: string[] = [];
		const unsubscribe = subscribeFeedDetail((id) => seen.push(id));

		openFeedDetailFromMentionPath("agentero:plaza/feeds/feed-9");

		expect(openPlazaSource).toHaveBeenCalledWith(FEEDS_SOURCE);
		expect(seen).toEqual(["feed-9"]);
		// A view that mounts after the click still gets the target.
		expect(takePendingFeedDetailId()).toBe("feed-9");
		expect(takePendingFeedDetailId()).toBeNull();
		unsubscribe();
	});

	it("ignores paths that are not feed items", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFeedDetail(listener);

		openFeedDetailFromMentionPath("papers/a/NOTES.md");
		openFeedDetailFromMentionPath("agentero:plaza/arxiv-rec/2409.12345");
		openFeedDetailFromMentionPath(null);

		expect(openPlazaSource).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
		expect(takePendingFeedDetailId()).toBeNull();
		unsubscribe();
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFeedDetail(listener);
		unsubscribe();

		openFeedDetailFromMentionPath("agentero:plaza/feeds/feed-1");

		expect(listener).not.toHaveBeenCalled();
		expect(takePendingFeedDetailId()).toBe("feed-1");
	});
});
