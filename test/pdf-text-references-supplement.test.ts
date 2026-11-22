import { describe, expect, it } from "vitest";
import type { PageTextRect } from "@/lib/pdf/link-text";
import { detectTextReferences } from "@/lib/pdf/text-references";

function text(
	x: number,
	y: number,
	width: number,
	content: string,
	height = 10,
): PageTextRect {
	return { rect: { origin: { x, y }, size: { width, height } }, content };
}

describe("detectTextReferences supplement labels", () => {
	it("keeps the full eLife Figure N—figure supplement M phrase", () => {
		const refs = detectTextReferences([
			text(
				40,
				100,
				280,
				"as shown in Figure 5—figure supplement 1 of the paper",
			),
		]);
		const label = refs.find((r) => r.label?.supplement != null)?.label;
		expect(label).toEqual({ kind: "figure", number: 5, supplement: 1 });
		expect(
			refs.some((r) => r.label?.number === 5 && r.label.supplement == null),
		).toBe(false);
	});

	it("parses the five standalone medical/biology supplement formats", () => {
		const cases: { content: string; supplement: number }[] = [
			{ content: "see Supplementary Figure 3", supplement: 3 },
			{ content: "see Supplemental Fig. 2", supplement: 2 },
			{ content: "see Fig. S1", supplement: 1 },
			{ content: "see Figure S12", supplement: 12 },
			{ content: "see S1 Fig for details", supplement: 1 },
		];
		for (const { content, supplement } of cases) {
			const refs = detectTextReferences([text(40, 100, 240, content)]);
			expect(
				refs.find((r) => r.label?.supplement === supplement)?.label,
				content,
			).toEqual({ kind: "figure", number: 0, supplement });
		}
	});
});
