/**
 * Per-paper PDF reading view, kept in localStorage so reopening a paper returns
 * to the mode the reader last used. The dual-pane mode is not stored: it is
 * derived from whether the paper's translation pane is open in the workspace,
 * so closing that tab always falls back to the last single-pane view.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { normalizePathKey } from "@/lib/vault/path";

/** `dual` is derived from the translation tab; only the other two persist. */
export type PdfViewMode = "original" | "translated" | "dual";

type StoredMode = Exclude<PdfViewMode, "dual">;

const KEY = "agentero-pdf-view-mode";

function readMap(): Record<string, StoredMode> {
	const parsed = readJsonStorage<unknown>(KEY, {});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, StoredMode>)
		: {};
}

/**
 * Last single-pane view for this paper. Loose PDFs without a paper path are
 * not tracked and always open on the original.
 */
export function readPdfViewMode(paperKey: string | null): StoredMode {
	if (!paperKey) return "original";
	return readMap()[normalizePathKey(paperKey)] === "translated"
		? "translated"
		: "original";
}

export function writePdfViewMode(
	paperKey: string | null,
	mode: StoredMode,
): void {
	if (!paperKey) return;
	const key = normalizePathKey(paperKey);
	// Newest first so the map cannot grow without bound on large vaults.
	const others = Object.entries(readMap()).filter(([entry]) => entry !== key);
	writeJsonStorage(
		KEY,
		Object.fromEntries([[key, mode], ...others.slice(0, 199)]) as Record<
			string,
			StoredMode
		>,
	);
}
