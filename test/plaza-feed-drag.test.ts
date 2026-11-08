import { beforeEach, describe, expect, it } from "vitest";
import {
	lookupPlazaMention,
	registerPlazaMentionEntries,
} from "@/lib/agent/plaza-mention";
import type { FeedItem } from "@/lib/core/bindings";
import {
	beginFeedItemDrag,
	draggedFeedMentionPath,
	isFeedItemDrag,
	PLAZA_FEED_DRAG_TYPE,
} from "@/lib/plaza/feed-drag";

const item = {
	id: "feed-7",
	subscriptionId: "sub-1",
	subscriptionTitle: "arXiv",
	title: "Attention Is All You Need",
	url: null,
	publishedAt: null,
	summaryText: "The dominant sequence transduction models…",
	paperUrl: "https://arxiv.org/abs/1706.03762",
	importedAt: null,
	bodyMarkdown: null,
} as unknown as FeedItem;

function fakeDataTransfer() {
	const data = new Map<string, string>();
	return {
		effectAllowed: "none",
		get types() {
			return [...data.keys()];
		},
		setData: (type: string, value: string) => data.set(type, value),
		getData: (type: string) => data.get(type) ?? "",
	} as unknown as DataTransfer;
}

beforeEach(() => {
	registerPlazaMentionEntries([]);
});

describe("feed drag", () => {
	it("carries the plaza mention path and registers it for send-time expansion", () => {
		const dt = fakeDataTransfer();
		beginFeedItemDrag(dt, item);

		expect(dt.getData(PLAZA_FEED_DRAG_TYPE)).toBe(
			"agentero:plaza/feeds/feed-7",
		);
		expect(dt.effectAllowed).toBe("copy");
		expect(isFeedItemDrag(dt)).toBe(true);
		expect(draggedFeedMentionPath(dt)).toBe("agentero:plaza/feeds/feed-7");
		// The drop target resolves the chip without the row that started it.
		expect(lookupPlazaMention("agentero:plaza/feeds/feed-7")?.title).toBe(
			"Attention Is All You Need",
		);
	});

	it("ignores every other drag", () => {
		const dt = fakeDataTransfer();
		dt.setData("text/plain", "papers/a/NOTES.md");
		expect(isFeedItemDrag(dt)).toBe(false);
		expect(draggedFeedMentionPath(dt)).toBeNull();
	});
});
