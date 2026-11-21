/**
 * Remembered text-markup shape for new PDF selections.
 *
 * Each swatch owns its shape: filled means highlight, hollow means underline,
 * and a right-click flips only that one color. The palette therefore doubles
 * as the shape control, so the choice has to outlive the transient selection
 * menu — it is stored next to the other per-machine PDF UI preferences (card
 * width, reading position), never vault data.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { HIGHLIGHT_COLORS, type HighlightColor } from "./palette";
import type { PdfTextMarkupKind } from "./types";

const KEY = "agentero-pdf-markup-shapes";

export type MarkupShapes = Record<HighlightColor, PdfTextMarkupKind>;

/** Fresh install: every swatch is a highlight. */
const DEFAULT_SHAPES: MarkupShapes = {
	yellow: "highlight",
	green: "highlight",
	blue: "highlight",
	pink: "highlight",
	purple: "highlight",
};

type StoredShapes = {
	colors?: Partial<Record<HighlightColor, unknown>>;
	/** Shape of the last color the user touched; notes follow it. */
	last?: unknown;
};

function normalizeKind(value: unknown): PdfTextMarkupKind | null {
	return value === "underline" || value === "highlight" ? value : null;
}

function readState(): { colors: MarkupShapes; last: PdfTextMarkupKind } {
	const stored = readJsonStorage<StoredShapes>(KEY, {});
	const colors = { ...DEFAULT_SHAPES };
	for (const color of HIGHLIGHT_COLORS) {
		const kind = normalizeKind(stored?.colors?.[color]);
		if (kind) colors[color] = kind;
	}
	return { colors, last: normalizeKind(stored?.last) ?? "highlight" };
}

/** Shape each swatch applies on click. */
export function readMarkupShapes(): MarkupShapes {
	return readState().colors;
}

/** Shape used by actions that take no color, such as the note button. */
export function readLastMarkupShape(): PdfTextMarkupKind {
	return readState().last;
}

/**
 * Persist one swatch's shape and make it the current note shape.
 * Best effort (quota / private mode).
 */
export function writeMarkupShape(
	color: HighlightColor,
	kind: PdfTextMarkupKind,
): void {
	const { colors } = readState();
	writeJsonStorage(KEY, {
		colors: { ...colors, [color]: kind },
		last: kind,
	});
}

/**
 * Remember the note shape without changing any swatch's click shape, for
 * forced-shape shortcuts that bypass the palette (e.g. ⌥1 → underline).
 */
export function writeLastMarkupShape(kind: PdfTextMarkupKind): void {
	const { colors } = readState();
	writeJsonStorage(KEY, { colors, last: kind });
}

/** The shape a right-click on that swatch switches to. */
export function oppositeTextMarkupKind(
	kind: PdfTextMarkupKind,
): PdfTextMarkupKind {
	return kind === "highlight" ? "underline" : "highlight";
}
