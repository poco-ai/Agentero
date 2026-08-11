import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/viewer/pdf/cards/selection-card", () => ({
	SelectionCard: ({ children }: { children: ReactNode }) => children,
}));

describe("PDF selection translate card", () => {
	it("renders inline LaTeX through KaTeX", () => {
		const markup = renderToStaticMarkup(
			createElement(TranslateCard, {
				screen: { x: 0, y: 0 },
				result: "能量关系是 $E=mc^2$。",
				streaming: false,
				error: null,
				onOpenSettings: () => {},
				onHide: () => {},
				onDelete: () => {},
			}),
		);

		expect(markup).toContain('class="katex"');
	});
});
