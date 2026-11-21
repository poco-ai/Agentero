/**
 * Line boxes from a compiled `.synctex` / `.synctex.gz`.
 *
 * TeX records each horizontal box on its own column, and also records the
 * column itself as one tall hbox. Hover keeps only line-sized boxes, so a
 * two-column baseline and its margin line numbers stay separate. Coordinates
 * follow synctex_parser.c: raw integers are sp-like units, `Unit / 65781.76`
 * converts them to PDF big points, and the reference point is the baseline
 * (y grows downward from the top of the page).
 */

import { readFile } from "@tauri-apps/plugin-fs";
import { normalizeLocalPath, normalizePath } from "@/lib/core/path";

/** 1 bp in scaled points. Same constant as the SyncTeX scanner. */
const BIG_POINT = 65781.76;

export type SyncTexBox = {
	page: number;
	x: number;
	y: number;
	w: number;
	h: number;
};

type RawBox = {
	h: number;
	v: number;
	w: number;
	height: number;
	depth: number;
};

const hoverState = new Map<string, "loading" | "ready" | "absent">();

/** Writing preview owns hover while its SyncTeX boxes are loading or ready. */
export function synctexHoverSupersedes(docId: string): boolean {
	const state = hoverState.get(docId);
	return state === "loading" || state === "ready";
}

export function setSyncTexHover(
	docId: string,
	state: "loading" | "ready" | "absent" | null,
): void {
	if (state == null) hoverState.delete(docId);
	else hoverState.set(docId, state);
}

export function synctexPathsForPdf(pdfPath: string): string[] {
	const stem = pdfPath.replace(/\.pdf$/i, "");
	return [`${stem}.synctex.gz`, `${stem}.synctex`];
}

export function parseSyncTexBoxes(text: string): SyncTexBox[] {
	let unit = 1;
	let xOffset = 0;
	let yOffset = 0;
	let magnification = 1000;
	let inContent = false;
	let page = 0;
	let form = 0;
	let lastV = 0;
	const raw: { page: number; box: RawBox }[] = [];

	for (const line of text.split(/\r?\n/)) {
		if (!inContent) {
			if (line.startsWith("Unit:")) unit = positiveField(line, "Unit:", 1);
			else if (line.startsWith("X Offset:"))
				xOffset = finiteField(line, "X Offset:");
			else if (line.startsWith("Y Offset:"))
				yOffset = finiteField(line, "Y Offset:");
			else if (line.startsWith("Magnification:"))
				magnification = positiveField(line, "Magnification:", 1000);
			else if (line.startsWith("Content:")) inContent = true;
			continue;
		}
		if (line.startsWith("Postamble:") || line.startsWith("Post scriptum:"))
			break;
		const head = line[0];
		if (head === "<") {
			form += 1;
			continue;
		}
		if (head === ">") {
			form = Math.max(0, form - 1);
			continue;
		}
		if (head === "{") {
			const next = Number.parseInt(line.slice(1), 10);
			if (next > 0) page = next;
			continue;
		}
		if (form > 0 || (head !== "(" && head !== "h")) continue;
		const box = parseHboxRecord(line.slice(1), lastV);
		if (!box) continue;
		lastV = box.v;
		if (page > 0 && box.w !== 0 && box.height + box.depth !== 0)
			raw.push({ page, box });
	}

	const scale = (unit / BIG_POINT) * (magnification / 1000);
	const xShift = xOffset * (unit / BIG_POINT);
	const yShift = yOffset * (unit / BIG_POINT);
	return raw.flatMap(({ page: boxPage, box }) => {
		const width = Math.abs(box.w) * scale;
		const above = Math.abs(box.height) * scale;
		const below = Math.abs(box.depth) * scale;
		const height = above + below;
		if (!(width > 0) || !(height > 0)) return [];
		return [
			{
				page: boxPage,
				x: box.h * scale + xShift,
				y: box.v * scale + yShift - above,
				w: width,
				h: height,
			},
		];
	});
}

