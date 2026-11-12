import type { PdfTextRun } from "@embedpdf/models";
import { figureCaptionKey } from "@/lib/pdf/layout/figure-caption-text";
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

type CaptionTextRun = Pick<PdfTextRun, "text" | "rect"> &
	Partial<Pick<PdfTextRun, "charIndex" | "charCount">>;

function numberedCaptionKey(text: string): string | null {
	const table = text.trim().match(/^tab(?:le)?\.?\s*(\d+)\s*[:.|]\s+\S/iu);
	return table ? `table-${table[1]}` : figureCaptionKey(text);
}

type Line = {
	runs: CaptionTextRun[];
	text: string;
	x: number;
	right: number;
	top: number;
	bottom: number;
	height: number;
};

function makeLine(runs: CaptionTextRun[]): Line {
	const top = Math.min(...runs.map((r) => r.rect.origin.y));
	const bottom = Math.max(
		...runs.map((r) => r.rect.origin.y + r.rect.size.height),
	);
	let text = "";
	for (const [i, run] of runs.entries()) {
		const previous = runs[i - 1];
		if (
			previous &&
			run.rect.origin.x - previous.rect.origin.x - previous.rect.size.width >
				1 &&
			!/\s$/.test(text) &&
			!/^\s/.test(run.text)
		)
			text += " ";
		text += run.text;
	}
	const mainRun = runs.reduce((a, b) =>
		a.rect.size.width >= b.rect.size.width ? a : b,
	);
	return {
		runs,
		text: text.replace(/\s+/g, " ").trim(),
		x: Math.min(...runs.map((r) => r.rect.origin.x)),
		right: Math.max(...runs.map((r) => r.rect.origin.x + r.rect.size.width)),
		top,
		bottom,
		height: mainRun.rect.size.height,
	};
}

/** Baselines alone mix columns; split each baseline at its physical gutter. */
function captionLines(runs: CaptionTextRun[]): Line[] {
	const visible = runs.filter(
		(r) => r.text?.trim() && r.rect.size.width > 0 && r.rect.size.height > 0,
	);
	const mainRuns = visible.filter((r) => r.text.trim().length > 4);
	return groupReadingLines(visible, (r) => {
		// Superscripts and tall single glyphs belong to the adjacent text baseline;
		// use the neighbor only for grouping, never for the resulting geometry.
		const anchor =
			r.text.trim().length <= 2
				? mainRuns.find(
						(other) =>
							Math.abs(other.rect.origin.y - r.rect.origin.y) <=
								other.rect.size.height * 0.6 &&
							Math.min(
								Math.abs(
									other.rect.origin.x + other.rect.size.width - r.rect.origin.x,
								),
								Math.abs(
									r.rect.origin.x + r.rect.size.width - other.rect.origin.x,
								),
							) <= 2,
					)
				: undefined;
		return {
			x: r.rect.origin.x,
			y: anchor?.rect.origin.y ?? r.rect.origin.y,
			width: r.rect.size.width,
			height: anchor?.rect.size.height ?? r.rect.size.height,
		};
	})
		.flatMap((line) => {
			const groups: CaptionTextRun[][] = [];
			for (const run of line.items) {
				const current = groups.at(-1);
				const previous = current?.at(-1);
				if (
					!current ||
					!previous ||
					run.rect.origin.x -
						previous.rect.origin.x -
						previous.rect.size.width >
						Math.max(
							8,
							Math.min(run.rect.size.height, previous.rect.size.height),
						)
				)
					groups.push([run]);
				else current.push(run);
			}
			return groups.map(makeLine);
		})
		.sort((a, b) => a.top - b.top || a.x - b.x);
}

function sameSize(a: Line, b: Line): boolean {
	return Math.abs(a.height - b.height) <= Math.max(1.5, a.height * 0.25);
}

function paragraph(start: Line, lines: Line[], maxHeight: number): Line[] {
	const selected = [start];
	if (/see\s+next\s+page\s+for\s+caption/i.test(start.text)) return selected;
	for (const line of lines) {
		const previous = selected.at(-1) ?? start;
		if (
			line.top <= previous.top ||
			Math.abs(line.x - start.x) > Math.max(3, start.height * 0.6)
		)
			continue;
		if (
			line.top - start.top > maxHeight ||
			line.top - previous.bottom > Math.max(2, start.height * 0.75) ||
			!sameSize(start, line) ||
			numberedCaptionKey(line.text) ||
			/^(?:table|algorithm)\s+\d/i.test(line.text)
		)
			break;
		selected.push(line);
		if (selected.length >= 64) break;
	}
	return selected;
}

function continuousCharacters(last: Line, next: Line): boolean {
	if (
		!last.runs.every(
			(r) => Number.isFinite(r.charIndex) && Number.isFinite(r.charCount),
		) ||
		!next.runs.every((r) => Number.isFinite(r.charIndex))
	)
		return false;
	const end = Math.max(
		...last.runs.map(
			(r) => (r.charIndex ?? Number.NaN) + (r.charCount ?? Number.NaN),
		),
	);
	const start = Math.min(...next.runs.map((r) => r.charIndex ?? Number.NaN));
	return start >= end && start - end <= 2;
}

