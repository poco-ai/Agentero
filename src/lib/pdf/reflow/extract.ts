import type {
	ImageDataLike,
	PdfDocumentObject,
	PdfEngine,
	PdfGlyphObject,
	PdfPageObject,
	PdfTextRun,
} from "@embedpdf/models";
import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import { figureCaptionKey } from "@/lib/pdf/layout/figure-caption-text";
import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";
import { isReferenceLayoutRegion } from "@/lib/pdf/layout/translation-exclusions";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	characterCoverage,
	fallbackCharacterGroups,
	needsCharacterInkCheck,
	nonPaintingCharacters,
	rotatedCharacterIndexes,
} from "./coverage";
import {
	type Box,
	type Character,
	type CharacterDisposition,
	type CharacterStyle,
	type Formula,
	formulaToken,
	type Paragraph,
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowDocument,
	unionBoxes,
} from "./types";

const centerInside = (a: Box, b: Box) =>
	a.x + a.w / 2 >= b.x &&
	a.x + a.w / 2 <= b.x + b.w &&
	a.y + a.h / 2 >= b.y &&
	a.y + a.h / 2 <= b.y + b.h;
function glyphBox(g: PdfGlyphObject, tight = false): Box {
	const o = tight ? (g.tightOrigin ?? g.origin) : g.origin;
	const s = tight ? (g.tightSize ?? g.size) : g.size;
	return { x: o.x, y: o.y, w: s.width, h: s.height };
}
function styleOf(run?: PdfTextRun): CharacterStyle {
	const font = run?.font.name ?? "";
	// Some embedded Type 1 fonts lack a weight descriptor. PDFium then infers
	// weight from StemV (CMR10 can report 744). TeX face names encode the real
	// variant and take precedence over that estimate, including subset prefixes.
	const texFace =
		/^(?:[A-Z]{6}\+)?CM(R|TI|SL|MI|EX|SY|TT|SS|BX|B|BXTI|BSY|MIB)\d+$/i
			.exec(font)?.[1]
			.toUpperCase();
	// URW's Regu/ReguItal and the standard Roman faces also encode their
	// weight explicitly. StemV-derived weights can mark their body text bold.
	const regularFace = /(?:^|[-,])(?:Regu(?:lar)?(?:Ital(?:ic)?)?|Roman)$/i.test(
		font,
	);
	return {
		font,
		size: run?.fontSize ?? 10,
		bold: texFace
			? /^(?:B|MIB)/.test(texFace)
			: !regularFace &&
				((run?.font.weight ?? 400) >= 600 ||
					/(?:Bold|CMBX|Nimbus.*Medi)/i.test(font)),
		italic:
			(!!texFace && /^(?:TI|SL|MI|BXTI)$/.test(texFace)) ||
			(run?.font.italic ?? false) ||
			/(?:Italic|Oblique|(?:Regu|Medi)Ital$)/i.test(font),
		color: {
			r: run?.color.red ?? 0,
			g: run?.color.green ?? 0,
			b: run?.color.blue ?? 0,
		},
	};
}
function dominantStyle(chars: Character[]): CharacterStyle {
	const weights = new Map<string, { style: CharacterStyle; count: number }>();
	for (const c of chars) {
		if (!c.text.trim()) continue;
		const key = JSON.stringify(c.style);
		const entry = weights.get(key) ?? { style: c.style, count: 0 };
		// Superscript digits can outnumber the author's name; their smaller ink
		// must not determine the main line size or promote scripts to body lines.
		entry.count += c.style.size ** 2;
		weights.set(key, entry);
	}
	return (
		[...weights.values()].sort((a, b) => b.count - a.count)[0]?.style ??
		styleOf()
	);
}
const mathFont =
	/(?:CMSY|CMEX|CMMI|MSAM|MSBM|Math|Symbol|STIX.*(?:Math|Symbols))/i;
