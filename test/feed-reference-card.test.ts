// @vitest-environment happy-dom
/**
 * The feed chip's hover card is the only place a reference can be removed
 * with the pointer: clicking the chip itself opens the item instead.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedReferenceCard } from "@/components/agent/composer/feed-reference-card";
import { registerPlazaMentionEntries } from "@/lib/agent/plaza-mention";
import type { FeedItem } from "@/lib/core/bindings";
import { feedMentionEntry } from "@/lib/plaza/feed-mention";

const item = {
	id: "feed-3",
	subscriptionId: "sub-1",
	subscriptionTitle: "舞蹈-CNKI",
	title: "让文艺成为人文经济的催化剂",
	url: "https://kns.cnki.net/x",
	publishedAt: "2026-07-20T09:00:00Z",
	summaryText: "27天，1座城，15万人次消费。",
	paperUrl: null,
	importedAt: null,
	bodyMarkdown: null,
} as unknown as FeedItem;

vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-i18next")>();
	return {
		...actual,
		useTranslation: () => ({
			t: (key: string) => key.split(/[:.]/).pop() ?? key,
			i18n: { language: "zh-CN" },
		}),
	};
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	registerPlazaMentionEntries([feedMentionEntry(item)]);
});

afterEach(() => {
	registerPlazaMentionEntries([]);
	document.body.innerHTML = "";
});

describe("feed reference card", () => {
	it("previews the item and removes only from the header button", async () => {
		const onRemove = vi.fn();
		const onHoverRelease = vi.fn();
		const anchor = document.createElement("span");
		document.body.append(anchor);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		root.render(
			createElement(FeedReferenceCard, {
				path: "agentero:plaza/feeds/feed-3",
				anchor,
				onHoverHold: () => {},
				onHoverRelease,
				onRemove,
			}),
		);
		await flush();

		expect(document.body.textContent).toContain("让文艺成为人文经济的催化剂");
		expect(document.body.textContent).toContain("15万人次消费");
		expect(document.body.textContent).toContain("舞蹈-CNKI");

		// The card must allow a native text selection: the old handler called
		// preventDefault() on mousedown, which made the preview unselectable.
		const card = document.querySelector<HTMLElement>("[data-annotation-ui]");
		expect(card, "card root missing").not.toBeNull();
		expect(card?.className).toContain("select-text");
		const down = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		card?.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(false);

		const remove = document.querySelector<HTMLButtonElement>(
			"button[aria-label='remove']",
		);
		expect(remove, "no remove button rendered").not.toBeNull();

		remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await flush();

		expect(onRemove).toHaveBeenCalledWith("agentero:plaza/feeds/feed-3");
		expect(onHoverRelease).toHaveBeenCalled();

		root.unmount();
	});
});
