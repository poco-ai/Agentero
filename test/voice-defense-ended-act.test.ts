import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("voice defense transcript preview", () => {
	it("renders each preview caption without a line clamp", () => {
		const component = readFileSync(
			new URL(
				"../src/components/agent/voice-defense/ended-act.tsx",
				import.meta.url,
			),
			"utf8",
		);
		const textIndex = component.indexOf("{caption.text}");
		const paragraphIndex = component.lastIndexOf("<p", textIndex);
		const captionParagraph = component.slice(paragraphIndex, textIndex);

		expect(textIndex).toBeGreaterThan(-1);
		expect(paragraphIndex).toBeGreaterThan(-1);
		expect(captionParagraph).toContain("whitespace-pre-wrap");
		expect(captionParagraph).not.toContain("line-clamp");
	});

	it("keeps the ended footer from compositing overlapping pills while evaluating", () => {
		const component = readFileSync(
			new URL(
				"../src/components/agent/voice-defense/ended-act.tsx",
				import.meta.url,
			),
			"utf8",
		);
		const footerIndex = component.indexOf("In-flow footer");
		const footer = component.slice(footerIndex);

		expect(component).toContain("active:not-aria-[haspopup]:scale-100");
		expect(footer).toContain("flex-wrap");
		expect(footer).toContain("className={footerPrimary}");
		expect(footer).toContain("className={footerGhost}");
		expect(footer).toContain('aria-live="polite"');
		expect(footer).not.toContain("disabled={saving || reviewing}");
	});
});
