import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/agent/message";

vi.mock("@/lib/agent/openui/config", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/agent/openui/config")>();
	return { ...actual, AGENT_OPENUI_BLOCKS_ENABLED: false };
});
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-highlighted-code", () => ({
	useHighlightedCode: (code: string) => code.split("\n"),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

describe("OpenUI master switch", () => {
	it("falls back to plain Markdown even when a surface opts in", () => {
		const html = renderToStaticMarkup(
			createElement(
				MessageResponse as never,
				{
					children:
						'```openui-lang\nroot = Stack([title])\ntitle = Text("Hidden")\n```',
					enableOpenUiBlocks: true,
				} as never,
			),
		);
		expect(html).not.toContain("data-openui-block");
		expect(html).toContain("openui-lang");
		expect(html).toContain("Hidden");
	});
});
