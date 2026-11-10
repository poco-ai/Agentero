import { describe, expect, it } from "vitest";
import {
	layoutTranslateDisplayRatio,
	layoutTranslatePageProgress,
	layoutTranslateSettledRatio,
} from "@/lib/pdf/layout/layout-translate-progress";

describe("layoutTranslateSettledRatio", () => {
	it("stays unknown until the job has blocks", () => {
		expect(layoutTranslateSettledRatio([])).toBeNull();
	});

	it("counts finished blocks and leaves the ones still translating empty", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "done" },
				{ status: "running" },
				{ status: "pending" },
				{ status: "error" },
				{ status: "skipped" },
			]),
		).toBe(0.6);
	});

	it("reaches full when every block has settled", () => {
		expect(
			layoutTranslateSettledRatio([{ status: "done" }, { status: "error" }]),
		).toBe(1);
	});
	it("includes completed sentences in an unfinished paragraph", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "running", progress: 0.5 },
				{ status: "done" },
			]),
		).toBe(0.75);
	});
});

describe("layoutTranslatePageProgress", () => {
	const item = (
		id: string,
		pageIndex: number,
		status: "pending" | "running" | "done" | "error" | "skipped",
		progress?: number,
	) => ({ id, pageIndex, status, progress });

	it("stays unknown until the run has blocks", () => {
		expect(layoutTranslatePageProgress([], null)).toBeNull();
	});

	it("weighs every page the same and reports the page count", () => {
		// Page 0 is finished; page 1 is half done. Equal page weight => 0.75.
		const progress = layoutTranslatePageProgress(
			[item("a", 0, "done"), item("b", 1, "running", 0.5)],
			null,
		);
		expect(progress?.ratio).toBe(0.75);
		expect(progress?.pagesDone).toBe(1);
		expect(progress?.pagesTotal).toBe(2);
	});

	it("does not let a page with many blocks dominate", () => {
		const progress = layoutTranslatePageProgress(
			[
				...Array.from({ length: 9 }, (_, index) =>
					item(`p0-${index}`, 0, "done"),
				),
				item("p1-0", 1, "pending"),
			],
			null,
		);
		expect(progress?.ratio).toBe(0.5);
	});

	it("only measures the pages a gap run fills", () => {
		const items = [
			item("done-page", 0, "done"),
			item("gap", 1, "pending"),
			item("gap-2", 1, "done"),
		];
		const progress = layoutTranslatePageProgress(items, ["gap", "gap-2"]);
		expect(progress?.pagesTotal).toBe(1);
		expect(progress?.ratio).toBe(0.5);
	});

	it("grows monotonically as blocks settle", () => {
		const steps = [
			[item("a", 0, "pending"), item("b", 1, "pending")],
			[item("a", 0, "done"), item("b", 1, "pending")],
			[item("a", 0, "done"), item("b", 1, "error")],
		].map((items) => layoutTranslatePageProgress(items, null)?.ratio ?? 0);
		expect(steps).toEqual([0, 0.5, 1]);
	});
});

describe("layoutTranslateDisplayRatio", () => {
	const text = (ratio: number) => ({
		ratio,
		pagesDone: 0,
		pagesTotal: 1,
	});

	it("gives translating the first 70% and typesetting the last 30%", () => {
		expect(layoutTranslateDisplayRatio(text(0.5), true, null)).toBeCloseTo(
			0.35,
		);
		expect(
			layoutTranslateDisplayRatio(text(1), true, { done: 0, total: 4 }),
		).toBeCloseTo(0.7);
		expect(
			layoutTranslateDisplayRatio(text(1), true, { done: 2, total: 4 }),
		).toBeCloseTo(0.85);
	});

	it("hands over at the stage boundary without a jump", () => {
		const lastText = layoutTranslateDisplayRatio(text(1), true, {
			done: 0,
			total: 4,
		});
		const firstTypeset = layoutTranslateDisplayRatio(text(1), true, {
			done: 0,
			total: 4,
		});
		expect(lastText).toBe(firstTypeset);
	});

	it("never drops when a partial run lands its preview", () => {
		const settled = 0.5;
		const pending = layoutTranslateDisplayRatio(text(settled), true, {
			done: 3,
			total: 3,
		});
		const landed = layoutTranslateDisplayRatio(text(settled), false, {
			done: 3,
			total: 3,
		});
		expect(pending).toBeCloseTo(0.65);
		expect(landed).toBeCloseTo(0.65);
	});

	it("holds back the last percent until the committed output is ready", () => {
		expect(
			layoutTranslateDisplayRatio(text(1), true, { done: 4, total: 4 }),
		).toBe(0.99);
		expect(
			layoutTranslateDisplayRatio(text(1), false, { done: 4, total: 4 }),
		).toBe(1);
	});

	it("stays unknown before the job has blocks", () => {
		expect(layoutTranslateDisplayRatio(null, true, null)).toBeNull();
	});

	it("uses page work alone when all translation results came from cache", () => {
		expect(
			layoutTranslateDisplayRatio(text(1), true, { done: 0, total: 2 }, true),
		).toBe(0);
		expect(
			layoutTranslateDisplayRatio(text(1), true, { done: 1, total: 2 }, true),
		).toBe(0.5);
		expect(
			layoutTranslateDisplayRatio(text(1), false, { done: 2, total: 2 }, true),
		).toBe(1);
	});
});
