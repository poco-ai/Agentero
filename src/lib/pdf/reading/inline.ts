import type {
	Character,
	CharacterStyle,
	Formula,
	Paragraph,
} from "@/lib/pdf/reflow/types";
import { unionBoxes } from "@/lib/pdf/reflow/types";
import { findPreservedLinkSpans } from "@/lib/translate/preserved-links";

export type ReadingInlinePart = {
	start: number;
	end: number;
	text: string;
	style?: CharacterStyle;
	formula?: Formula;
	raster: boolean;
};

/** Expand cached protection tags without changing the translation contract. */
export function readingInlineParts(
	text: string,
	paragraph?: Paragraph,
	links: readonly { start: number; end: number }[] = [],
) {
	const parts: ReadingInlinePart[] = [];
	let display = "",
		cursor = 0,
		active: CharacterStyle | undefined;
	const append = (value: string, formula?: Formula) => {
		if (!value) return;
		const start = display.length;
		display += value;
		parts.push({
			start,
			end: display.length,
			text: value,
			style: active,
			formula,
			raster: !!formula,
		});
	};
	for (const token of text.matchAll(/⟪(F|S|\/S)(\d+)⟫/gu)) {
		append(text.slice(cursor, token.index));
		const id = token[2];
		if (token[1] === "F") {
			const formula = paragraph?.formulas.find((f) => f.id === id);
			if (formula) append(formula.text, formula);
		} else active = token[1] === "S" ? paragraph?.styles[id] : undefined;
		cursor = token.index + token[0].length;
	}
	append(text.slice(cursor));
	// Publishers may split one citation across several protected islands. Match
	// the restored text so both halves remain selectable and share native links.
	const citations = findPreservedLinkSpans(display).filter(
		(s) => s.kind === "citation",
	);
	for (const part of parts) {
		if (!part.formula) continue;
		if (
			citations.some((s) => part.start >= s.start && part.end <= s.end) ||
			/^[\p{L}\p{Nd}\p{Sm}∆]$/u.test(part.text) ||
			(paragraph && isLinearFormula(part.formula, paragraph))
		)
			part.raster = false;
	}
	const linked = parts.flatMap((part): ReadingInlinePart[] => {
		const formula = part.formula;
		if (
			!formula ||
			!part.raster ||
			!paragraph ||
			!links.some((l) => l.start < part.end && l.end > part.start)
		)
			return [part];
		const points = [
			...new Set([
				part.start,
				part.end,
				...links
					.flatMap((l) => [l.start, l.end])
					.filter((p) => p > part.start && p < part.end),
			]),
		].sort((a, b) => a - b);
		const byIndex = new Map(paragraph.characters.map((c) => [c.index, c]));
		const own = formula.characterIndexes.flatMap((i) => {
			const c = byIndex.get(i);
			return c ? [c] : [];
		});
		return points.slice(0, -1).map((start, i) => {
			const end = points[i + 1];
			let offset = part.start;
			const cs = own.filter((c) => {
				const from = offset;
				offset += c.text.length;
				return from >= start && from < end;
			});
			const painted = cs.filter((c) => c.text.trim());
			const box = painted.length
				? unionBoxes(painted.map((c) => c.visualBox))
				: formula.box;
			const isLinked = links.some((l) => l.start <= start && l.end >= end);
			return {
				...part,
				start,
				end,
				text: display.slice(start, end),
				raster: !isLinked,
				formula: {
					...formula,
					id: `${formula.id}:${start}`,
					text: display.slice(start, end),
					box,
					characterIndexes: cs.map((c) => c.index),
					baselineOffset:
						formula.baselineOffset +
						box.y +
						box.h -
						formula.box.y -
						formula.box.h,
				},
			};
		});
	});
	return { text: display, parts: linked };
}