const mathSymbol = /[\p{Sm}\u0370-\u03ff\u1d00-\u1d7f\u2070-\u209f]/u;
const cjk =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Detect visual formula islands, including adjacent scripts and punctuation. */
export function paragraphFromCharacters(
	id: string,
	pageIndex: number,
	box: Box,
	chars: Character[],
	formulaBoxes: Box[],
	heading: boolean,
): Paragraph {
	const style = dominantStyle(chars);
	// Ignore tiny local-coordinate text from embedded figures overlapping a
	// normal page paragraph. Its untransformed font size cannot be treated as
	// a superscript of the page's heading/body font.
	if (style.size >= 4)
		chars = chars.filter((c) => c.style.size >= style.size * 0.3);
	// A detached accent is printed above its variable, sometimes closer to the
	// previous prose baseline. Its horizontal overlap identifies its owner.
	const accentBases = new Map<number, Character>();
	for (const c of chars) {
		// biome-ignore lint/suspicious/noMisleadingCharacterClass: Detached PDF accent glyphs arrive as individual spacing or combining code points.
		if (!/^[\u005e\u005f\u0060\u00b4\u02c6-\u02dd\u0300-\u036f]$/u.test(c.text))
			continue;
		const base = chars
			.filter(
				(b) =>
					b !== c &&
					/[\p{L}\p{N}]/u.test(b.text) &&
					b.visualBox.x < c.visualBox.x + c.visualBox.w &&
					b.visualBox.x + b.visualBox.w > c.visualBox.x &&
					b.visualBox.y >= c.visualBox.y + c.visualBox.h - 1 &&
					b.visualBox.y - c.visualBox.y <= style.size * 0.7,
			)
			.sort((a, b) => a.visualBox.y - b.visualBox.y)[0];
		if (base) accentBases.set(c.index, base);
	}
	// A stacked fraction can extend below the midpoint between two prose
	// lines. Tie its small, vertically overlapping operands to a nearby
	// full-size math glyph (e.g. a parenthesis), rather than the next line.
	const fractionBases = new Map<number, Character>();
	for (const c of chars) {
		if (
			!mathFont.test(c.style.font) ||
			c.style.size >= style.size * 0.8 ||
			!c.text.trim()
		)
			continue;
		const stacked = chars.some(
			(other) =>
				other !== c &&
				mathFont.test(other.style.font) &&
				other.style.size < style.size * 0.8 &&
				other.text.trim() &&
				Math.min(
					other.visualBox.x + other.visualBox.w,
					c.visualBox.x + c.visualBox.w,
				) > Math.max(other.visualBox.x, c.visualBox.x) &&
				Math.abs(other.visualBox.y - c.visualBox.y) > c.style.size * 0.7 &&
				Math.abs(other.visualBox.y - c.visualBox.y) < style.size * 1.7,
		);
		if (!stacked) continue;
		const base = chars
			.filter(
				(b) =>
					mathFont.test(b.style.font) &&
					b.style.size >= style.size * 0.85 &&
					Math.max(b.visualBox.x, c.visualBox.x) -
						Math.min(
							b.visualBox.x + b.visualBox.w,
							c.visualBox.x + c.visualBox.w,
						) <=
						style.size * 0.6 &&
					Math.abs(
						b.visualBox.y +
							b.visualBox.h / 2 -
							c.visualBox.y -
							c.visualBox.h / 2,
					) < style.size,
			)
			.sort(
				(a, b) =>
					Math.abs(a.visualBox.x - c.visualBox.x) -
					Math.abs(b.visualBox.x - c.visualBox.x),
			)[0];
		if (base) fractionBases.set(c.index, base);
	}
	const anchors = chars.filter(
		(c) =>
			!accentBases.has(c.index) &&
			c.style.size >= style.size * 0.85 &&
			!mathFont.test(c.style.font) &&
			// Raised apostrophes and quotes have ink near the line's top. They
			// cannot establish its baseline and must follow nearby body glyphs.
			/[\p{L}\p{N}]/u.test(c.text),
	);
	// Font bounding boxes have different descent padding even on the same line.
	// Group by painted glyph bottoms with an em-sized tolerance, so STIX prose,
	// italic operands, and punctuation share a line without merging nearby rows.
	let lines = groupReadingLines(anchors.length ? anchors : chars, (c) => ({
		x: c.box.x,
		y: c.visualBox.y + c.visualBox.h - c.style.size,
		width: c.box.w,
		height: c.style.size,
	}));
	if (anchors.length)
		for (const c of chars.filter((c) => !anchors.includes(c))) {
			const base = accentBases.get(c.index) ?? fractionBases.get(c.index) ?? c;
			const middle = base.visualBox.y + base.visualBox.h / 2;
			const closest = [...lines].sort(
				(a, b) =>
					Math.abs(middle - (a.top + a.bottom) / 2) -
					Math.abs(middle - (b.top + b.bottom) / 2),
			)[0];
			if (
				closest &&
				Math.abs(middle - (closest.top + closest.bottom) / 2) < style.size
			)
				closest.items.push(c);
			else lines.push({ items: [c], top: c.box.y, bottom: c.box.y + c.box.h });
		}
	lines.sort((a, b) => a.top - b.top);
	// A single caption detection can contain two text columns. A gutter must
	// remain empty through at least three baselines with substantial text on
	// both sides; ordinary word spaces and an inset line are insufficient.
	const intervals: { x: number; end: number }[] = [];
	for (const c of chars
		.filter((c) => c.text.trim())
		.sort((a, b) => a.box.x - b.box.x)) {
		const last = intervals.at(-1);
		if (last && c.box.x <= last.end + style.size * 0.6)
			last.end = Math.max(last.end, c.box.x + c.box.w);
		else intervals.push({ x: c.box.x, end: c.box.x + c.box.w });
	}
	for (let i = 1; i < intervals.length; i++) {
		const mid = (intervals[i - 1].end + intervals[i].x) / 2;
		const split = lines.map((line) => [
			line.items.filter((c) => c.box.x + c.box.w / 2 < mid),
			line.items.filter((c) => c.box.x + c.box.w / 2 >= mid),
		]);
		if (
			mid - box.x < box.w * 0.2 ||
			box.x + box.w - mid < box.w * 0.2 ||
			split.filter((s) =>
				s.every((cs) => cs.filter((c) => c.text.trim()).length >= 5),
			).length < 3
		)
			continue;
		lines = [0, 1].flatMap((col) =>
			split.flatMap((s, row) =>
				s[col].some((c) => c.text.trim())
					? [{ ...lines[row], items: s[col] }]
					: [],
			),
		);
		break;
	}
	const ordered = lines.flatMap((l) =>
		l.items.sort((a, b) => a.box.x - b.box.x || a.index - b.index),
	);
	const marked = new Set<number>();
	for (const [index, base] of accentBases) {
		marked.add(index);
		marked.add(base.index);
	}
	for (const c of ordered) {
		if (!c.text.trim()) continue;
		if (
			formulaBoxes.some((b) => centerInside(c.visualBox, b)) ||
			mathFont.test(c.style.font) ||
			(/CM(?:R|BX)\d/i.test(c.style.font) && c.style.font !== style.font) ||
			mathSymbol.test(c.text) ||
			// PDF fonts may map a visible glyph to a control code; keep its ink.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Actual unmapped PDF glyph codes.
			/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\uE000-\uF8FF\uFFFD]/u.test(
				c.text,
			) ||
			(c.style.size < style.size * 0.8 && /[\p{L}\p{N}]/u.test(c.text))
		)
			marked.add(c.index);
	}
	// A math island may include Latin operands, digits, scripts, and brackets.
	// Do not absorb ordinary italic prose or text across a word-sized gap.
	for (const line of lines) {
		const cs = line.items;
		let changed = true;
		while (changed) {
			changed = false;
			cs.forEach((c, i) => {
				if (
					marked.has(c.index) ||
					!/^[\p{L}\p{N}()[\]{}.,+−=/*^_|]+$/u.test(c.text)
				)
					return;
				if (
					/^[.,]$/.test(c.text) &&
					!(
						/^\d$/.test(cs[i - 1]?.text ?? "") &&
						/^\d$/.test(cs[i + 1]?.text ?? "")
					)
				)
					return;
				for (const n of [cs[i - 1], cs[i + 1]]) {
					if (!n || !marked.has(n.index)) continue;
					const gap =
						Math.max(c.visualBox.x, n.visualBox.x) -
						Math.min(
							c.visualBox.x + c.visualBox.w,
							n.visualBox.x + n.visualBox.w,
						);
					if (
						gap < style.size * 0.18 &&
						((c.style.italic && !style.italic) ||
							c.style.size < style.size * 0.85 ||
							!/\p{L}/u.test(c.text))
					) {
						marked.add(c.index);
						changed = true;
						break;
					}
				}
			});
		}
	}
	// Keep citations and space-separated mathematical operands in one movable
	// island. PDFium emits synthetic spaces between N, =, and 6; treating these
	// spaces as prose permits a line break inside the equation.
	for (const line of lines) {
		const cs = line.items;
		const joined = cs.map((c) => c.text).join("");
		for (const match of joined.matchAll(/\[\d+(?:[ ,–−-]+\d+)*\]/g)) {
			let offset = 0;
			for (const c of cs) {
				if (offset >= match.index && offset < match.index + match[0].length)
					marked.add(c.index);
				offset += c.text.length;
			}
		}
		cs.forEach((c, i) => {
			if (!c.text.trim()) {
				const left = cs
					.slice(0, i)
					.reverse()
					.find((c) => c.text.trim());
				const right = cs.slice(i + 1).find((c) => c.text.trim());
				if (
					left &&
					right &&
					marked.has(left.index) &&
					marked.has(right.index) &&
					right.box.x - left.box.x - left.box.w < style.size
				)
					marked.add(c.index);
			}
			// Trailing prose punctuation is not part of the protected expression.
			if (/^[.,;]$/.test(c.text) && !/^\d$/.test(cs[i + 1]?.text ?? ""))
				marked.delete(c.index);
		});
	}
	const formulas: Formula[] = [];
	const membership = new Map<number, Formula>();
	let island: Character[] = [];
	let baseline = box.y + style.size;
	const flush = () => {
		if (!island.length) return;
		const painted = island.filter((c) => c.text.trim());
		if (!painted.length) {
			island = [];
			return;
		}
		const f: Formula = {
			id: String(formulas.length),
			text: island.map((c) => c.text).join(""),
			box: unionBoxes(painted.map((c) => c.visualBox)),
			characterIndexes: island.map((c) => c.index),
			baselineOffset:
				Math.max(...painted.map((c) => c.visualBox.y + c.visualBox.h)) -
				baseline,
		};
		formulas.push(f);
		for (const c of island) membership.set(c.index, f);
		island = [];
	};
	for (const line of lines) {
		const anchors = line.items
			.filter(
				(c) =>
					c.style.size >= style.size * 0.85 && !mathFont.test(c.style.font),
			)
			.map((c) => c.box.y + c.box.h - c.style.size * 0.22)
			.sort((a, b) => a - b);
		baseline =
			anchors[Math.floor(anchors.length / 2)] ??
			line.bottom - style.size * 0.22;
		for (const c of line.items) {
			if (marked.has(c.index)) island.push(c);
			else flush();
		}
		flush();
	}
	const seen = new Set<string>();
	const styles: Record<string, CharacterStyle> = {};
	let activeStyle: string | undefined;
	const styleKey = (s: CharacterStyle) =>
		JSON.stringify([s.bold, s.italic, s.color]);
	const baseKey = styleKey(style);
	let source = "",
		protectedText = "";
	lines.forEach((line, lineIndex) => {
		let previous: Character | undefined;
		for (const c of line.items) {
			if (
				previous &&
				c.box.x - (previous.box.x + previous.box.w) > style.size * 0.16 &&
				!/\s$/.test(source) &&
				!/^\s/.test(c.text) &&
				!(cjk.test(previous.text) && cjk.test(c.text))
			) {
				source += " ";
				protectedText += " ";
			}
			source += c.text;
			const wanted =
				styleKey(c.style) !== baseKey &&
				c.text.trim() &&
				!membership.has(c.index)
					? c.style
					: undefined;
			if (
				wanted
					? !activeStyle || styleKey(styles[activeStyle]) !== styleKey(wanted)
					: activeStyle && c.text.trim()
			) {
				if (activeStyle) protectedText += `⟪/S${activeStyle}⟫`;
				activeStyle = wanted ? String(Object.keys(styles).length) : undefined;
				if (activeStyle && wanted) {
					styles[activeStyle] = wanted;
					protectedText += `⟪S${activeStyle}⟫`;
				}
			}
			const f = membership.get(c.index);
			if (f) {
				if (!seen.has(f.id)) {
					protectedText += formulaToken(f.id);
					seen.add(f.id);
				}
			} else protectedText += c.text;
			previous = c;
		}
		source = source.trimEnd();
		protectedText = protectedText.trimEnd();
		if (lineIndex < lines.length - 1) {
			// PDFium represents discretionary line-end hyphens as soft hyphens.
			if (
				/[-\u00ad]$/.test(source) &&
				/^[a-z]/.test(lines[lineIndex + 1]?.items[0]?.text ?? "")
			) {
				source = source.slice(0, -1);
				protectedText = protectedText.replace(/[-\u00ad]$/, "");
			} else if (
				!(
					cjk.test(source.at(-1) ?? "") &&
					cjk.test(
						lines[lineIndex + 1]?.items.find((c) => c.text.trim())?.text ?? "",
					)
				)
			) {
				source += " ";
				protectedText += " ";
			}
		}
	});
	if (activeStyle) protectedText += `⟪/S${activeStyle}⟫`;
	const first = lines[0]?.items[0]?.box.x ?? box.x;
	const subsequent = lines.slice(1).map((l) => l.items[0]?.box.x ?? first);
	const left = subsequent.length ? Math.min(...subsequent) : first;
	return {
		id,
		pageIndex,
		box,
		characters: ordered,
		formulas,
		styles,
		source: source.trim(),
		protectedText: protectedText.trim(),
		style,
		firstLineIndent: first - left > style.size * 0.5 ? first - left : 0,
		heading,
	};
}

/**
 * Keep character lookup in a synchronous page scope. WebKit 2.50 can retain
 * captured async-loop locals after code collection (WebKit bug 313499).
 */
function pageCharacters(
	glyphs: readonly (PdfGlyphObject | undefined)[],
	runs: readonly PdfTextRun[],
	text: readonly string[],
	styles: Map<string, CharacterStyle>,
): Character[] {
	const byIndex = new Map<number, PdfTextRun>();
	for (const run of runs)
		for (let n = run.charIndex; n < run.charIndex + run.charCount; n++)
			byIndex.set(n, run);
	// Synthetic characters can be absent from run ranges. Font metadata is
	// shared by a PDF text object, so recover it only from that same object.
	const byObject = new Map<number, PdfTextRun>();
	glyphs.forEach((glyph, index) => {
		const run = byIndex.get(index);
		const objectId = (glyph as { textObjectId?: number } | undefined)
			?.textObjectId;
		if (run && objectId !== undefined) byObject.set(objectId, run);
	});
	// Fonts repeat across thousands of glyphs. Keep one immutable style per
	// value in this extraction, and resolve each run/scale combination once.
	const runStyles = new Map<
		PdfTextRun | undefined,
		Map<number, CharacterStyle>
	>();
	const characterStyle = (run: PdfTextRun | undefined, scale: number) => {
		const variants = runStyles.get(run) ?? new Map<number, CharacterStyle>();
		const cached = variants.get(scale);
		if (cached) return cached;
		const candidate = styleOf(run);
		// The fallback size is already in page points; PDFium sizes are local.
		candidate.size *= run && scale > 0 ? scale : 1;
		const key = JSON.stringify(candidate);
		const style = styles.get(key) ?? candidate;
		styles.set(key, style);
		variants.set(scale, style);
		runStyles.set(run, variants);
		return style;
	};
	const characters: Character[] = [];
	for (let index = 0; index < glyphs.length; index++) {
		const g = glyphs[index] as
				| (PdfGlyphObject & {
						clipBoxes?: number[][];
						renderMode?: number;
						textMatrix?: number[];
						textAngle?: number;
						textObjectId?: number;
				  })
				| undefined,
			value = text[index] ?? "";
		if (!value || /[\r\n]/.test(value)) continue;
		if (g)
			characters.push({
				index,
				text: value,
				box: glyphBox(g),
				visualBox: glyphBox(g, true),
				style: (() => {
					const run =
						byIndex.get(index) ??
						(g.textObjectId === undefined
							? undefined
							: byObject.get(g.textObjectId));
					const m = g.textMatrix;
					const scale = m ? Math.hypot(m[0], m[1]) : 1;
					return characterStyle(run, scale);
				})(),
				clipBoxes: g.clipBoxes,
				renderMode: g.renderMode,
				textAngle: g.textAngle,
				textMatrix: g.textMatrix,
				textObjectId: g.textObjectId,
			});
		else if (value === " " && characters.length) {
			const previous = characters[characters.length - 1];
			const box = {
				...previous.box,
				x: previous.box.x + previous.box.w,
				w: 0,
			};
			characters.push({
				index,
				text: value,
				box,
				visualBox: box,
				style: previous.style,
			});
		}
	}
	return characters;
}

/** All per-page closures stay outside the suspendable extraction loop. */
function reflowPage(
	page: PdfPageObject,
	selected: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
	characters: Character[],
	raster: ImageDataLike | null,
	includeReferences = false,
): ReflowDocument["pages"][number] {
	const hidden = raster
		? nonPaintingCharacters(
				characters,
				raster,
				page.size.width,
				page.size.height,
			)
		: new Set<number>();

	// Clip paths are local to their containing Form. Until that hierarchy is
	// reconstructed, keep transformed clipped text rather than repaint it
	// without its inherited clip.
	const clipped = new Set(
		characters
			.filter(
				(c) =>
					c.clipBoxes?.length &&
					c.textMatrix &&
					Math.abs(Math.hypot(c.textMatrix[0], c.textMatrix[1]) - 1) > 0.01,
			)
			.map((c) => c.index),
	);

	const pageRegions = regions.filter(
		(r) => r.pageIndex === page.index && r.score >= LAYOUT_SIDEBAR_MIN_SCORE,
	);
	const references = includeReferences
		? []
		: pageRegions.filter(isReferenceLayoutRegion);
	const referenceCharacters = new Set(
		characters
			.filter((c) => references.some((r) => centerInside(c.visualBox, r.rect)))
			.map((c) => c.index),
	);
	const formulaBoxes = pageRegions
		.filter((r) => r.kind === "formula")
		.map((r) => r.rect);
	const claimed = new Set<number>();
	const conflictingHeadingObjects = new Set<number>();
	// A whole-column detection can overlap several individual paragraphs.
	// Let the smaller complete paragraphs claim their text before the container.
	const containers = new Set(
		selected
			.filter(
				(item) =>
					selected.filter(
						(other) =>
							other !== item &&
							other.bbox.w * other.bbox.h < (item.bbox.w * item.bbox.h) / 3 &&
							bboxCoveredBy(other.bbox, item.bbox) >= 0.9,
					).length >= 2,
			)
			.map((item) => item.id),
	);
	const paragraphs = [...selected]
		.sort((a, b) => Number(containers.has(a.id)) - Number(containers.has(b.id)))
		.map((item) => {
			const box = {
				x: item.bbox.x * page.size.width,
				y: item.bbox.y * page.size.height,
				w: item.bbox.w * page.size.width,
				h: item.bbox.h * page.size.height,
			};
			let chars = characters.filter(
				(c) =>
					!hidden.has(c.index) &&
					!clipped.has(c.index) &&
					!referenceCharacters.has(c.index) &&
					!claimed.has(c.index) &&
					// Advance boxes share vertical line metrics. Ink centers vary
					// with ascenders/descenders and can split a boundary word.
					centerInside(c.box, box),
			);
			if (item.kind === "header") {
				const transformKey = (c: Character) =>
					c.textMatrix
						?.slice(0, 4)
						.map((n) => n.toFixed(2))
						.join(",") ?? "identity";
				const weights = new Map<string, number>();
				for (const c of chars)
					if (c.text.trim())
						weights.set(
							transformKey(c),
							(weights.get(transformKey(c)) ?? 0) + 1,
						);
				const dominant = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0];
				if (weights.size > 1) {
					for (const c of chars)
						if (transformKey(c) !== dominant && c.textObjectId !== undefined)
							conflictingHeadingObjects.add(c.textObjectId);
					chars = chars.filter(
						(c) => !c.text.trim() || transformKey(c) === dominant,
					);
				}
			}
			// A tight detector may start after a reference or list number. Recover
			// its adjacent prefix before a broad container claims that stray digit.
			const first = chars
				.filter((c) => c.text.trim())
				.sort((a, b) => a.index - b.index)[0];
			if (first) {
				const prefix = characters.filter(
					(c) =>
						!claimed.has(c.index) &&
						!hidden.has(c.index) &&
						!clipped.has(c.index) &&
						!referenceCharacters.has(c.index) &&
						c.index < first.index &&
						c.index >= first.index - 4 &&
						c.box.x + c.box.w <= first.box.x + 0.5 &&
						first.box.x - c.box.x - c.box.w <= first.style.size &&
						Math.abs(c.box.y - first.box.y) < first.style.size * 0.3,
				);
				if (/^\d{1,3}[.)]?\s*$/u.test(prefix.map((c) => c.text).join("")))
					chars.push(...prefix);
			}

			if (
				chars.length &&
				characters.some((c) => claimed.has(c.index) && centerInside(c.box, box))
			) {
				// Anchor overlapping detections to the characters they actually own.
				const owned = unionBoxes(
					chars.filter((c) => c.text.trim()).map((c) => c.box),
				);
				const bottom = Math.min(box.y + box.h, owned.y + owned.h);
				box.y = Math.max(box.y, owned.y);
				box.h = Math.max(owned.h, bottom - box.y);
			}
			if (chars.some((c) => c.text.trim())) {
				// Include the whole owned boundary line in the prepared geometry,
				// so overlapping OCR detections cannot resurrect it as extra prose.
				Object.assign(
					box,
					unionBoxes([
						box,
						...chars.filter((c) => c.text.trim()).map((c) => c.box),
					]),
				);
			}
			for (const c of chars) claimed.add(c.index);
			return paragraphFromCharacters(
				item.id,
				page.index,
				box,
				chars,
				formulaBoxes,
				item.kind === "header",
			);
		})
		.filter((p) => p.characters.length > 0);
	// Detector bounds sometimes shave off a small leading footnote marker.
	// Recover it only when it directly precedes an owned baseline; isolated
	// digits elsewhere on the page are still excluded by the fallback rules.
	for (const c of characters) {
		if (
			claimed.has(c.index) ||
			hidden.has(c.index) ||
			clipped.has(c.index) ||
			referenceCharacters.has(c.index) ||
			!/^[\p{L}\p{N}*†‡]+$/u.test(c.text)
		)
			continue;
		const candidates = paragraphs
			.flatMap((p, index) => {
				if (c.style.size >= p.style.size * 0.8) return [];
				const next = p.characters
					.filter(
						(n) =>
							n.text.trim() &&
							n.box.x >= c.box.x + c.box.w - 0.5 &&
							n.box.x - c.box.x - c.box.w <= p.style.size * 0.6 &&
							n.box.y >= c.box.y &&
							n.box.y < c.box.y + c.box.h,
					)
					.sort((a, b) => a.box.x - b.box.x)[0];
				return next ? [{ p, index, gap: next.box.x - c.box.x - c.box.w }] : [];
			})
			.sort((a, b) => a.gap - b.gap);
		const owner = candidates[0];
		if (!owner) continue;
		const p = owner.p;
		paragraphs[owner.index] = paragraphFromCharacters(
			p.id,
			page.index,
			unionBoxes([p.box, c.box]),
			[...p.characters, c],
			formulaBoxes,
			p.heading,
		);
		claimed.add(c.index);
	}
	// Account only for characters retained in the IR (tiny embedded glyphs
	// may have been filtered while constructing a detected paragraph).
	claimed.clear();
	for (const p of paragraphs)
		for (const c of p.characters) claimed.add(c.index);
	const preserved = new Map<number, CharacterDisposition>();
	const rotated = rotatedCharacterIndexes(characters);
	for (const c of characters) {
		if (
			referenceCharacters.has(c.index) ||
			(c.textObjectId !== undefined &&
				conflictingHeadingObjects.has(c.textObjectId))
		)
			preserved.set(c.index, "excluded");
		else if (clipped.has(c.index)) preserved.set(c.index, "clipped");
		else if (hidden.has(c.index)) preserved.set(c.index, "nonpainting");
		else if (rotated.has(c.index)) preserved.set(c.index, "rotated");
		else if (
			pageRegions.some(
				(r) =>
					(r.kind === "formula" ||
						r.kind === "algorithm" ||
						r.label === "aside_text") &&
					centerInside(c.visualBox, r.rect),
			)
		)
			preserved.set(
				c.index,
				pageRegions.some(
					(r) => r.kind === "formula" && centerInside(c.visualBox, r.rect),
				)
					? "formula"
					: "excluded",
			);
	}
	for (const table of pageRegions.filter((r) => r.kind === "table")) {
		const remaining = characters.filter(
			(c) =>
				!hidden.has(c.index) &&
				!clipped.has(c.index) &&
				!referenceCharacters.has(c.index) &&
				!claimed.has(c.index) &&
				centerInside(c.visualBox, table.rect),
		);
		// A layout model can label a diagram containing vertical word labels as
		// a table. Detect vertical advance from adjacent source glyphs before
		// row clustering; otherwise each letter becomes a tiny fake cell.
		const orderedByIndex = remaining
			.filter((c) => c.text.trim())
			.sort((a, b) => a.index - b.index);
		let vertical = 0,
			horizontal = 0;
		for (let i = 1; i < orderedByIndex.length; i++) {
			const a = orderedByIndex[i - 1],
				b = orderedByIndex[i];
			if (b.index - a.index !== 1) continue;
			const dx = Math.abs(b.box.x - a.box.x),
				dy = Math.abs(b.box.y - a.box.y);
			if (dy > dx * 2 && dx < 2) vertical++;
			else if (dx > dy * 2 && dy < 2) horizontal++;
		}
		if (vertical > horizontal && vertical > 5) continue;
		const rows = groupReadingLines(remaining, (c) => ({
			x: c.box.x,
			y: c.box.y,
			width: c.box.w,
			height: c.box.h,
		}));
		for (const row of rows) {
			const ordered = row.items.sort((a, b) => a.box.x - b.box.x);
			const cells: Character[][] = [];
			let cell: Character[] = [];
			for (const c of ordered) {
				const previous = cell.at(-1);
				if (
					previous &&
					c.box.x - (previous.box.x + previous.box.w) >
						Math.max(previous.style.size, c.style.size) * 0.7
				) {
					cells.push(cell);
					cell = [];
				}
				cell.push(c);
			}
			if (cell.length) cells.push(cell);
			for (const cell of cells) {
				if (!/[\p{L}]/u.test(cell.map((c) => c.text).join(""))) continue;
				const box = unionBoxes(
					cell.filter((c) => c.text.trim()).map((c) => c.box),
				);
				if (box.w <= 0 || box.h <= 0) continue;
				const p = paragraphFromCharacters(
					`${table.id}:cell:${cell[0].index}`,
					page.index,
					box,
					cell,
					[],
					false,
				);
				// Mathematical and numeric cells are already correct in the source.
				// Keep them intact rather than cutting superscripts into separate rows.
				if (!/\p{L}/u.test(p.protectedText.replace(/⟪(?:F|\/?S)\d+⟫/gu, "")))
					continue;
				p.fixedBox = true;
				p.origin = "table";
				// The next cell's source start bounds free horizontal space;
				// text removal still uses the original tight source box.
				const next = cells[cells.indexOf(cell) + 1]?.find((c) => c.text.trim());
				const right = next ? next.box.x - 1 : table.rect.x + table.rect.w;
				p.layoutBox = { ...box, w: Math.max(box.w, right - box.x) };
				paragraphs.push(p);
				for (const c of cell) claimed.add(c.index);
			}
		}
	}
	for (const c of characters) {
		if (
			!preserved.has(c.index) &&
			pageRegions.some(
				(r) => r.kind === "table" && centerInside(c.visualBox, r.rect),
			)
		)
			preserved.set(c.index, "table");
	}
	const unclaimed = characters.filter(
		(c) => !claimed.has(c.index) && !preserved.has(c.index),
	);
	for (const group of fallbackCharacterGroups(unclaimed)) {
		const box = unionBoxes(group.map((c) => c.box));
		if (!(box.w > 0 && box.h > 0)) continue;
		const p = paragraphFromCharacters(
			`${page.index}:fallback:${group[0].index}`,
			page.index,
			box,
			group,
			[],
			false,
		);
		if (!/\p{L}{2}/u.test(p.protectedText.replace(/⟪(?:F|\/?S)\d+⟫/gu, "")))
			continue;
		p.fixedBox = true;
		p.origin = "fallback";
		paragraphs.push(p);
	}
	for (const p of paragraphs)
		if (p.layoutBox) {
			const b = p.layoutBox;
			for (const q of paragraphs)
				if (
					q.id !== p.id &&
					q.box.x >= p.box.x + p.box.w - 0.1 &&
					q.box.y < b.y + b.h &&
					q.box.y + q.box.h > b.y
				)
					b.w = Math.max(p.box.w, Math.min(b.w, q.box.x - b.x - 1));
		}
	return {
		index: page.index,
		width: page.size.width,
		height: page.size.height,
		paragraphs,
		coverage: characterCoverage(characters, paragraphs, preserved),
		obstacles: pageRegions
			.filter((r) => !selected.some((i) => i.id === r.id))
			.map((r) => r.rect),
	};
}

export type ReflowExtractionOptions = {
	/** Reading keeps bibliography text; translation leaves the source PDF intact. */
	includeReferences?: boolean;
	/** Recover source text even on pages without selected translation regions. */
	includeUnselectedPages?: boolean;
	/** Restrict extraction to missing cache pages without changing PDF indexes. */
	pageIndexes?: ReadonlySet<number>;
};

/** Index-based extraction avoids matching normalized run strings to geometry. */
export async function extractReflowDocument(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
	signal?: AbortSignal,
	options: ReflowExtractionOptions = {},
): Promise<ReflowDocument> {
	const pages: ReflowDocument["pages"] = [];
	const styles = new Map<string, CharacterStyle>();
	for (const page of doc.pages) {
		if (options.pageIndexes && !options.pageIndexes.has(page.index)) continue;
		const selected: LayoutTranslateItem[] = [];
		for (const item of items)
			if (item.pageIndex === page.index) selected.push(item);
		// Claim numbered captions before overlapping generic body detections.
		selected.sort(
			(a, b) =>
				Number(b.kind === "figure_title" && !!figureCaptionKey(b.source)) -
				Number(a.kind === "figure_title" && !!figureCaptionKey(a.source)),
		);
		if (!selected.length && !options.includeUnselectedPages) continue;
		signal?.throwIfAborted();
		const glyphs = await engine.getPageGlyphs(doc, page).toPromise();
		const { runs } = await engine.getPageTextRuns(doc, page).toPromise();
		const slices = [];
		for (let charIndex = 0; charIndex < glyphs.length; charIndex++)
			slices.push({
				pageIndex: page.index,
				charIndex,
				charCount: 1,
				rawCharacters: true,
			});
		const text = await engine.getTextSlices(doc, slices).toPromise();
		signal?.throwIfAborted();
		const characters = pageCharacters(glyphs, runs, text, styles);
		// Ordinary text never reads the raster. Avoid allocating and copying a
		// full-page RGBA buffer through the worker for every page of a long PDF.
		const raster = characters.some(needsCharacterInkCheck)
			? await engine.renderPageRaw(doc, page, { scaleFactor: 2 }).toPromise()
			: null;
		signal?.throwIfAborted();
		pages.push(
			reflowPage(
				page,
				selected,
				regions,
				characters,
				raster,
				options.includeReferences,
			),
		);
	}
	return { version: REFLOW_IR_SCHEMA_VERSION, pages };
}
