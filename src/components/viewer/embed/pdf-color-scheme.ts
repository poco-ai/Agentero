/**
 * PDF page color scheme (light / dark pages, independent of the app theme).
 * Persisted per install and broadcast so every open viewer follows the switch.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

export type PdfColorScheme = "light" | "dark";

const PDF_COLOR_SCHEME_STORAGE_KEY = "agentero-pdf-color-scheme";
export const PDF_COLOR_SCHEME_EVENT = "agentero:pdf-color-scheme";

function getDocumentColorScheme(): PdfColorScheme {
	if (typeof document === "undefined") return "light";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Stored preference, falling back to the app theme on first use. */
export function readPdfColorScheme(): PdfColorScheme {
	const stored = readJsonStorage<PdfColorScheme | null>(
		PDF_COLOR_SCHEME_STORAGE_KEY,
		null,
	);
	return stored === "light" || stored === "dark"
		? stored
		: getDocumentColorScheme();
}

export function writePdfColorScheme(next: PdfColorScheme): void {
	writeJsonStorage(PDF_COLOR_SCHEME_STORAGE_KEY, next);
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<PdfColorScheme>(PDF_COLOR_SCHEME_EVENT, {
				detail: next,
			}),
		);
	}
}
