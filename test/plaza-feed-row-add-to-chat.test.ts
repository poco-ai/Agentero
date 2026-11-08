// @vitest-environment happy-dom
/**
 * UI-level check: render the real feed list row and prove the "加入对话"
 * entry point and the drag source both hand the item to the Agent as a plaza
 * reference (never as inline body text).
 *
 * Uses React's own createRoot against happy-dom — no testing-library needed.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlazaFeedItemRow } from "@/components/plaza/plaza-feeds-item";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FeedItem } from "@/lib/core/bindings";

const added: unknown[] = [];

vi.mock("@/lib/plaza/feed-chat", () => ({
	addFeedItemToChat: (item: unknown) => {
		added.push(item);
	},
}));

vi.mock("@/components/agent/message", () => ({
	MessageResponse: ({ children }: { children: unknown }) => children,
}));

// The row reads its labels through i18next; keep the real i18next runtime
// (other modules bootstrap it) but resolve `t()` to the last key segment so
// the test can assert on the real wording without a provider tree.
vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-i18next")>();
	return {
		...actual,
		useTranslation: () => ({
			t: (key: string) => key.split(".").pop() ?? key,
			i18n: { language: "zh-CN" },
		}),
	};
});

const item = {
	id: "feed-1",
	subscriptionId: "sub-1",
	subscriptionTitle: "舞蹈-CNKI",
	title: "让文艺成为人文经济的催化剂",
	url: "https://kns.cnki.net/kcms2/article/abstract?v=abc",
	publishedAt: null,
	summaryText: "27天，1座城，15万人次消费。",
	paperUrl: null,
	importedAt: null,
	bodyMarkdown: null,
} as unknown as FeedItem;

/** React's `act` is not exported by this repo's React build; a macrotask flush
 * is enough for the small state updates below. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	added.length = 0;
	document.body.innerHTML = "";
});

describe("feed list row → add to chat", () => {
	it("renders a 加入对话 entry in the row's context menu and hands over the item", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(PlazaFeedItemRow, {
					item,
					hideSource: false,
					onOpen: () => {},
					onToggleRead: () => {},
					onImport: () => {},
					importing: false,
				}),
			),
		);
		await flush();

		// The row itself must render the title.
		expect(host.textContent).toContain("让文艺成为人文经济的催化剂");

		// Radix context menus render on open; open it via the trigger.
		const trigger = host.querySelector("[data-slot='context-menu-trigger']");
		expect(trigger).not.toBeNull();

		trigger?.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 10,
				clientY: 10,
			}),
		);
		await flush();

		const menuItems = Array.from(
			document.querySelectorAll("[role='menuitem']"),
		);
		// The existing "import" entry must stay alongside the new one.
		expect(menuItems.some((el) => el.textContent?.includes("import"))).toBe(
			true,
		);
		// `t()` is mocked to the last key segment, so the label reads "addToChat".
		const menuItem = menuItems.find((el) =>
			el.textContent?.includes("addToChat"),
		);
		expect(menuItem, "no addToChat menu item rendered").not.toBeUndefined();

		menuItem?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await flush();

		expect(added).toEqual([item]);

		root.unmount();
	});

	it("makes the card a drag source for the Agent composer", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(PlazaFeedItemRow, {
					item,
					hideSource: false,
					onOpen: () => {},
					onToggleRead: () => {},
					onImport: () => {},
					importing: false,
				}),
			),
		);
		await flush();

		const card = host.querySelector("[draggable='true']");
		expect(card, "feed card is not draggable").not.toBeNull();

		const data = new Map<string, string>();
		const dataTransfer = {
			effectAllowed: "none",
			get types() {
				return [...data.keys()];
			},
			setData: (type: string, value: string) => data.set(type, value),
			getData: (type: string) => data.get(type) ?? "",
		};
		card?.dispatchEvent(
			Object.assign(
				new Event("dragstart", { bubbles: true, cancelable: true }),
				{ dataTransfer },
			),
		);
		await flush();

		expect(data.get("application/x-agentero-plaza-feed")).toBe(
			"agentero:plaza/feeds/feed-1",
		);

		root.unmount();
	});
});
