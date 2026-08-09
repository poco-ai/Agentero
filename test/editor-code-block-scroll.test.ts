import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Markdown code block scrolling", () => {
	it("keeps horizontal overflow local without trapping vertical wheel input", () => {
		const component = readFileSync(
			new URL(
				"../src/components/editor/nodes/block/code-block-node.tsx",
				import.meta.url,
			),
			"utf8",
		);
		const css = readFileSync(
			new URL("../src/index.css", import.meta.url),
			"utf8",
		);
		const rule = css.match(
			/\.agentero-scroll-both\.agentero-scroll-x-only\s*\{([^}]*)\}/,
		)?.[1];

		expect(component).toContain("agentero-scroll-x-only");
		expect(rule).toContain("overflow-y: hidden");
		expect(rule).toContain("overscroll-behavior-x: contain");
		expect(rule).toContain("overscroll-behavior-y: auto");
	});

	it("places the language selector immediately before copy in the top-right actions", () => {
		const component = readFileSync(
			new URL(
				"../src/components/editor/nodes/block/code-block-node.tsx",
				import.meta.url,
			),
			"utf8",
		);
		const actions = component.indexOf(
			'className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1"',
		);
		const language = component.indexOf("<CodeLanguageSelect />", actions);
		const copy = component.indexOf(
			"<CopyCodeButton element={props.element} />",
			actions,
		);

		expect(actions).toBeGreaterThan(-1);
		expect(language).toBeGreaterThan(actions);
		expect(copy).toBeGreaterThan(language);
		expect(component).not.toContain("absolute top-1.5 left-1.5");
	});
});
