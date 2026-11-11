import { describe, expect, it } from "vitest";
import {
	readingFormulaMetrics,
	readingInlineParts,
} from "@/lib/pdf/reading/inline";
import type { Paragraph } from "@/lib/pdf/reflow/types";

const paragraph: Paragraph = {
	id: "p",
	pageIndex: 0,
	box: { x: 0, y: 0, w: 500, h: 100 },
	characters: [],
	styles: {},
	source: "See [99, 134] and R = ΔT∕J",
	protectedText: "See ⟪F0⟫, ⟪F1⟫ and ⟪F2⟫",
	style: {
		font: "Times",
		size: 10,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	},
	firstLineIndent: 0,
	heading: false,
	formulas: [
		{
			id: "0",
			text: "[99",
			box: { x: 10, y: 10, w: 12, h: 8 },
			baselineOffset: -0.8,
			characterIndexes: [],
		},
		{
			id: "1",
			text: "134]",
			box: { x: 25, y: 10, w: 16, h: 8 },
			baselineOffset: -0.8,
			characterIndexes: [],
		},
		{
			id: "2",
			text: "R = ΔT∕J",
			box: { x: 45, y: 10, w: 42, h: 9 },
			baselineOffset: -0.8,
			characterIndexes: [],
		},
	],
};

describe("reading inline content", () => {
	it("separates a linked superscript from an adjacent mathematical crop", () => {
		const text = "× 106 41";
		const characters = [...text].map((text, index) => ({
			index,
			text,
			style: paragraph.style,
			box: { x: index * 5, y: 10, w: 5, h: 10 },
			visualBox: { x: index * 5, y: 12, w: 5, h: 7 },
		}));
		const p = {
			...paragraph,
			characters,
			formulas: [
				{
					...paragraph.formulas[0],
					text,
					characterIndexes: characters.map((c) => c.index),
				},
			],
		};
		const out = readingInlineParts("⟪F0⟫", p, [{ start: 6, end: 8 }]);
		expect(out.parts.map((p) => [p.text, p.raster])).toEqual([
			["× 106 ", true],
			["41", false],
		]);
		expect(out.parts[0].formula?.box.w).toBe(25);
	});
	it("ignores a text object baseline belonging to a different physical line", () => {
		const formula = {
			id: "0",
			text: "R = x/y",
			box: { x: 50, y: 95, w: 30, h: 8 },
			baselineOffset: 1,
			characterIndexes: [1],
		};
		const p: Paragraph = {
			...paragraph,
			characters: [0, 1].map((index) => ({
				index,
				text: index ? "R" : "T",
				style: paragraph.style,
				box: { x: 40 + 10 * index, y: 92, w: 6, h: 14 },
				visualBox: { x: 40 + 10 * index, y: 95, w: 6, h: 8 },
				textMatrix: [10, 0, 0, 10, 40, 750],
			})),
		};
		expect(readingFormulaMetrics(p, formula, 800)).toMatchObject({
			baselineOffset: 1,
			textRise: 0,
		});
	});
	it("restores citations across formula boundaries as selectable text while keeping a mathematical island", () => {
		const result = readingInlineParts(paragraph.protectedText, paragraph);
		expect(result.text).toBe(paragraph.source);
		expect(
			result.parts.filter((p) => p.formula).map((p) => [p.text, p.raster]),
		).toEqual([
			["[99", false],
			["134]", false],
			["R = ΔT∕J", true],
		]);
		expect(result.parts.map((p) => result.text.slice(p.start, p.end))).toEqual(
			result.parts.map((p) => p.text),
		);
	});
	it("uses actual PDF baselines for a scalar, keeping superscripts raised", () => {
		const scalar = {
			id: "3",
			text: "∆",
			box: { x: 100, y: 95, w: 6, h: 7 },
			baselineOffset: -2.8,
			characterIndexes: [1],
		};
		const p = {
			...paragraph,
			characters: [
				{
					index: 0,
					text: "T",
					box: { x: 90, y: 92, w: 6, h: 15 },
					visualBox: { x: 90, y: 95, w: 6, h: 7 },
					style: paragraph.style,
					textMatrix: [10, 0, 0, 10, 90, 697],
				},
				{
					index: 1,
					text: "∆",
					box: { x: 100, y: 92, w: 7, h: 15 },
					visualBox: scalar.box,
					style: paragraph.style,
					textMatrix: [10, 0, 0, 10, 100, 697],
				},
				{
					index: 2,
					text: "2",
					box: { x: 110, y: 90, w: 4, h: 8 },
					visualBox: { x: 110, y: 92, w: 3, h: 5 },
					style: { ...paragraph.style, size: 6.5 },
					textMatrix: [6.5, 0, 0, 6.5, 110, 703],
				},
			],
		};
		expect(readingFormulaMetrics(p, scalar, 800)).toMatchObject({
			baselineOffset: -1,
			fontScale: 1,
			textRise: 0,
		});
		expect(
			readingFormulaMetrics(
				p,
				{ ...scalar, box: p.characters[2].visualBox, characterIndexes: [2] },
				800,
			),
		).toMatchObject({ fontScale: 0.65, textRise: 6 });
		expect(
			readingInlineParts("⟪F3⟫", { ...p, formulas: [scalar] }).parts[0].raster,
		).toBe(false);
	});
});
