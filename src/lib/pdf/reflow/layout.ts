import type { PDFFont } from "pdf-lib";
import {
	type Box,
	type FontKey,
	formulaToken,
	intersects,
	type PageLayout,
	type Paragraph,
	type ParagraphLayout,
	type PlacedUnit,
	type ReflowDocument,
	type ReflowPage,
} from "./types";
export type ReflowFonts = Record<FontKey, PDFFont>;
const cjk =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const opening = /^[“‘（《「『【([{]$/u;
const closing = /^[”’，。！？；：、）》」』】)\]},.!?;:]$/u;
type Unit = Omit<PlacedUnit, "x" | "y"> & { cjk: boolean; space: boolean };
/** Rebuild TOC rows when layout.json merges a whole section into one region. */
type TocEntry = { number: string; title: string; page: string; level: number };

/** The source text layer still carries one box per TOC row even when MinerU merges the text. */
function sourceLines(p: Paragraph): string[] {
	const grouped = new Map<number, { x: number; text: string }[]>();
	for (const character of p.characters) {
		const key = Math.round(character.box.y * 2) / 2;
		const line = grouped.get(key) ?? [];
		line.push({ x: character.box.x, text: character.text });
		grouped.set(key, line);
	}
	return [...grouped.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, line]) =>
			line
				.sort((a, b) => a.x - b.x)
				.map((part) => part.text)
				.join("")
				.replace(/\s+/gu, " ")
				.trim(),
		)
		.filter(Boolean);
}

function entryParts(line: string): { number: string; page: string } | null {
	const number = /^((?:[A-Z](?:\.\d+)*|\d+(?:\.\d+)*))/u.exec(line)?.[1];
	const page = /(\d{1,3})\s*$/u.exec(line)?.[1];
	return number && page ? { number, page } : null;
}

function tocEntries(p: Paragraph, text: string): TocEntry[] | null {
	const lines = sourceLines(p);
	if (!lines.length) return null;
	const clean = text
		.replace(/⟪\/?S\d+⟫/gu, "")
		.replace(/⟪F\d+⟫/gu, "")
		.trim();
	const candidates = [
		...clean.matchAll(
			/(^|\s)((?:[A-Z](?:\.\d+)*|\d+(?:\.\d+)*))(?=\s|[^\d.])/gu,
		),
	].map((match) => ({
		number: match[2],
		index: (match.index ?? 0) + match[1].length,
	}));
	// Match translated labels by section number; source page numbers remain authoritative.
	const entries: TocEntry[] = [];
	let cursor = 0;
	for (const line of lines) {
		const parts = entryParts(line);
		if (!parts) continue;
		let candidate = -1;
		for (let index = cursor; index < candidates.length; index++) {
			if (candidates[index]?.number === parts.number) {
				candidate = index;
				break;
			}
		}
		const sourceTitle = line
			.slice(line.indexOf(parts.number) + parts.number.length)
			.replace(/(?:\.\s*){2,}.*$/u, "")
			.replace(new RegExp(`${parts.page}\\s*$`, "u"), "")
			.trim();
		let title = sourceTitle;
		if (candidate >= 0) {
			const start = candidates[candidate].index;
			const end = candidates[candidate + 1]?.index ?? clean.length;
			const segment = clean.slice(start, end);
			title =
				segment
					.replace(new RegExp(`^${parts.number}`, "u"), "")
					.replace(/(?:\.\s*){2,}.*$/u, "")
					.replace(new RegExp(`${parts.page}\\s*$`, "u"), "")
					.trim() || sourceTitle;
			cursor = candidate + 1;
		} else if (!candidates.length) {
			title =
				clean
					.replace(/(?:\.\s*){2,}.*$/u, "")
					.replace(new RegExp(`${parts.page}\\s*$`, "u"), "")
					.trim() || sourceTitle;
		}
		title = title
			.replace(/^[一二三四五六七八九十百]+[、.．]\s*/u, "")
			.replace(/[。.]\s*$/u, "")
			.trim();
		entries.push({
			number: parts.number,
			title,
			page: parts.page,
			level: (parts.number.match(/\./gu) ?? []).length,
		});
	}
	return entries.length ? entries : null;
}

