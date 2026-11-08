import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	lookupPlazaMention,
	registerPlazaMentionEntries,
} from "@/lib/agent/plaza-mention";
import type { FeedItem } from "@/lib/core/bindings";
import {
	feedIdFromMentionPath,
	feedMentionEntry,
	isFeedMentionPath,
	MAX_FEED_EXCERPT_CHARS,
} from "@/lib/plaza/feed-mention";

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

beforeEach(() => {
	registerPlazaMentionEntries([]);
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
