import type {
	PdfDocumentObject,
	PdfEngine,
	PdfGlyphObject,
	PdfTextRun,
} from "@embedpdf/models";
import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";
import { preservedLayoutRegions } from "@/lib/pdf/layout/translation-exclusions";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	characterCoverage,
	fallbackCharacterGroups,
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
	return {
		font: run?.font.name ?? "",
		size: run?.fontSize ?? 10,
		bold:
			(run?.font.weight ?? 400) >= 600 ||
			/(?:Bold|CMBX|Nimbus.*Medi)/i.test(run?.font.name ?? ""),
		italic:
			(run?.font.italic ?? false) ||
			/(?:Italic|Oblique)/i.test(run?.font.name ?? ""),
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
		entry.count++;
		weights.set(key, entry);
	}
	return (
		[...weights.values()].sort((a, b) => b.count - a.count)[0]?.style ??
		styleOf()
	);
}
const mathFont =
	/(?:CMSY|CMEX|CMMI|MSAM|MSBM|Math|Symbol|STIX.*(?:Math|Symbols)|tx(?:sys|sy|mi|ex)\w*)/i;
const mathSymbol = /[\p{Sm}\u0370-\u03ff\u1d00-\u1d7f\u2070-\u209f]/u;

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
	const anchors = chars.filter(
		(c) => c.style.size >= style.size * 0.85 && !mathFont.test(c.style.font),
	);
	const lines = groupReadingLines(anchors.length ? anchors : chars, (c) => ({
		x: c.box.x,
		y: c.box.y,
		width: c.box.w,
		height: c.box.h,
	}));
	if (anchors.length)
		for (const c of chars.filter((c) => !anchors.includes(c))) {
			const middle = c.visualBox.y + c.visualBox.h / 2;
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
	const ordered = lines.flatMap((l) =>
		l.items.sort((a, b) => a.box.x - b.box.x || a.index - b.index),
	);
	const marked = new Set<number>();
	for (const c of ordered) {
		if (!c.text.trim()) continue;
		if (
			formulaBoxes.some((b) => centerInside(c.visualBox, b)) ||
			mathFont.test(c.style.font) ||
			(/CM(?:R|BX)\d/i.test(c.style.font) && c.style.font !== style.font) ||
			mathSymbol.test(c.text) ||
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
		const glyphs = island.map((c) => c.visualBox);
		const f: Formula = {
			id: String(formulas.length),
			text: island.map((c) => c.text).join(""),
			box: unionBoxes(glyphs),
			characterIndexes: island.map((c) => c.index),
			// The snippet is drawn as an image. Its bottom must include tall
			// delimiters/radicals that descend below the formula baseline.
			baselineOffset: Math.max(...glyphs.map((b) => b.y + b.h)) - baseline,
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
				!/^\s/.test(c.text)
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
			} else {
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

/** Index-based extraction avoids matching normalized run strings to geometry. */
export async function extractReflowDocument(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
	signal?: AbortSignal,
): Promise<ReflowDocument> {
	const pages: ReflowDocument["pages"] = [];
	const sourcePreservedIds = preservedLayoutRegions(regions);
	for (const page of doc.pages) {
		const selected = items.filter((i) => i.pageIndex === page.index);
		if (!selected.length) continue;
		signal?.throwIfAborted();
		const glyphs = await engine.getPageGlyphs(doc, page).toPromise();
		const { runs } = await engine.getPageTextRuns(doc, page).toPromise();
		const indices = Array.from({ length: glyphs.length }, (_, i) => i);
		const text = await engine
			.getTextSlices(
				doc,
				indices.map((charIndex) => ({
					pageIndex: page.index,
					charIndex,
					charCount: 1,
					rawCharacters: true,
				})),
			)
			.toPromise();
		signal?.throwIfAborted();
		const byIndex = new Map<number, PdfTextRun>();
		for (const run of runs)
			for (let n = run.charIndex; n < run.charIndex + run.charCount; n++)
				byIndex.set(n, run);
		const characters: Character[] = [];
		for (const index of indices) {
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
						const style = styleOf(byIndex.get(index));
						const m = g.textMatrix;
						const scale = m ? Math.hypot(m[0], m[1]) : 1;
						return { ...style, size: style.size * (scale > 0 ? scale : 1) };
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
		const raster = await engine
			.renderPageRaw(doc, page, { scaleFactor: 2 })
			.toPromise();
		const hidden = nonPaintingCharacters(
			characters,
			raster,
			page.size.width,
			page.size.height,
		);

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
		const sourcePreservedRegions = regions.filter(
			(r) => r.pageIndex === page.index && sourcePreservedIds.has(r.id),
		);
		const sourcePreservedCharacters = new Set(
			characters
				.filter((c) =>
					sourcePreservedRegions.some((r) => centerInside(c.visualBox, r.rect)),
				)
				.map((c) => c.index),
		);
		const formulaBoxes = pageRegions
			.filter((r) => r.kind === "formula")
			.map((r) => r.rect);
		const claimed = new Set<number>();
		const conflictingHeadingObjects = new Set<number>();
		const paragraphs = selected
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
						!sourcePreservedCharacters.has(c.index) &&
						!claimed.has(c.index) &&
						centerInside(c.visualBox, box),
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

				if (
					chars.length &&
					characters.some(
						(c) => claimed.has(c.index) && centerInside(c.visualBox, box),
					)
				) {
					// Anchor overlapping detections to the characters they actually own.
					const owned = unionBoxes(
						chars.filter((c) => c.text.trim()).map((c) => c.box),
					);
					const bottom = Math.min(box.y + box.h, owned.y + owned.h);
					box.y = Math.max(box.y, owned.y);
					box.h = Math.max(owned.h, bottom - box.y);
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
		// Account only for characters retained in the IR (tiny embedded glyphs
		// may have been filtered while constructing a detected paragraph).
		claimed.clear();
		for (const p of paragraphs)
			for (const c of p.characters) claimed.add(c.index);
		const preserved = new Map<number, CharacterDisposition>();
		const rotated = rotatedCharacterIndexes(characters);
		for (const c of characters) {
			if (
				sourcePreservedCharacters.has(c.index) ||
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
					!sourcePreservedCharacters.has(c.index) &&
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
					const next = cells[cells.indexOf(cell) + 1]?.find((c) =>
						c.text.trim(),
					);
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
		pages.push({
			index: page.index,
			width: page.size.width,
			height: page.size.height,
			paragraphs,
			coverage: characterCoverage(characters, paragraphs, preserved),
			obstacles: pageRegions
				.filter((r) => !selected.some((i) => i.id === r.id))
				.map((r) => r.rect),
		});
	}
	return { version: REFLOW_IR_SCHEMA_VERSION, pages };
}