function tocPage(page: ReflowPage): boolean {
	return page.paragraphs.some((paragraph) =>
		/^(contents|table of contents|目录)$/iu.test(paragraph.source.trim()),
	);
}

/** Lay out a TOC without prose wrapping; only pages with a Contents heading take this path. */
function tocLayout(
	p: Paragraph,
	text: string,
	page: ReflowPage,
	fonts: ReflowFonts,
): ParagraphLayout | null {
	if (!tocPage(page)) return null;
	const entries = tocEntries(p, text);
	if (!entries) return null;
	const box = { ...p.box };
	const base = p.style.size;
	const width = (value: string, key: FontKey, size: number) =>
		fonts[key].widthOfTextAtSize(value, size);
	const fontForEntry = (value: string, bold: boolean): FontKey =>
		cjk.test(value) ? (bold ? "cjkBold" : "cjk") : bold ? "bold" : "regular";
	let scale = 1;
	for (const entry of entries) {
		const bold = entry.level === 0;
		const titleFont = fontForEntry(entry.title, bold);
		const needed =
			width(`${entry.number} ${entry.title}`, titleFont, base) +
			width(entry.page, "regular", base) +
			base * 2;
		if (needed > box.w) scale = Math.min(scale, box.w / needed);
	}
	scale = Math.max(0.6, scale);
	const em = base * scale;
	const lineHeight = box.h / entries.length;
	const units: PlacedUnit[] = [];
	// Chapters have no leaders; sub-entries keep leaders and an indented label.
	entries.forEach((entry, index) => {
		const bold = entry.level === 0;
		const titleFont = fontForEntry(entry.title, bold);
		const indent =
			entry.level * em * 1.5 + Math.max(0, entry.level - 1) * em * 0.8;
		const x = box.x + indent;
		const baseline = box.y + lineHeight * (index + 0.8);
		const pageWidth = width(entry.page, "regular", em);
		const pageX = box.x + box.w - pageWidth;
		units.push({
			text: entry.number,
			translatedOffset: 0,
			x,
			y: baseline,
			width: width(entry.number, "regular", em),
			height: fonts.regular.heightAtSize(em),
			font: "regular",
			fontSize: em,
			color: p.style.color,
		});
		const titleX = x + width(entry.number, "regular", em) + em * 0.9;
		const titleWidth = width(entry.title, titleFont, em);
		units.push({
			text: entry.title,
			translatedOffset: 0,
			x: titleX,
			y: baseline,
			width: titleWidth,
			height: fonts[titleFont].heightAtSize(em),
			font: titleFont,
			fontSize: em,
			color: p.style.color,
		});
		if (entry.level > 0) {
			const start = titleX + titleWidth + em * 0.3;
			const end = pageX - em * 0.3;
			let dots = "";
			while (
				start + width(dots, "regular", em) + width(". ", "regular", em) <=
				end
			)
				dots += ". ";
			if (dots)
				units.push({
					text: dots.trimEnd(),
					translatedOffset: 0,
					x: start,
					y: baseline,
					width: width(dots.trimEnd(), "regular", em),
					height: fonts.regular.heightAtSize(em),
					font: "regular",
					fontSize: em,
					color: p.style.color,
				});
		}
		units.push({
			text: entry.page,
			translatedOffset: 0,
			x: pageX,
			y: baseline,
			width: pageWidth,
			height: fonts.regular.heightAtSize(em),
			font: "regular",
			fontSize: em,
			color: p.style.color,
		});
	});
	return {
		id: p.id,
		pageIndex: p.pageIndex,
		sourceBox: p.box,
		box,
		scale,
		units,
		fits: units.every(
			(unit) =>
				unit.x >= box.x - 0.01 &&
				unit.x + unit.width <= box.x + box.w + 0.01 &&
				unit.y <= box.y + box.h + 0.01,
		),
	};
}

