/**
 * Convert composer file attachments (data URLs from PromptInput) into ACP
 * PromptImage payloads (raw base64 + mime).
 *
 * Desktop attach button uses Tauri native dialog filters (hard type restrict).
 * HTML `accept` remains for paste/drop validation and non-Tauri fallback.
 */
import type { FileUIPart } from "ai";

import type { PromptImage } from "@/lib/agent/api";
import { fileMatchesAccept, hasImageExtension } from "@/lib/core/file-accept";
import { basenameOf } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { pathsFromDataTransfer } from "@/lib/shell/external-file-drop";
import { imageMimeFromPath } from "@/lib/workspace/viewer";

/** Extensions for Tauri `dialog.open` filters (no leading dots). */
export const COMPOSER_IMAGE_EXTENSIONS = [
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"bmp",
	"heic",
	"heif",
	"avif",
	"svg",
	"ico",
] as const;

/**
 * HTML file-input `accept` (MIME + extensions). Weaker than native dialog
 * filters; used for drop/paste validation and browser fallback.
 */
export const COMPOSER_IMAGE_ACCEPT = [
	"image/*",
	...COMPOSER_IMAGE_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

export const COMPOSER_IMAGE_MAX_FILES = 8;
/** 10 MiB per image — large enough for screenshots, small enough for ACP. */
export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Desktop: open a native image-only file dialog (extension filters so PDF etc.
 * are not selectable), read bytes, return browser `File` objects for PromptInput.
 * Returns `null` when not running under Tauri (caller may fall back to `<input>`).
 * Returns `[]` when the user cancels.
 */
export async function pickComposerImageFiles(opts?: {
	/** How many more images may be attached (capacity remaining). */
	remainingSlots?: number;
	/** Dialog window title. */
	title?: string;
	/** Filter group label shown in the native dialog. */
	filterName?: string;
}): Promise<File[] | null> {
	if (!isTauri()) return null;

	const remaining =
		typeof opts?.remainingSlots === "number"
			? Math.max(0, opts.remainingSlots)
			: COMPOSER_IMAGE_MAX_FILES;
	if (remaining <= 0) return [];

	const { open } = await import("@tauri-apps/plugin-dialog");
	const selected = await open({
		multiple: true,
		title: opts?.title,
		filters: [
			{
				name: opts?.filterName || "Images",
				extensions: [...COMPOSER_IMAGE_EXTENSIONS],
			},
		],
	});
	if (selected === null) return [];
	const paths = (Array.isArray(selected) ? selected : [selected]).filter(
		Boolean,
	);
	return readComposerImageFiles(paths, remaining);
}

/** Absolute image paths in a drop payload (Finder / Preview often omit FileList). */
export function imagePathsFromDataTransfer(
	dt: DataTransfer | null | undefined,
): string[] {
	if (!dt) return [];
	return pathsFromDataTransfer(dt).filter((path) => hasImageExtension(path));
}

/**
 * Read local image paths into browser `File` objects (Tauri only).
 * Used when a macOS drop exposes `text/plain` / `text/uri-list` paths but
 * no `FileList` (common WKWebView case).
 */
export async function readComposerImageFiles(
	paths: string[],
	remainingSlots: number = COMPOSER_IMAGE_MAX_FILES,
): Promise<File[]> {
	if (!isTauri()) return [];
	const remaining = Math.max(0, remainingSlots);
	if (remaining <= 0) return [];

	const { readFile } = await import("@tauri-apps/plugin-fs");
	const capped = paths
		.filter((path) => hasImageExtension(path))
		.slice(0, remaining);
	const files: File[] = [];
	const errors: string[] = [];
	for (const path of capped) {
		try {
			const bytes = await readFile(path);
			const name = basenameOf(path) || "image.png";
			const mime = imageMimeFromPath(path);
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			files.push(
				new File([copy], name, {
					type: mime.startsWith("image/") ? mime : "image/png",
					lastModified: Date.now(),
				}),
			);
		} catch (error) {
			errors.push(
				`${basenameOf(path) || path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (!files.length && errors.length) {
		throw new Error(errors[0]);
	}
	return files;
}

const DATA_URL_RE = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i;

/** True when a File looks like an image (MIME and/or extension). */
export function isImageFile(file: File): boolean {
	return fileMatchesAccept(file, "image/*");
}

/** Parse a data URL into ACP PromptImage (raw base64, no data: prefix). */
export function dataUrlToPromptImage(
	url: string,
	mimeHint?: string,
): PromptImage | null {
	const trimmed = url.trim();
	const match = trimmed.match(DATA_URL_RE);
	if (!match) return null;
	const mime = (match[1] || mimeHint || "image/png").trim().toLowerCase();
	const data = match[2]?.trim();
	if (!data || !mime.startsWith("image/")) return null;
	return { data, mimeType: mime };
}

/** Keep only image FileUIParts that already carry data URLs (post-submit conversion). */
export function fileUiPartsToPromptImages(
	files: readonly FileUIPart[] | undefined | null,
): PromptImage[] {
	if (!files?.length) return [];
	const out: PromptImage[] = [];
	for (const file of files) {
		const mediaType = (file.mediaType || "").trim().toLowerCase();
		if (mediaType && !mediaType.startsWith("image/")) continue;
		const url = file.url?.trim();
		if (!url) continue;
		const image = dataUrlToPromptImage(url, mediaType || undefined);
		if (image) out.push(image);
	}
	return out;
}
