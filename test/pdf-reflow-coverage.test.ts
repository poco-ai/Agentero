import { describe, expect, it } from "vitest";
import {
	characterCoverage,
	fallbackCharacterGroups,
	nonPaintingCharacters,
	rotatedCharacterIndexes,
} from "@/lib/pdf/reflow/coverage";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import type { Character } from "@/lib/pdf/reflow/types";

const chars = (text: string, x = 0, offset = 0): Character[] =>
	Array.from(text, (text, i) => ({
		index: offset + i,
		text,
		box: { x: x + i * 5, y: 0, w: 5, h: 10 },
		visualBox: { x: x + i * 5, y: 0, w: 5, h: 10 },
		style: {
			font: "Times",
			size: 10,
			bold: false,
			italic: false,
			color: { r: 0, g: 0, b: 0 },
		},
	}));
describe("reflow character coverage", () => {
	it("recovers separate plot labels without concatenating across a spatial gap", () => {
		const groups = fallbackCharacterGroups([
			...chars("Input"),
			...chars("Output", 80, 10),
		]);
		expect(groups.map((g) => g.map((c) => c.text).join(""))).toEqual([
			"Input",
			"Output",
		]);
	});
	it("accounts for unresolved and intentionally retained characters separately", () => {
		const source = chars("Text123?");
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 0, y: 0, w: 20, h: 10 },
			source.slice(0, 4),
			[],
			false,
		);
		const coverage = characterCoverage(
			source,
			[p],
			new Map([
				[4, "formula"],
				[5, "table"],
				[6, "rotated"],
			]),
		);
		expect(coverage.map((c) => c.disposition)).toEqual([
			"translated",
			"translated",
			"translated",
			"translated",
			"formula",
			"table",
			"rotated",
			"unresolved",
		]);
		expect(coverage).toHaveLength(source.length);
	});
	it("detects vertical advances without treating normal horizontal labels as rotated", () => {
		expect(rotatedCharacterIndexes(chars("Label")).size).toBe(0);
		const vertical = chars("Label").map((c, i) => ({
			...c,
			visualBox: { x: 0, y: i * 5, w: 10, h: 5 },
		}));
		expect(rotatedCharacterIndexes(vertical).size).toBe(5);
	});
});

it("uses text-object identity to retain descenders in a diagram label", () => {
	const source = chars("weight layer").map((c) => ({
		...c,
		textObjectId: 42,
		textAngle: 0,
		box: { ...c.box, y: c.text === "g" ? 3 : 0, h: 7 },
	}));
	expect(
		fallbackCharacterGroups(source).map((g) => g.map((c) => c.text).join("")),
	).toEqual(["weight layer"]);
});
it("does not resurrect transformed nonpainting text or discard ordinary math", () => {
	const ordinary = chars("x");
	const hidden = chars("Input", 20, 10).map((c) => ({
		...c,
		textObjectId: 42,
		textMatrix: [20, 0, 0, 20, 0, 0],
	}));
	const image = {
		width: 100,
		height: 20,
		data: new Uint8ClampedArray(100 * 20 * 4).fill(255),
	};
	const result = nonPaintingCharacters(
		[...ordinary, ...hidden],
		image,
		100,
		20,
	);
	expect([...result]).toEqual(hidden.map((c) => c.index));
	for (let y = 1; y < 8; y++)
		for (let x = 20; x < 45; x++) {
			const i = (y * 100 + x) * 4;
			image.data[i] = image.data[i + 1] = image.data[i + 2] = 150;
		}
	expect(nonPaintingCharacters(hidden, image, 100, 20).size).toBe(0);
});
