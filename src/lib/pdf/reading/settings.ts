import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

export const READING_SETTINGS_EVENT =
	"agentero:pdf-continuous-reading-settings";
const STORAGE_KEY = "agentero-pdf-continuous-reading-settings";
export const READING_THEMES = [
	"original",
	"dark",
	"black",
	"snow",
	"sepia",
	"custom",
] as const;
export type ReadingTheme = (typeof READING_THEMES)[number];
export type ReadingSplit = "single" | "side-by-side" | "top-bottom";
export type ReadingSettings = {
	fontScale: number;
	lineHeight: number;
	wordSpacing: number;
	characterSpacing: number;
	pageWidth: number;
	split: ReadingSplit;
	theme: ReadingTheme;
	foreground: string;
	background: string;
};
export const READING_LIMITS = {
	fontScale: { min: 0.5, max: 3, step: 0.01 },
	lineHeight: { min: 1, max: 2.5, step: 0.1 },
	wordSpacing: { min: -20, max: 100, step: 1 },
	characterSpacing: { min: -5, max: 30, step: 1 },
	pageWidth: { min: 35, max: 100, step: 1 },
} as const;
export const DEFAULT_READING_SETTINGS: ReadingSettings = {
	fontScale: 1,
	lineHeight: 1.2,
	wordSpacing: 0,
	characterSpacing: 0,
	pageWidth: 75,
	split: "single",
	theme: "original",
	foreground: "#202124",
	background: "#ffffff",
};
export function normalizeReadingSettings(value: unknown): ReadingSettings {
	const input =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const next = { ...DEFAULT_READING_SETTINGS };
	for (const key of [
		"fontScale",
		"lineHeight",
		"wordSpacing",
		"characterSpacing",
		"pageWidth",
	] as const) {
		const n = input[key],
			{ min, max, step } = READING_LIMITS[key];
		if (typeof n === "number" && Number.isFinite(n))
			next[key] = Number(
				(Math.round(Math.max(min, Math.min(max, n)) / step) * step).toFixed(2),
			);
	}
	if (
		input.split === "single" ||
		input.split === "side-by-side" ||
		input.split === "top-bottom"
	)
		next.split = input.split;
	if (READING_THEMES.some((theme) => theme === input.theme))
		next.theme = input.theme as ReadingTheme;
	for (const key of ["foreground", "background"] as const) {
		if (typeof input[key] === "string" && /^#[0-9a-f]{6}$/i.test(input[key]))
			next[key] = input[key];
	}
	return next;
}
export function readReadingSettings(): ReadingSettings {
	return normalizeReadingSettings(readJsonStorage<unknown>(STORAGE_KEY, null));
}
export function writeReadingSettings(settings: ReadingSettings): void {
	writeJsonStorage(STORAGE_KEY, settings);
	if (typeof window !== "undefined")
		window.dispatchEvent(
			new CustomEvent(READING_SETTINGS_EVENT, { detail: settings }),
		);
}
export function readingColors(settings: ReadingSettings): {
	color: string;
	backgroundColor: string;
} {
	switch (settings.theme) {
		case "dark":
			return { color: "#d4d4d4", backgroundColor: "#252525" };
		case "black":
			return { color: "#dedede", backgroundColor: "#000000" };
		case "snow":
			return { color: "#253045", backgroundColor: "#f0f5fc" };
		case "sepia":
			return { color: "#4b3b28", backgroundColor: "#f4ecd8" };
		case "custom":
			return {
				color: settings.foreground,
				backgroundColor: settings.background,
			};
		default:
			return { color: "#202124", backgroundColor: "#ffffff" };
	}
}
