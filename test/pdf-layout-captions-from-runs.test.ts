import type { PdfTextRun } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { recoverCaptionsFromRuns } from "@/lib/pdf/layout/captions-from-runs";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

const page = { width: 600, height: 800 };
function run(
	text: string,
	x: number,
	y: number,
	width = 240,
	height = 8,
	charIndex?: number,
): PdfTextRun {
	return {
		text,
		rect: { origin: { x, y }, size: { width, height } },
		...(charIndex === undefined ? {} : { charIndex, charCount: text.length }),
	} as PdfTextRun;
}

describe("recoverCaptionsFromRuns", () => {
	it("recovers a missing table caption across split font runs and retains body references", () => {
		const result = recoverCaptionsFromRuns(
			[],
			6,
			[
				run("Table 4:", 62, 203, 36, 10),
				run("Reward-hacking analysis results.", 101, 203, 210, 10),
				run("Table 4 shows differences between models.", 62, 390, 350, 10),
			],
			page,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			pageIndex: 6,
			captionRole: "table_main",
			title: "Table 4: Reward-hacking analysis results.",
			rect: { x: 62, y: 203, w: 249, h: 10 },
		});
	});
	it("recovers split Nature caption runs and stops at a paragraph gap", () => {
		const result = recoverCaptionsFromRuns(
			[],
			2,
			[
				run("Fig. 6 | Genetic ", 40, 600, 60),
				run("changes", 100, 600, 50),
				run("across the samples.", 40, 610),
				run("Unrelated body paragraph", 40, 640),
			],
			page,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			pageIndex: 2,
			kind: "figure_title",
			captionRole: "figure_main",
			title: "Fig. 6 | Genetic changes across the samples.",
			rect: { x: 40, y: 600, w: 240, h: 18 },
		});
	});
	it("rejects prose mentions and does not consume a different caption", () => {
		const result = recoverCaptionsFromRuns(
			[],
			0,
			[
				run("See Fig. 1 | for details", 40, 400),
				run("Fig. 2a). The samples changed.", 40, 410),
				run("Fig. 3 | First caption.", 40, 500),
				run("Fig. 4 | Other caption.", 40, 510),
			],
			page,
		);
		expect(result.map((r) => r.title)).toEqual([
			"Fig. 3 | First caption.",
			"Fig. 4 | Other caption.",
		]);
	});
	it("keeps a next-page hint isolated from neighboring prose", () => {
		const result = recoverCaptionsFromRuns(
			[],
			0,
			[
				run("Extended Data Fig. 4 | See next page for caption.", 40, 700),
				run("Article information", 40, 710),
			],
			page,
		);
		expect(result[0].title).toBe(
			"Extended Data Fig. 4 | See next page for caption.",
		);
		expect(result[0].rect.h).toBe(8);
	});
	it("joins a second column only with continuous character order and matching top", () => {
		const texts = [
			"Fig. 1 | A caption",
			"continued through",
			"the left column",
			"and the right",
			"column ends here.",
		];
		let index = 100;
		const runs = texts.map((text, i) => {
			const r = run(
				text,
				i < 3 ? 40 : 310,
				i < 3 ? 600 + i * 10 : 600 + (i - 3) * 10,
				240,
				8,
				index,
			);
			index += text.length;
			return r;
		});
		const result = recoverCaptionsFromRuns([], 0, runs, page);
		expect(result[0].title).toBe(texts.join(" "));
		expect(result[0].rect).toEqual({ x: 40, y: 600, w: 510, h: 28 });
		const unrelated = runs.map((r, i) =>
			i >= 3 ? { ...r, charIndex: r.charIndex + 100 } : r,
		);
		expect(recoverCaptionsFromRuns([], 0, unrelated, page)[0].title).toBe(
			texts.slice(0, 3).join(" "),
		);
	});
	it("does not duplicate existing numbered captions or an overlapping caption box", () => {
		const existing = recoverCaptionsFromRuns(
			[],
			0,
			[run("Fig. 1 | Already present.", 40, 600)],
			page,
		)[0];
		const result = recoverCaptionsFromRuns(
			[existing],
			0,
			[run("Fig. 1 | New extraction.", 40, 500)],
			page,
		);
		expect(result).toEqual([existing]);
		const untitled = {
			...existing,
			title: undefined,
			text: undefined,
		} as PdfLayoutRegion;
		expect(
			recoverCaptionsFromRuns(
				[untitled],
				0,
				[run("Fig. 1 | Already present.", 40, 600)],
				page,
			),
		).toEqual([untitled]);
	});
	it("stops when adjacent text changes size", () => {
		const result = recoverCaptionsFromRuns(
			[],
			0,
			[
				run("Fig. 1 | Small caption.", 40, 600),
				run("Body text starts here", 40, 611, 240, 12),
			],
			page,
		);
		expect(result[0].title).toBe("Fig. 1 | Small caption.");
	});
	it("keeps superscripts and an unusually tall dash inside caption prose", () => {
		const result = recoverCaptionsFromRuns(
			[],
			0,
			[
				run("Fig. 1 | CD11b", 40, 600, 70),
				run("+", 110, 599, 3, 5),
				run(" cells", 113, 600, 40),
				run("pseudo", 40, 610, 30),
				run("-", 70, 609, 2, 11),
				run("color images.", 72, 610, 80),
			],
			page,
		);
		expect(result[0].title).toBe("Fig. 1 | CD11b+ cells pseudo-color images.");
	});
	it("does not interleave columns when the gutter narrows to twelve points", () => {
		const texts = [
			"Fig. 1 | A caption",
			"left middle",
			"left end",
			"right start",
			"right end",
		];
		let charIndex = 100;
		const runs = texts.map((text, i) => {
			const item = run(
				text,
				i < 3 ? 40 : 306,
				i < 3 ? 600 + i * 10 : 600 + (i - 3) * 10,
				254,
				9,
				charIndex,
			);
			charIndex += text.length;
			return item;
		});
		expect(recoverCaptionsFromRuns([], 0, runs, page)[0].title).toBe(
			texts.join(" "),
		);
	});
	it("grows partial caption geometry and ignores host titles without caption geometry", () => {
		const caption = recoverCaptionsFromRuns(
			[],
			0,
			[run("Fig. 1 | A caption", 40, 600)],
			page,
		)[0];
		const runs = [
			run("Fig. 1 | A caption", 40, 600),
			run("with another line.", 40, 610),
		];
		const upgraded = recoverCaptionsFromRuns([caption], 0, runs, page);
		expect(upgraded).toHaveLength(1);
		expect(upgraded[0].title).toBe("Fig. 1 | A caption with another line.");
		expect(upgraded[0].rect.h).toBe(18);
		const host = { ...caption, kind: "image" as const };
		expect(recoverCaptionsFromRuns([host], 0, runs, page)).toHaveLength(2);
	});
});