/** Uniform text on one native baseline needs no raster, unlike fractions or scripts. */
function isLinearFormula(formula: Formula, paragraph: Paragraph): boolean {
	if (!/^[\p{L}\p{Nd}()[\].,+−=<>×÷ ±-]{2,32}$/u.test(formula.text))
		return false;
	const indices = new Set(formula.characterIndexes);
	const own = paragraph.characters.filter(
		(c) => indices.has(c.index) && c.text.trim(),
	);
	const first = own[0];
	if (
		!first?.textMatrix ||
		own.length < 2 ||
		own
			.map((c) => c.text)
			.join("")
			.replace(/\s/g, "") !== formula.text.replace(/\s/g, "")
	)
		return false;
	const baseline = first.textMatrix[5];
	return own.every(
		(c) =>
			c.textMatrix &&
			Number.isFinite(c.textMatrix[5]) &&
			Math.abs(c.textAngle ?? 0) < 0.01 &&
			Math.abs(c.textMatrix[5] - baseline) < 0.25 &&
			Math.abs(c.box.y - first.box.y) < first.style.size * 0.25 &&
			c.style.font === first.style.font &&
			c.style.size === first.style.size &&
			c.style.bold === first.style.bold &&
			c.style.italic === first.style.italic,
	);
}

const median = (values: number[]): number | undefined => {
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length / 2)];
};

/** Accept a text-object baseline only when it belongs to this physical line. */
function characterBaseline(
	character: Character,
	pageHeight: number,
): number | undefined {
	const matrix = character.textMatrix;
	if (
		!matrix ||
		!Number.isFinite(matrix[5]) ||
		Math.abs(character.textAngle ?? 0) > 0.01
	)
		return;
	const baseline = pageHeight - matrix[5];
	if (
		baseline < character.box.y - 1 ||
		baseline > character.box.y + character.box.h + 1
	)
		return;
	return baseline;
}

export function readingFormulaMetrics(
	paragraph: Paragraph,
	formula: Formula,
	pageHeight: number,
) {
	const indices = new Set(formula.characterIndexes);
	const own = paragraph.characters.filter(
		(c) => indices.has(c.index) && c.text.trim(),
	);
	const sameLine = paragraph.characters.filter(
		(c) =>
			!indices.has(c.index) &&
			c.text.trim() &&
			c.style.size >= paragraph.style.size * 0.85 &&
			Math.abs(
				c.visualBox.y + c.visualBox.h / 2 - formula.box.y - formula.box.h / 2,
			) <
				paragraph.style.size * 0.8,
	);
	// A raised scalar near a line break can overlap both lines' ink bands.
	// Its closest source neighbours identify the owning line, even when the
	// previous line contains far more characters and would dominate the median.
	const scalarAnchor =
		own.length === 1
			? sameLine
					.sort(
						(a, b) =>
							Math.abs(a.index - own[0].index) -
								Math.abs(b.index - own[0].index) ||
							Math.abs(a.box.x - own[0].box.x) -
								Math.abs(b.box.x - own[0].box.x),
					)
					.find((c) => characterBaseline(c, pageHeight) !== undefined)
			: undefined;
	const baseline =
		(scalarAnchor && characterBaseline(scalarAnchor, pageHeight)) ??
		median(
			sameLine.flatMap((c) => {
				const value = characterBaseline(c, pageHeight);
				return value === undefined ? [] : [value];
			}),
		) ??
		formula.box.y + formula.box.h - formula.baselineOffset;
	const ownBaseline = median(
		own.flatMap((c) => {
			const value = characterBaseline(c, pageHeight);
			return value === undefined ? [] : [value];
		}),
	);
	const fontSize =
		median(own.map((c) => c.style.size)) ??
		paragraph.style.size *
			(formula.box.h < paragraph.style.size * 0.65 ? 0.7 : 1);
	return {
		baselineOffset: formula.box.y + formula.box.h - baseline,
		fontScale: fontSize / paragraph.style.size,
		textRise:
			ownBaseline === undefined
				? formula.box.h < paragraph.style.size * 0.65
					? Math.max(0, -formula.baselineOffset)
					: 0
				: baseline - ownBaseline,
		style: own[0]?.style,
	};
}
