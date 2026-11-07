import { describe, expect, it } from "vitest";
import type { FeedItem } from "@/lib/core/bindings";
import {
	feedChatSelectionInput,
	feedChatSourcePath,
	feedChatText,
} from "@/lib/plaza/feed-chat-selection";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		id: "feed-1",
		subscriptionId: "sub-1",
		subscriptionTitle: "Feeds",
		title: "Attention Is All You Need",
		url: "https://example.com/a",
		publishedAt: null,
		summaryText: "The dominant sequence transduction models…",
		paperUrl: null,
		importedAt: null,
		bodyMarkdown: null,
		...overrides,
	} as FeedItem;
}

describe("feed chat selection", () => {
	it("builds a chip with the title and the RSS summary", () => {
		const payload = feedChatSelectionInput(item());
		expect(payload).not.toBeNull();
		expect(payload?.text).toContain("# Attention Is All You Need");
		expect(payload?.text).toContain("dominant sequence transduction models");
		expect(payload?.origin).toBe("markdown");
	});

	it("prefers the original article URL as the source path", () => {
		expect(
			feedChatSourcePath(
				item({
					url: "https://example.com/a",
					paperUrl: "https://arxiv.org/abs/1706.03762",
				}),
			),
		).toBe("https://example.com/a");
	});

	it("falls back to the paper URL, then the title, then the feed id", () => {
		expect(
			feedChatSourcePath(
				item({ url: null, paperUrl: "https://arxiv.org/abs/1706.03762" }),
			),
		).toBe("https://arxiv.org/abs/1706.03762");
		expect(feedChatSourcePath(item({ url: null, paperUrl: null }))).toBe(
			"Attention Is All You Need",
		);
		expect(
			feedChatSourcePath(item({ url: null, paperUrl: null, title: "" })),
		).toBe("feed:feed-1");
	});

	it("keeps the resolved full body's paragraph breaks", () => {
		const text = feedChatText(
			item({
				bodyMarkdown: "# Full body paragraph.\n\nSecond paragraph.",
			}),
		);
		expect(text).toContain("# Full body paragraph.\n\nSecond paragraph.");
	});

	it("strips HTML tags and teaser tails from the RSS summary", () => {
		const text = feedChatText(
			item({
				summaryText: "<p>real body</p><p>more</p> [...]",
			}),
		);
		expect(text).toContain("real body");
		expect(text).not.toContain("<p>");
		expect(text).not.toContain("[...]");
	});

	it("keeps CJK summaries intact", () => {
		const text = feedChatText(
			item({
				title: "顶尖舞者",
				summaryText: "<正>2026年7月20日，中国舞蹈家协会主办。",
			}),
		);
		expect(text).toContain("# 顶尖舞者");
		expect(text).toContain("2026年7月20日，中国舞蹈家协会主办。");
		expect(text).not.toContain("<正>");
	});

	it("returns null for an item with no usable text", () => {
		expect(
			feedChatSelectionInput(item({ title: "", summaryText: "" })),
		).toBeNull();
	});

	it("caps the chip text length", () => {
		const text = feedChatText(item({ summaryText: "x".repeat(9000) }));
		expect(text.length).toBeLessThanOrEqual(4000);
	});
});
