// @vitest-environment happy-dom
/**
 * UI-level check: render the real feed list row and prove the "加入对话"
 * entry point exists and publishes the whole item as an Agent chip.
 *
 * Uses React's own createRoot against happy-dom — no testing-library needed.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlazaFeedItemRow } from "@/components/plaza/plaza-feeds-item";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FeedItem } from "@/lib/core/bindings";

const published: unknown[] = [];

vi.mock("@/components/selection/add-selection-to-chat", () => ({
	addSelectionToChat: (payload: unknown) => {
		published.push(payload);
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

afterEach(() => {
	published.length = 0;
	document.body.innerHTML = "";
});

describe("feed list row → add to chat", () => {
	it("renders a 加入对话 entry in the row's context menu and publishes the item", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		await act(async () => {
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
		});

		// The row itself must render the title.
		expect(host.textContent).toContain("让文艺成为人文经济的催化剂");

		// Radix context menus render on open; open it via the trigger.
		const trigger = host.querySelector("[data-slot='context-menu-trigger']");
		expect(trigger).not.toBeNull();

		await act(async () => {
			trigger?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: 10,
					clientY: 10,
				}),
			);
		});

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

		await act(async () => {
			menuItem?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});

		expect(published).toHaveLength(1);
		const payload = published[0] as {
			text: string;
			sourcePath: string;
			origin: string;
		};
		expect(payload.origin).toBe("markdown");
		expect(payload.sourcePath).toBe(item.url);
		expect(payload.text).toContain("# 让文艺成为人文经济的催化剂");
		expect(payload.text).toContain("15万人次消费");

		root.unmount();
	});
});
