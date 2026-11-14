/**
 * PDF page paper tone (white / sepia / green / dark, independent of app theme).
 *
 * Its own hook because the preference is process-wide: every open viewer follows
 * the same switch through a window event, so each instance both persists and
 * listens instead of threading the value through the workspace.
 */

import { useCallback, useEffect, useState } from "react";
import {
	PDF_PAPER_TONE_EVENT,
	readPdfPaperTone,
	writePdfPaperTone,
} from "@/components/viewer/pdf/paper-tone";
import { isPdfPaperTone, type PdfPaperTone } from "@/lib/pdf/page-theme";
import {
	normalizeReadingSettings,
	READING_SETTINGS_EVENT,
	readReadingSettings,
} from "@/lib/pdf/reading/settings";

export type PdfPaperToneControls = {
	/** Active paper tone. */
	pdfTone: PdfPaperTone;
	setPdfTone: (tone: PdfPaperTone) => void;
};

export function usePdfPaperTone(): PdfPaperToneControls {
	const [pdfTone, setTone] = useState<PdfPaperTone>(readPdfPaperTone);

	const setPdfTone = useCallback((tone: PdfPaperTone) => {
		setTone(tone);
		writePdfPaperTone(tone);
	}, []);

	useEffect(() => {
		const setCustomPaper = (
			settings: ReturnType<typeof readReadingSettings>,
		) => {
			document.documentElement.style.setProperty(
				"--pdf-custom-paper",
				settings.background,
			);
		};
		let currentReading = readReadingSettings();
		setCustomPaper(currentReading);
		const onReadingChange = (event: Event) => {
			const settings = normalizeReadingSettings(
				(event as CustomEvent<unknown>).detail,
			);
			const themeChanged =
				settings.theme !== currentReading.theme ||
				(settings.theme === "custom" &&
					settings.background !== currentReading.background);
			currentReading = settings;
			setCustomPaper(settings);
			if (!themeChanged) return;
			const tone = settings.theme === "original" ? "white" : settings.theme;
			setTone(tone);
			writePdfPaperTone(tone);
		};
		const onToneChange = (event: Event) => {
			const next = (event as CustomEvent<unknown>).detail;
			if (isPdfPaperTone(next)) setTone(next);
		};
		window.addEventListener(PDF_PAPER_TONE_EVENT, onToneChange);
		window.addEventListener(READING_SETTINGS_EVENT, onReadingChange);
		return () => {
			window.removeEventListener(PDF_PAPER_TONE_EVENT, onToneChange);
			window.removeEventListener(READING_SETTINGS_EVENT, onReadingChange);
		};
	}, []);

	return { pdfTone, setPdfTone };
}
