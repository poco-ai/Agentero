import type { PdfTextRun } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { recoverFigureCaptionsFromRuns } from "@/lib/pdf/layout/captions-from-runs";
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

describe("recoverFigureCaptionsFromRuns", () => {
	it("does not turn the last run of a justified body line into a caption", () => {
		const body = {
			id: "body",
			kind: "text",
			label: "text",
			pageIndex: 0,
			score: 0.95,
			readingOrder: 0,
			bbox: { x: 0.08, y: 0.7, w: 0.84, h: 0.08 },
			rect: { x: 48, y: 560, w: 504, h: 64 },
			text: "Snapshots are plotted in figure 5. For all cases.",
		} as PdfLayoutRegion;
		const runs = [
			run("Snapshots are plotted in", 48, 562, 220, 10),
			run("figure 5. For all cases.", 282, 562, 250, 10),
		];
		expect(recoverFigureCaptionsFromRuns([body], 0, runs, page)).toEqual([
			body,
		]);
		// A new text-geometry pass also removes an earlier synthetic false caption.
		const stale = {
			...body,
			id: "pdf-caption-0-figure-5",
			kind: "figure_title",
			label: "figure_title",
			score: 0.9,
			rect: { x: 282, y: 562, w: 250, h: 10 },
			bbox: { x: 282 / 600, y: 562 / 800, w: 250 / 600, h: 10 / 800 },
			text: "figure 5. For all cases.",
			title: "figure 5. For all cases.",
		} as PdfLayoutRegion;
		expect(recoverFigureCaptionsFromRuns([body, stale], 0, runs, page)).toEqual(
			[body],
		);
	});
	it("shrinks an overgrown caption at an independently detected body paragraph", () => {
		const caption = {
			id: "caption",
			kind: "figure_title",
			label: "figure_title",
			pageIndex: 0,
			score: 0.9,
			readingOrder: 0,
			rect: { x: 40, y: 200, w: 510, h: 200 },
			bbox: { x: 40 / 600, y: 0.25, w: 0.85, h: 0.25 },
			text: "Fig. 2. A caption. followed by body text.",
			title: "Fig. 2. A caption. followed by body text.",
		} as PdfLayoutRegion;
		const body = {
			...caption,
			id: "body",
			kind: "text",
			label: "text",
			text: "The body starts here.",
			title: undefined,
			rect: { x: 40, y: 230, w: 240, h: 100 },
			bbox: { x: 40 / 600, y: 230 / 800, w: 0.4, h: 0.125 },
		} as PdfLayoutRegion;
		const weak = {
			...caption,
			id: "weak-caption",
			score: 0.02,
			rect: { ...caption.rect, h: 12 },
		};
		const result = recoverFigureCaptionsFromRuns(
			[weak, caption, body],
			0,
			[
				run("Fig. 2. A caption.", 40, 200, 500, 10),
				run("The caption ends here.", 40, 211, 450, 10),
				run("The body starts here.", 40, 230, 240, 12),
			],
			page,
		);
		expect(result.find((r) => r.id === "caption")?.rect.h).toBe(21);
		expect(result.find((r) => r.id === "caption")?.text).not.toContain("body");
	});
	it("recovers split Nature caption runs and stops at a paragraph gap", () => {
		const result = recoverFigureCaptionsFromRuns(
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
		const result = recoverFigureCaptionsFromRuns(
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
		const result = recoverFigureCaptionsFromRuns(
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
		const result = recoverFigureCaptionsFromRuns([], 0, runs, page);
		expect(result[0].title).toBe(texts.join(" "));
		expect(result[0].rect).toEqual({ x: 40, y: 600, w: 510, h: 28 });
		const unrelated = runs.map((r, i) =>
			i >= 3 ? { ...r, charIndex: r.charIndex + 100 } : r,
		);
		expect(recoverFigureCaptionsFromRuns([], 0, unrelated, page)[0].title).toBe(
			texts.slice(0, 3).join(" "),
		);
	});
	it("does not duplicate existing numbered captions or an overlapping caption box", () => {
		const existing = recoverFigureCaptionsFromRuns(
			[],
			0,
			[run("Fig. 1 | Already present.", 40, 600)],
			page,
		)[0];
		const result = recoverFigureCaptionsFromRuns(
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
			recoverFigureCaptionsFromRuns(
				[untitled],
				0,
				[run("Fig. 1 | Already present.", 40, 600)],
				page,
			),
		).toEqual([untitled]);
	});
	it("stops when adjacent text changes size", () => {
		const result = recoverFigureCaptionsFromRuns(
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
		const result = recoverFigureCaptionsFromRuns(
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
		expect(recoverFigureCaptionsFromRuns([], 0, runs, page)[0].title).toBe(
			texts.join(" "),
		);
	});
	it("grows partial caption geometry and ignores host titles without caption geometry", () => {
		const caption = recoverFigureCaptionsFromRuns(
			[],
			0,
			[run("Fig. 1 | A caption", 40, 600)],
			page,
		)[0];
		const runs = [
			run("Fig. 1 | A caption", 40, 600),
			run("with another line.", 40, 610),
		];
		const upgraded = recoverFigureCaptionsFromRuns([caption], 0, runs, page);
		expect(upgraded).toHaveLength(1);
		expect(upgraded[0].title).toBe("Fig. 1 | A caption with another line.");
		expect(upgraded[0].rect.h).toBe(18);
		const host = { ...caption, kind: "image" as const };
		expect(recoverFigureCaptionsFromRuns([host], 0, runs, page)).toHaveLength(
			2,
		);
	});
});
