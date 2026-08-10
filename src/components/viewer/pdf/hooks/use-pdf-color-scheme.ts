/**
 * PDF page colour scheme (light / dark pages, independent of the app theme).
 *
 * Its own hook because the preference is process-wide: every open viewer follows
 * the same switch through a window event, so each instance both persists and
 * listens instead of threading the value through the workspace.
 */

import { useCallback, useEffect, useState } from "react";
import {
	PDF_COLOR_SCHEME_EVENT,
	type PdfColorScheme,
	readPdfColorScheme,
	writePdfColorScheme,
} from "@/components/viewer/pdf/color-scheme";

export type PdfColorSchemeControls = {
	/** True when pages render inverted (dark PDF mode). */
	pdfDark: boolean;
	togglePdfColorScheme: () => void;
};

export function usePdfColorScheme(): PdfColorSchemeControls {
	const [pdfColorScheme, setPdfColorScheme] =
		useState<PdfColorScheme>(readPdfColorScheme);

	const togglePdfColorScheme = useCallback(() => {
		setPdfColorScheme((current) => {
			const next: PdfColorScheme = current === "dark" ? "light" : "dark";
			writePdfColorScheme(next);
			return next;
		});
	}, []);

	useEffect(() => {
		const onColorSchemeChange = (event: Event) => {
			const next = (event as CustomEvent<PdfColorScheme>).detail;
			if (next === "light" || next === "dark") setPdfColorScheme(next);
		};
		window.addEventListener(PDF_COLOR_SCHEME_EVENT, onColorSchemeChange);
		return () => {
			window.removeEventListener(PDF_COLOR_SCHEME_EVENT, onColorSchemeChange);
		};
	}, []);

	return { pdfDark: pdfColorScheme === "dark", togglePdfColorScheme };
}