/** Recover only numbered caption starts; all geometry comes from actual text runs. */
export function recoverCaptionsFromRuns(
	regions: readonly PdfLayoutRegion[],
	pageIndex: number,
	runs: CaptionTextRun[],
	pageSize: { width: number; height: number },
): PdfLayoutRegion[] {
	if (!(pageSize.width > 0 && pageSize.height > 0)) return [...regions];
	const lines = captionLines(runs);
	const bodyContinuation = (
		x: number,
		y: number,
		right: number,
		height: number,
	) =>
		regions.some(
			(r) =>
				r.pageIndex === pageIndex &&
				r.kind === "text" &&
				r.score >= 0.5 &&
				y >= r.rect.y - height &&
				y + height <= r.rect.y + r.rect.h + height &&
				x > r.rect.x + height &&
				right <= r.rect.x + r.rect.w + height &&
				runs.some(
					(previous) =>
						previous.rect.origin.x >= r.rect.x - 1 &&
						previous.rect.origin.x + previous.rect.size.width <= x &&
						x - previous.rect.origin.x - previous.rect.size.width <=
							height * 3 &&
						Math.abs(previous.rect.origin.y - y) < height * 0.4,
				),
		);
	const output = regions.filter(
		(r) =>
			!(
				r.id.startsWith(`pdf-caption-${pageIndex}-`) &&
				bodyContinuation(r.rect.x, r.rect.y, r.rect.x + r.rect.w, r.rect.h)
			),
	);
	const onPage = output.filter((r) => r.pageIndex === pageIndex);
	const seen = new Set<string>();
	for (const start of lines) {
		const key = numberedCaptionKey(start.text);
		if (!key || seen.has(key)) continue;
		// Justification can split a body line before its linked "figure 5.".
		// A preceding run on the same baseline inside one body region proves
		// this is a sentence fragment, not the start of a standalone caption.
		if (bodyContinuation(start.x, start.top, start.right, start.height))
			continue;
		seen.add(key);
		const existing = [...onPage]
			.sort((a, b) => b.score - a.score)
			.find(
				(r) =>
					r.kind === "figure_title" &&
					numberedCaptionKey(r.title ?? r.text ?? "") === key,
			);
		const cx = (start.x + start.right) / 2 / pageSize.width;
		const cy = (start.top + start.bottom) / 2 / pageSize.height;
		if (
			!existing &&
			onPage.some(
				(r) =>
					r.kind === "figure_title" &&
					cx >= r.bbox.x &&
					cx <= r.bbox.x + r.bbox.w &&
					cy >= r.bbox.y &&
					cy <= r.bbox.y + r.bbox.h,
			)
		)
			continue;
		// A caption detector occasionally covers the body beneath it. Confident
		// independent text boxes establish its lower boundary before extraction.
		const bodyTop = Math.min(
			...onPage
				.filter(
					(r) =>
						r.score >= 0.5 &&
						r.kind === "text" &&
						r.label === "text" &&
						r.rect.y >= start.bottom &&
						r.rect.x < start.right &&
						r.rect.x + r.rect.w > start.x,
				)
				.map((r) => r.rect.y),
		);
		const selected = paragraph(
			start,
			lines.filter((l) => (l.top + l.bottom) / 2 < bodyTop),
			pageSize.height * 0.65,
		);
		// A column jump needs both matching geometry and exact PDF character order.
		// Without that evidence, keep the complete first-column paragraph alone.
		if (selected.length >= 3) {
			const last = selected.at(-1) ?? start;
			const right = Math.max(...selected.map((line) => line.right));
			const candidates = lines.filter(
				(line) =>
					line.x > right + 5 &&
					Math.abs(line.top - start.top) <= start.height * 0.6 &&
					sameSize(start, line) &&
					!numberedCaptionKey(line.text) &&
					continuousCharacters(last, line),
			);
			if (candidates.length === 1)
				selected.push(
					...paragraph(
						candidates[0],
						lines,
						last.bottom - candidates[0].top + start.height,
					),
				);
		}
		const x = Math.min(...selected.map((line) => line.x));
		const y = Math.min(...selected.map((line) => line.top));
		const w = Math.max(...selected.map((line) => line.right)) - x;
		const h = Math.max(...selected.map((line) => line.bottom)) - y;
		const title = selected.map((line) => line.text).join(" ");
		const recovered: PdfLayoutRegion = {
			id: existing?.id ?? `pdf-caption-${pageIndex}-${key}`,
			pageIndex,
			kind: "figure_title",
			label: "figure_title",
			score: 0.9,
			readingOrder: existing?.readingOrder ?? output.length,
			rect: { x, y, w, h },
			bbox: {
				x: x / pageSize.width,
				y: y / pageSize.height,
				w: w / pageSize.width,
				h: h / pageSize.height,
			},
			title,
			text: title,
			captionRole: key.startsWith("table-") ? "table_main" : "figure_main",
		};
		if (existing) {
			const ex = existing.rect.x + existing.rect.w / 2;
			const ey = existing.rect.y + existing.rect.h / 2;
			const bounded =
				Number.isFinite(bodyTop) &&
				existing.rect.y < bodyTop &&
				existing.rect.y + existing.rect.h > bodyTop &&
				Math.abs(existing.rect.y - y) < start.height &&
				y + h <= bodyTop;
			if (
				bounded ||
				(title.length > (existing.title ?? existing.text ?? "").length &&
					ex >= x &&
					ex <= x + w &&
					ey >= y &&
					ey <= y + h)
			)
				output[output.indexOf(existing)] = recovered;
		} else output.push(recovered);
	}
	return output;
}
