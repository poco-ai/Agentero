import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({
		t: (key: string) => {
			const dict: Record<string, string> = {
				"selection.menuLabel": "选区操作",
				"selection.note": "批注",
				"selection.chatActions": "对话操作",
				"selection.translate": "翻译",
				"selection.copy": "复制",
				"selection.quickChat": "快速对话",
				"selection.addToChat": "加入对话",
			};
			return dict[key] ?? key;
		},
	}),
}));

import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";

describe("SelectionMenu", () => {
	const baseProps = {
		screen: { x: 100, y: 100 },
		onHighlight: vi.fn(),
		onAsk: vi.fn(),
		onAddToChat: vi.fn(),
		onTranslate: vi.fn(),
		showHighlight: true,
		showTranslate: true,
	};

	it("renders the copy button after translate and before add to chat when onCopy is provided", () => {
		const html = renderToStaticMarkup(
			createElement(SelectionMenu, {
				...baseProps,
				onCopy: vi.fn(),
				onNote: vi.fn(),
			}),
		);

		expect(html).toContain("复制");
		expect(html).toContain("加入对话");
		expect(html).not.toContain("快速对话");
		expect(html).toContain('aria-label="对话操作"');

		expect(html.indexOf('aria-label="批注 N"')).toBeLessThan(
			html.indexOf('aria-label="翻译 T"'),
		);
		const translateIdx = html.indexOf('aria-label="翻译 T"');
		const copyIdx = html.indexOf("复制");
		const addToChatIdx = html.indexOf("加入对话");
		const chatMenuIdx = html.indexOf('aria-label="对话操作"');

		expect(translateIdx).toBeGreaterThan(-1);
		expect(copyIdx).toBeGreaterThan(translateIdx);
		expect(addToChatIdx).toBeGreaterThan(copyIdx);
		expect(chatMenuIdx).toBeGreaterThan(addToChatIdx);
	});

	it("omits the copy button when onCopy is not provided", () => {
		const html = renderToStaticMarkup(
			createElement(SelectionMenu, {
				...baseProps,
			}),
		);

		expect(html).not.toContain("复制");
		expect(html).toContain("加入对话");
		expect(html).not.toContain("快速对话");
		expect(html).toContain('aria-label="对话操作"');
	});
});
