import { beforeEach, describe, expect, it, vi } from "vitest";

const { openPlazaSource } = vi.hoisted(() => ({ openPlazaSource: vi.fn() }));
vi.mock("@/lib/workspace/navigation", () => ({ openPlazaSource }));

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
import {
	feedIdFromMentionPath,
	feedMentionEntry,
	isFeedMentionPath,
	MAX_FEED_EXCERPT_CHARS,
} from "@/lib/plaza/feed-mention";
import { matchingImportedIds } from "@/lib/plaza/imported";
import {
	openPlazaMentionPath,
	subscribeFeedDetail,
	takePendingFeedDetailId,
} from "@/lib/plaza/mention-open";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";

const FEEDS_SOURCE = PLAZA_SOURCES.find((source) => source.id === "feeds");
const ARXIV_SOURCE = PLAZA_SOURCES.find((source) => source.id === "arxiv-rec");

function item(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		id: "feed-1",
		subscriptionId: "sub-1",
		subscriptionTitle: "舞蹈-CNKI",
		title: "让文艺成为人文经济的催化剂",
		url: "https://kns.cnki.net/kcms2/article/abstract?v=abc",
		publishedAt: "2026-07-20T09:00:00Z",
		summaryText: "27天，1座城，15万人次消费。",
		paperUrl: null,
		importedAt: null,
		bodyMarkdown: null,
		...overrides,
	} as FeedItem;
}

const dragItem = {
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
	takePendingFeedDetailId();
	openPlazaSource.mockClear();
});

describe("feed mention entry", () => {
	it("points at the virtual plaza path, not a Vault file", () => {
		const entry = feedMentionEntry(item());
		expect(entry.path).toBe("agentero:plaza/feeds/feed-1");
		expect(entry.source).toBe("feed");
		expect(entry.url).toBe("https://kns.cnki.net/kcms2/article/abstract?v=abc");
		expect(entry.publishedAt).toBe("2026-07-20T09:00:00Z");
		expect(entry.sourceLabel).toBe("舞蹈-CNKI");
	});

	it("prefers the paper URL and falls back to a generic source label", () => {
		const entry = feedMentionEntry(
			item({
				paperUrl: "https://arxiv.org/abs/1706.03762",
				subscriptionTitle: "",
			}),
		);
		expect(entry.url).toBe("https://arxiv.org/abs/1706.03762");
		expect(entry.sourceLabel).toBe("Feeds");
	});

	it("keeps short summaries whole and unflagged", () => {
		const entry = feedMentionEntry(item());
		expect(entry.abstract).toBe("27天，1座城，15万人次消费。");
		expect(entry.abstractTruncated).toBe(false);
	});

	it("caps a long body and marks it truncated", () => {
		const entry = feedMentionEntry(item({ summaryText: "长".repeat(900) }));
		const text = entry.abstract ?? "";
		// Cap plus the ellipsis marker.
		expect(Array.from(text)).toHaveLength(MAX_FEED_EXCERPT_CHARS + 1);
		expect(text.endsWith("…")).toBe(true);
		expect(entry.abstractTruncated).toBe(true);
	});

	it("keeps paragraph and list structure from an HTML summary", () => {
		const entry = feedMentionEntry(
			item({
				summaryText:
					"<p>First paragraph.</p><p>Second:</p><ul><li>one</li><li>two</li></ul>",
			}),
		);
		const text = entry.abstract ?? "";
		expect(text).toContain("First paragraph.\n\nSecond:");
		expect(text).toContain("- one\n- two");
		expect(text).not.toContain("<p>");
	});

	it("uses the resolved body and strips feed markup", () => {
		const entry = feedMentionEntry(
			item({
				summaryText: "<p>摘要</p>",
				bodyMarkdown: "第一段。\n\n第二段。",
			}),
		);
		expect(entry.abstract).toContain("第一段。");
		expect(entry.abstract).toContain("第二段。");
		expect(entry.abstract).not.toContain("<p>");
	});
});

describe("feed mention paths", () => {
	it("recognizes feed paths only", () => {
		expect(isFeedMentionPath("agentero:plaza/feeds/feed-1")).toBe(true);
		expect(isFeedMentionPath("agentero:plaza/arxiv-rec/2409.12345")).toBe(
			false,
		);
		expect(isFeedMentionPath("papers/a/NOTES.md")).toBe(false);
		expect(isFeedMentionPath(null)).toBe(false);
	});

	it("round-trips the item id", () => {
		const path = feedMentionEntry(item()).path;
		expect(feedIdFromMentionPath(path)).toBe("feed-1");
		expect(feedIdFromMentionPath("papers/a/NOTES.md")).toBeNull();
	});
});

describe("addFeedItemToChat", () => {
	it("registers the entry and hands the virtual path to the composer", async () => {
		const broadcast = vi.fn();
		const present = vi.fn();
		vi.doMock("@/lib/agent/context-attach", () => ({
			broadcastAgentAttachContext: broadcast,
		}));
		vi.doMock("@/lib/agent/composer-focus", () => ({
			presentAgentComposer: present,
		}));
		const { addFeedItemToChat } = await import("@/lib/plaza/feed-chat");

		addFeedItemToChat(item());

		expect(broadcast).toHaveBeenCalledWith(["agentero:plaza/feeds/feed-1"]);
		expect(present).toHaveBeenCalledTimes(1);
		expect(lookupPlazaMention("agentero:plaza/feeds/feed-1")?.title).toBe(
			"让文艺成为人文经济的催化剂",
		);
		vi.doUnmock("@/lib/agent/context-attach");
		vi.doUnmock("@/lib/agent/composer-focus");
	});
});

describe("feed drag", () => {
	it("carries the plaza mention path and registers it for send-time expansion", () => {
		const dt = fakeDataTransfer();
		beginFeedItemDrag(dt, dragItem);

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

describe("ModelScope imported ids", () => {
	it("matches a catalog arXiv id and ignores the version suffix", () => {
		const matched = matchingImportedIds(
			["2501.00001", "2501.00002v3", "not-a-paper"],
			[{ arxiv_id: "2501.00001v1", path: "papers/other" }],
		);
		expect(matched).toEqual(["2501.00001"]);
	});

	it("matches a paper whose folder name is the arXiv id", () => {
		const matched = matchingImportedIds(
			["2503.11111"],
			[{ arxiv_id: null, path: "papers\\2503.11111" }],
		);
		expect(matched).toEqual(["2503.11111"]);
	});
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