function fontFor(text: string, p: Paragraph, fonts: ReflowFonts): FontKey {
	if (cjk.test(text) || (text.codePointAt(0) ?? 0) > 255)
		return p.style.bold ? "cjkBold" : "cjk";
	const key = p.style.bold
		? p.style.italic
			? "boldItalic"
			: "bold"
		: p.style.italic
			? "italic"
			: "regular";
	// Fail visibly if the fallback cannot represent a character; never silently omit it.
	try {
		fonts[key].encodeText(text);
		return key;
	} catch {
		return p.style.bold ? "cjkBold" : "cjk";
	}
}
export function translationUnits(
	p: Paragraph,
	text: string,
	fonts: ReflowFonts,
): Unit[] {
	const tokens = text.split(/(⟪(?:F|\/?S)\d+⟫)/u).filter(Boolean),
		units: Unit[] = [];
	let current = p;
	const opened = new Set<string>(),
		closed = new Set<string>();
	let activeStyle: string | undefined;
	let offset = 0;
	for (const token of tokens) {
		const start = offset;
		offset += token.length;
		const styleMatch = /^⟪(\/?)S(\d+)⟫$/.exec(token);
		if (styleMatch) {
			const id = styleMatch[2],
				style = p.styles[id];
			if (!style) throw new Error(`Unknown style in ${p.id}`);
			if (styleMatch[1]) {
				if (activeStyle !== id || closed.has(id))
					throw new Error(`Unbalanced style in ${p.id}`);
				closed.add(id);
				activeStyle = undefined;
				current = p;
			} else {
				if (activeStyle || opened.has(id))
					throw new Error(`Repeated style in ${p.id}`);
				opened.add(id);
				activeStyle = id;
				current = { ...p, style };
			}
			continue;
		}
		const formula = p.formulas.find((f) => formulaToken(f.id) === token);
		if (/^⟪F/.test(token) && !formula)
			throw new Error(`Unknown formula in ${p.id}`);
		if (formula) {
			units.push({
				text: formula.text,
				translatedOffset: start,
				width: formula.box.w,
				height: formula.box.h,
				font: "regular",
				fontSize: p.style.size,
				formula,
				color: current.style.color,
				cjk: false,
				space: false,
			});
			continue;
		}
		for (const match of token.matchAll(/[\r\n]+|./gsu)) {
			const ch = match[0].replace(/^[\r\n]+$/u, " ");
			const font = fontFor(ch, current, fonts);
			units.push({
				text: ch,
				translatedOffset: start + match.index,
				width: fonts[font].widthOfTextAtSize(ch, p.style.size),
				height: fonts[font].heightAtSize(p.style.size),
				font,
				fontSize: p.style.size,
				color: current.style.color,
				cjk: cjk.test(ch),
				space: /\s/u.test(ch),
			});
		}
	}
	for (const f of p.formulas)
		if (text.split(formulaToken(f.id)).length !== 2)
			throw new Error(`Missing or repeated formula in ${p.id}`);
	if (
		activeStyle ||
		Object.keys(p.styles).some((id) => !opened.has(id) || !closed.has(id))
	)
		throw new Error(`Missing style in ${p.id}`);
	return units.filter(
		(unit, i) =>
			!unit.space ||
			!(
				closing.test(units.slice(i + 1).find((u) => !u.space)?.text ?? "") ||
				opening.test(
					units
						.slice(0, i)
						.reverse()
						.find((u) => !u.space)?.text ?? "",
				)
			),
	);
}
function place(
	p: Paragraph,
	units: Unit[],
	box: Box,
	scale: number,
	fonts: ReflowFonts,
	keepWords: boolean,
): ParagraphLayout {
	const out: PlacedUnit[] = [],
		lineSkip = units.some((u) => u.cjk) ? 1.5 : 1.3;
	const em = p.style.size * scale;
	let x = box.x + Math.min(p.firstLineIndent, box.w * 0.3) * scale;
	const ascent = fonts.regular.heightAtSize(em, { descender: false });
	let baseline = box.y + ascent,
		lineTop = box.y,
		lineStart = 0;
	let lineHeight = em,
		previous: Unit | undefined,
		fits = true;
	const widths = units.map((u) => u.width * scale);
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		if (!unit) continue;
		if (x === box.x && unit.space) continue;
		let gap =
			previous &&
			previous.cjk !== unit.cjk &&
			!previous.space &&
			!unit.space &&
			!closing.test(previous.text) &&
			!closing.test(unit.text) &&
			!opening.test(previous.text) &&
			!opening.test(unit.text)
				? em * 0.25
				: 0;
		let needed = widths[i] ?? 0;
		let wordEnd = i;
		if (
			keepWords &&
			!unit.cjk &&
			!unit.formula &&
			!unit.space &&
			!closing.test(unit.text)
		) {
			for (let j = i + 1; j < units.length; j++) {
				const next = units[j];
				if (
					!next ||
					next.cjk ||
					next.space ||
					next.formula ||
					closing.test(next.text) ||
					opening.test(next.text)
				)
					break;
				needed += widths[j] ?? 0;
				wordEnd = j;
			}
		}
		if (opening.test(unit.text)) needed += widths[i + 1] ?? 0;
		// Reserve closing punctuation with its preceding word/character.
		for (
			let j = wordEnd + 1;
			j < units.length && closing.test(units[j].text);
			j++
		)
			needed += widths[j];
		if (x + gap + needed > box.x + box.w + 0.01 && x > box.x) {
			// Closing punctuation may hang by half an em; never start a line with it.
			if (
				!(
					closing.test(unit.text) &&
					x + gap + (widths[i] ?? 0) <= box.x + box.w + em * 0.5
				)
			) {
				x = box.x;
				baseline += Math.max(em * lineSkip, lineHeight * 1.05);
				lineHeight = em;
				lineTop = baseline - ascent;
				lineStart = out.length;
				gap = 0;
				previous = undefined;
				if (unit.space) continue;
			}
		}
		const width = unit.width * scale,
			height = unit.height * scale;
		if (unit.formula) {
			const required = height - unit.formula.baselineOffset * scale;
			const shift = Math.max(0, lineTop + required - baseline);
			if (shift > 0) {
				baseline += shift;
				for (let n = lineStart; n < out.length; n++) out[n].y += shift;
			}
		}
		if (
			width > box.w + 0.01 ||
			baseline + Math.max(0, unit.formula?.baselineOffset ?? 0) * scale >
				box.y + box.h + 0.01
		)
			fits = false;
		out.push({
			...unit,
			x: x + gap,
			y: baseline + (unit.formula?.baselineOffset ?? 0) * scale,
			width,
			height,
			fontSize: em,
		});
		x += gap + width;
		lineHeight = Math.max(lineHeight, height);
		previous = unit;
	}
	return {
		id: p.id,
		pageIndex: p.pageIndex,
		sourceBox: p.box,
		box,
		scale,
		units: out,
		fits,
	};
}
function expandedBox(
	p: Paragraph,
	page: ReflowPage,
	obstacles: Box[],
	right: boolean,
): Box {
	const box = { ...p.box };
	if (right) {
		let edge = page.width - 12;
		for (const o of obstacles)
			if (
				o.x >= box.x + box.w - 0.1 &&
				o.y < box.y + box.h &&
				o.y + o.h > box.y
			)
				edge = Math.min(edge, o.x - 5);
		box.w = Math.max(box.w, edge - box.x);
	} else {
		let edge = page.height - 12;
		for (const o of obstacles)
			if (
				o.y >= box.y + box.h - 0.1 &&
				o.x < box.x + box.w &&
				o.x + o.w > box.x
			)
				edge = Math.min(edge, o.y - 2);
		box.h = Math.max(box.h, edge - box.y);
	}
	return box;
}
export function layoutParagraph(
	p: Paragraph,
	text: string,
	page: ReflowPage,
	fonts: ReflowFonts,
	initialScale = 1,
	occupied: Box[] = [],
): ParagraphLayout {
	// MinerU can return an entire TOC as one text region; keep its rows out of prose wrapping.
	const toc = tocLayout(p, text, page, fonts);
	if (toc) return toc;
	const units = translationUnits(p, text, fonts);
	const obstacles = [
		...page.obstacles,
		...page.paragraphs.filter((q) => q.id !== p.id).map((q) => q.box),
		...occupied,
	];
	let fallback: ParagraphLayout | undefined;
	for (const keepWords of [true, false]) {
		let box = { ...(p.layoutBox ?? p.box) };
		for (
			let n = Math.round(initialScale * 100);
			n >= 10;
			n -= n > 60 ? 5 : 10
		) {
			const scale = n / 100;
			if (!p.fixedBox && n === 65)
				box = expandedBox({ ...p, box }, page, obstacles, false);
			if (!p.fixedBox && n === 60)
				box = expandedBox({ ...p, box }, page, obstacles, true);
			const result = place(p, units, box, scale, fonts, keepWords);
			fallback = result;
			if (result.fits) return result;
		}
	}
	if (!fallback) throw new Error(`Cannot typeset ${p.id}`);
	return fallback;
}
/** Full-document pass, then a translated-unit-weighted common scale pass. */
export function layoutReflowDocument(
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fonts: ReflowFonts,
	commonScale = true,
): PageLayout[] {
	const result: PageLayout[] = ir.pages.map((page) => {
		const paragraphs: ParagraphLayout[] = [];
		for (const p of page.paragraphs) {
			const text = translations.get(p.id);
			if (text === undefined) continue;
			paragraphs.push(
				layoutParagraph(
					p,
					text,
					page,
					fonts,
					1,
					paragraphs.map((p) => p.box),
				),
			);
		}
		return {
			index: page.index,
			width: page.width,
			height: page.height,
			paragraphs,
		};
	});
	const weights = new Map<number, number>();
	for (const page of ir.pages)
		for (const p of page.paragraphs) {
			const placed = result
				.find((r) => r.index === page.index)
				?.paragraphs.find((r) => r.id === p.id);
			if (placed) {
				const weight = placed.units.reduce(
					(sum, u) =>
						sum +
						(u.formula
							? u.formula.characterIndexes.length
							: Array.from(u.text).length),
					0,
				);
				weights.set(placed.scale, (weights.get(placed.scale) ?? 0) + weight);
			}
		}
	const common =
		[...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
	for (const page of result) {
		const source = ir.pages.find((p) => p.index === page.index);
		if (!source) continue;
		page.paragraphs = page.paragraphs.map((layout) => {
			const p = source.paragraphs.find((p) => p.id === layout.id),
				text = translations.get(layout.id);
			if (!commonScale || !p || !text || layout.scale <= common) return layout;
			const candidate = layoutParagraph(
				p,
				text,
				source,
				fonts,
				common,
				page.paragraphs.filter((q) => q.id !== p.id).map((q) => q.box),
			);
			return candidate.fits ? candidate : layout;
		});
		// A translated paragraph must not paint over another paragraph's source.
		for (const p of page.paragraphs)
			if (
				source.paragraphs.some(
					(q) =>
						q.id !== p.id &&
						intersects(p.box, q.box) &&
						!intersects(p.sourceBox, q.box),
				)
			)
				p.fits = false;
	}
	return result;
}
