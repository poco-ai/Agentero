import { beforeEach, describe, expect, it, vi } from "vitest";

const { openPlazaSource } = vi.hoisted(() => ({ openPlazaSource: vi.fn() }));
vi.mock("@/lib/workspace/navigation", () => ({ openPlazaSource }));

import {
	openPlazaMentionPath,
	subscribeFeedDetail,
	takePendingFeedDetailId,
} from "@/lib/plaza/mention-open";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";

const FEEDS_SOURCE = PLAZA_SOURCES.find((source) => source.id === "feeds");
const ARXIV_SOURCE = PLAZA_SOURCES.find((source) => source.id === "arxiv-rec");

beforeEach(() => {
	takePendingFeedDetailId();
	openPlazaSource.mockClear();
});

describe("openPlazaMentionPath", () => {
	it("opens the Plaza feeds tab and hands the item to the live view", () => {
		const seen: string[] = [];
		const unsubscribe = subscribeFeedDetail((id) => seen.push(id));

		openPlazaMentionPath("agentero:plaza/feeds/feed-9");

		expect(openPlazaSource).toHaveBeenCalledWith(FEEDS_SOURCE);
		expect(seen).toEqual(["feed-9"]);
		// A view that mounts after the click still gets the target.
		expect(takePendingFeedDetailId()).toBe("feed-9");
		expect(takePendingFeedDetailId()).toBeNull();
		unsubscribe();
	});

	it("opens the arXiv Daily source for its items and the whole list", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFeedDetail(listener);

		openPlazaMentionPath("agentero:plaza/arxiv-rec/2409.12345");
		openPlazaMentionPath("agentero:plaza/arxiv-rec");

		expect(openPlazaSource).toHaveBeenCalledTimes(2);
		expect(openPlazaSource).toHaveBeenNthCalledWith(1, ARXIV_SOURCE);
		expect(openPlazaSource).toHaveBeenNthCalledWith(2, ARXIV_SOURCE);
		// Only feed items carry a detail target.
		expect(listener).not.toHaveBeenCalled();
		expect(takePendingFeedDetailId()).toBeNull();
		unsubscribe();
	});

	it("ignores paths that are not plaza entries", () => {
		openPlazaMentionPath("papers/a/NOTES.md");
		openPlazaMentionPath(null);

		expect(openPlazaSource).not.toHaveBeenCalled();
		expect(takePendingFeedDetailId()).toBeNull();
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFeedDetail(listener);
		unsubscribe();

		openPlazaMentionPath("agentero:plaza/feeds/feed-1");

		expect(listener).not.toHaveBeenCalled();
		expect(takePendingFeedDetailId()).toBe("feed-1");
	});
});
