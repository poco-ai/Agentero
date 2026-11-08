import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/agent/message";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, args?: { title?: string }) =>
			args?.title ? `${key}:${args.title}` : key,
	}),
}));
vi.mock("@/hooks/use-highlighted-code", () => ({
	useHighlightedCode: (code: string) => code.split("\n"),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

function render(
	children: string,
	enableOpenUiBlocks?: boolean,
	isAnimating = false,
) {
	return renderToStaticMarkup(
		createElement(
			MessageResponse as never,
			{
				children,
				enableOpenUiBlocks,
				isAnimating,
			} as never,
		),
	);
}

describe("MessageResponse OpenUI integration", () => {
	it("renders an opt-in openui-lang fence as a structured block", () => {
		const html = render(
			'Prose before.\n\n```openui-lang\nroot = Stack([title])\ntitle = Text("Hello")\n```',
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain("Hello");
		expect(html).toContain("Prose before.");
	});

	it("keeps the plain Markdown path when the surface does not opt in", () => {
		const html = render(
			'```openui-lang\nroot = Stack([title])\ntitle = Text("Hello")\n```',
		);
		expect(html).not.toContain("data-openui-block");
		expect(html).toContain("openui-lang");
	});

	it("does not treat a fence nested inside another code block as a block", () => {
		const html = render(
			'````markdown\n```openui-lang\nroot = Stack([title])\ntitle = Text("Nested")\n```\n````',
			true,
		);
		expect(html).not.toContain("data-openui-block");
		expect(html).toContain("openui-lang");
	});

	it("accepts the shorter openui alias", () => {
		const html = render(
			'```openui\nroot = Stack([title])\ntitle = Text("Short")\n```',
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain("Short");
	});

	it("normalizes the <openui-lang> tag form only with opt-in", () => {
		const source =
			'<openui-lang>\nroot = Stack([title])\ntitle = Text("Tagged")\n</openui-lang>';
		expect(render(source, true)).toContain("data-openui-block");
		expect(render(source, true)).toContain("Tagged");
		expect(render(source)).not.toContain("data-openui-block");
	});

	it("keeps streaming state for an unclosed fence", () => {
		const html = render(
			'```openui-lang\nroot = Stack([title])\ntitle = Text("Hel',
			true,
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain('data-openui-state="streaming"');
		expect(html).toContain("Hel");
	});

	it("renders a mermaid fence through the shared editor Mermaid block", () => {
		const html = render("```mermaid\ngraph LR\n  A --> B\n```");
		expect(html).toContain("group/mermaid");
	});

	it("falls back to the source plus a short reason for invalid blocks", () => {
		const html = render(
			'```openui-lang\nroot = Stack([bad])\nbad = Unknown("x")\n```',
			true,
		);
		expect(html).toContain('data-openui-fallback="invalid"');
		expect(html).toContain("uiBlock.invalid");
		expect(html).toContain("bad = Unknown");
	});
});