export function indexSyncTexBoxes(
	boxes: readonly SyncTexBox[],
): Map<number, SyncTexBox[]> {
	const byPage = new Map<number, SyncTexBox[]>();
	for (const box of boxes) {
		const list = byPage.get(box.page);
		if (list) list.push(box);
		else byPage.set(box.page, [box]);
	}
	return byPage;
}

/**
 * Taller than a typeset line. SyncTeX's own visible-box cutoff is about 23bp
 * (`1500000 / 65781.76`); column, figure, and page boxes sit well above it.
 */
const LINE_BOX_MAX_PT = 24;
/** Leading sits just outside the line box. Snap only across that gap. */
const LINE_SNAP_PT = 6;

/** Smallest line hbox at the PDF point. Page numbers are 1-based. */
export function syncTexBoxAtPoint(
	byPage: ReadonlyMap<number, readonly SyncTexBox[]>,
	page: number,
	x: number,
	y: number,
): SyncTexBox | null {
	const boxes = byPage.get(page);
	if (!boxes) return null;
	let best: SyncTexBox | null = null;
	let bestArea = Number.POSITIVE_INFINITY;
	let nearest: SyncTexBox | null = null;
	let nearestGap = Number.POSITIVE_INFINITY;
	for (const box of boxes) {
		if (!(box.h > 0) || box.h > LINE_BOX_MAX_PT) continue;
		if (x < box.x || x > box.x + box.w) continue;
		const above = box.y - y;
		const below = y - (box.y + box.h);
		if (above <= 0 && below <= 0) {
			const area = box.w * box.h;
			if (area < bestArea) {
				best = box;
				bestArea = area;
			}
			continue;
		}
		const gap = above > 0 ? above : below;
		if (gap > LINE_SNAP_PT || gap > nearestGap) continue;
		const area = box.w * box.h;
		const nearestArea = (nearest?.w ?? 0) * (nearest?.h ?? 0);
		if (gap < nearestGap || area < nearestArea) {
			nearest = box;
			nearestGap = gap;
		}
	}
	return best ?? nearest;
}

export async function readSyncTexBoxes(pdfPath: string): Promise<SyncTexBox[]> {
	for (const path of synctexPathsForPdf(pdfPath)) {
		try {
			const bytes = await readFile(normalizeLocalPath(path));
			return parseSyncTexBoxes(await decodeSyncTex(bytes));
		} catch {
			/* The sibling may be the other extension, or the build has no SyncTeX. */
		}
	}
	return [];
}

export function samePdfPath(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

function finiteField(line: string, label: string): number {
	const value = Number(line.slice(label.length).trim());
	return Number.isFinite(value) ? value : 0;
}

function positiveField(line: string, label: string, fallback: number): number {
	const value = Number(line.slice(label.length).trim());
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseHboxRecord(body: string, lastV: number): RawBox | null {
	let index = 0;
	const read = (allowEquals: boolean): number | null => {
		if (body[index] === ":" || body[index] === ",") {
			if (allowEquals && body[index] === "," && body[index + 1] === "=") {
				index += 2;
				return lastV;
			}
			index += 1;
		}
		const start = index;
		if (body[index] === "+" || body[index] === "-") index += 1;
		const digits = index;
		while (body[index] >= "0" && body[index] <= "9") index += 1;
		if (index === digits) return null;
		return Number(body.slice(start, index));
	};
	if (read(false) == null || read(false) == null) return null;
	if (
		body[index] === "," &&
		body[index + 1] !== "=" &&
		body[index + 1] !== undefined
	) {
		const mark = index;
		index += 1;
		if (body[index] === "+" || body[index] === "-") index += 1;
		const digits = index;
		while (body[index] >= "0" && body[index] <= "9") index += 1;
		if (index === digits) index = mark;
	}
	const h = read(false);
	const v = read(true);
	const w = read(false);
	const height = read(false);
	const depth = read(false);
	if (h == null || v == null || w == null || height == null || depth == null)
		return null;
	return { h, v, w, height, depth };
}

async function decodeSyncTex(bytes: Uint8Array): Promise<string> {
	const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	if (!gzip) return new TextDecoder().decode(bytes);
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return await new Response(stream).text();
}
