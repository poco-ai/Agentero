/**
 * HTML `accept` attribute matching for File inputs and drag/drop.
 * Supports MIME types, `type/*` wildcards, and `.ext` extensions.
 */

import {
	isVaultFileDragActive,
	VAULT_FILE_DRAG_TYPE,
} from "@/lib/shell/vault-file-drag";

const IMAGE_EXT_RE =
	/\.(png|jpe?g|webp|gif|bmp|heic|heif|avif|svg|ico|tif|tiff)$/i;

/**
 * macOS WKWebView sometimes reports Uniform Type Identifiers instead of MIME
 * (`public.png`, `public.image`, …). Treat those as image types.
 */
const IMAGE_UTI_RE =
	/^(public\.(png|jpe?g|jpeg-2000|tiff|heic|heif|gif|svg-image|image|camera-raw-image)|com\.compuserve\.gif|org\.webmproject\.webp|com\.microsoft\.(bmp|ico))$/i;

const PDF_EXT_RE = /\.pdf$/i;

/**
 * macOS WKWebView may report Adobe / public PDF UTIs instead of MIME.
 */
const PDF_UTI_RE = /^(com\.adobe\.pdf|public\.pdf)$/i;

/** True when the basename has a known image extension. */
export function hasImageExtension(name: string): boolean {
	return IMAGE_EXT_RE.test(name.trim());
}

/** True when the basename (or path) ends with `.pdf`. */
export function hasPdfExtension(name: string): boolean {
	return PDF_EXT_RE.test(name.trim());
}

/** True for `image/*` MIME types or macOS image UTIs. */
export function isImageMimeOrUti(type: string | undefined | null): boolean {
	const trimmed = (type || "").trim().toLowerCase();
	if (!trimmed) return false;
	return trimmed.startsWith("image/") || IMAGE_UTI_RE.test(trimmed);
}

/** True for `application/pdf` or macOS PDF UTIs. */
export function isPdfMimeOrUti(type: string | undefined | null): boolean {
	const trimmed = (type || "").trim().toLowerCase();
	if (!trimmed) return false;
	return trimmed === "application/pdf" || PDF_UTI_RE.test(trimmed);
}

/**
 * Match a File against an HTML `accept` attribute value (comma-separated
 * MIME types, `type/*` wildcards, and/or `.ext` extensions).
 */
export function fileMatchesAccept(
	file: File,
	accept: string | undefined,
): boolean {
	if (!accept?.trim()) return true;
	const patterns = accept
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (patterns.length === 0) return true;

	const type = (file.type || "").trim().toLowerCase();
	const name = (file.name || "").trim().toLowerCase();
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot) : "";

	return patterns.some((pattern) => {
		if (pattern.startsWith(".")) {
			return ext === pattern;
		}
		if (pattern.endsWith("/*")) {
			const prefix = pattern.slice(0, -1); // e.g. "image/"
			if (type.startsWith(prefix)) return true;
			if (prefix === "image/" && isImageMimeOrUti(type)) return true;
			// Empty MIME + image/* → allow known image extensions
			if (!type && prefix === "image/" && IMAGE_EXT_RE.test(name)) return true;
			return false;
		}
		if (type && type === pattern) return true;
		if (pattern.startsWith("image/") && isImageMimeOrUti(type)) return true;
		// MIME listed but File.type empty: map common image types via extension
		if (!type && pattern.startsWith("image/") && IMAGE_EXT_RE.test(name)) {
			return true;
		}
		return false;
	});
}

function basenameFromPathOrUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	let path = trimmed;
	if (/^file:/i.test(path)) {
		try {
			path = decodeURIComponent(new URL(path).pathname);
		} catch {
			path = path.replace(/^file:\/\//i, "");
		}
	}
	const parts = path.replace(/\\/g, "/").split("/");
	return parts.at(-1) || "";
}

/** Safe copy of `dataTransfer.types` (DOMStringList has no `.includes` on some WebKits). */
export function dataTransferTypes(
	dt: DataTransfer | null | undefined,
): string[] {
	if (!dt?.types) return [];
	try {
		return [...dt.types];
	} catch {
		const list = dt.types as unknown as {
			length: number;
			item?: (index: number) => string | null;
			[index: number]: string | undefined;
		};
		const out: string[] = [];
		for (let i = 0; i < (list.length ?? 0); i++) {
			const item = typeof list.item === "function" ? list.item(i) : list[i];
			if (item) out.push(item);
		}
		return out;
	}
}

const OS_FILE_TYPES = new Set([
	"Files",
	"application/x-moz-file",
	"text/uri-list",
	"public.file-url",
	"public.file-url-name",
]);

/** True when the payload looks like an OS file drag (not in-app text/plain). */
export function dataTransferLooksLikeOsFiles(
	dt: DataTransfer | null | undefined,
): boolean {
	if (!dt) return false;
	if (dataTransferTypes(dt).some((type) => OS_FILE_TYPES.has(type))) {
		return true;
	}
	try {
		const items = dt.items;
		if (items?.length) {
			for (let i = 0; i < items.length; i++) {
				if (items[i]?.kind === "file") return true;
			}
		}
	} catch {
		// ignore
	}
	return false;
}

/** Collect best-effort file names available during drag (before drop). */
export function fileNamesFromDataTransfer(
	dt: DataTransfer | null | undefined,
): string[] {
	if (!dt) return [];
	const names: string[] = [];
	const push = (name: string) => {
		const n = name.trim();
		if (n) names.push(n);
	};

	try {
		for (const file of filesFromDataTransfer(dt)) {
			if (file.name) push(file.name);
		}
	} catch {
		// ignore
	}

	// Some desktop webviews expose paths mid-drag (others only on drop).
	for (const type of ["text/uri-list", "text/plain"] as const) {
		try {
			if (![...dt.types].includes(type)) continue;
			const text = dt.getData(type);
			if (!text) continue;
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				// Prefer path-like lines; skip prose.
				if (
					!trimmed.includes("/") &&
					!trimmed.includes("\\") &&
					!/^file:/i.test(trimmed)
				) {
					continue;
				}
				const base = basenameFromPathOrUrl(trimmed);
				if (base) push(base);
			}
		} catch {
			// getData may throw mid-drag on some platforms
		}
	}

	return names;
}

/**
 * Collect `File` objects from a drop. Some WebViews populate `items` but leave
 * `files` empty (or the reverse); take both and dedupe.
 */
export function filesFromDataTransfer(
	dt: DataTransfer | null | undefined,
): File[] {
	if (!dt) return [];
	const out: File[] = [];
	const seen = new Set<string>();
	const push = (file: File | null | undefined) => {
		if (!file) return;
		const key = `${file.name}\0${file.size}\0${file.lastModified}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(file);
	};

	try {
		const items = dt.items;
		if (items?.length) {
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item?.kind === "file") push(item.getAsFile?.() ?? null);
			}
		}
	} catch {
		// ignore
	}

	try {
		const list = dt.files;
		if (list?.length) {
			for (let i = 0; i < list.length; i++) {
				const file = typeof list.item === "function" ? list.item(i) : list[i];
				push(file ?? null);
			}
		}
	} catch {
		// ignore
	}

	return out;
}

/** True for an in-app vault path drag (tree move or composer @ chip). */
export function dataTransferLooksLikeVaultMove(
	dt: DataTransfer | null | undefined,
): boolean {
	if (isVaultFileDragActive()) return true;
	if (!dt) return false;
	return dataTransferTypes(dt).includes(VAULT_FILE_DRAG_TYPE);
}

/**
 * Best-effort check while a drag is in progress (before drop).
 *
 * In-app file-tree moves are never images. When MIME/names prove non-image
 * (PDF, .md, …) return false so the composer does not flash the overlay.
 * When everything is unknown (empty MIME + no names — common on macOS
 * Finder / Preview image drags during `dragover`), return true.
 */
export function dataTransferLooksLikeImages(
	dt: DataTransfer | null | undefined,
): boolean {
	if (dataTransferLooksLikeVaultMove(dt)) return false;
	if (!dt || !dataTransferLooksLikeOsFiles(dt)) return false;

	let sawImage = false;
	let sawNonImage = false;

	const items = dt.items;
	if (items?.length) {
		for (const item of items) {
			if (item.kind !== "file") continue;
			const type = (item.type || "").trim().toLowerCase();
			if (!type) continue;
			if (isImageMimeOrUti(type)) {
				sawImage = true;
			} else {
				sawNonImage = true;
			}
		}
	}

	const names = fileNamesFromDataTransfer(dt);
	for (const name of names) {
		if (hasImageExtension(name)) {
			sawImage = true;
		} else if (/\.[a-z0-9]+$/i.test(name)) {
			// Has a non-image extension (.md, .pdf, .txt, …)
			sawNonImage = true;
		}
	}

	if (sawImage) return true;
	if (sawNonImage) return false;
	// Unknown payload (no MIME, no names) — typical macOS window image drag.
	return true;
}

/**
 * Best-effort check while a PDF drag is in progress (before drop).
 *
 * Unlike images, unknown empty MIME/names return **false**: Library must not
 * flash a "drop PDF" overlay when the user is dragging a Finder image (or
 * other non-PDF). Proven PDFs come from MIME, `.pdf` names, or drop paths.
 */
export function dataTransferLooksLikePdfs(
	dt: DataTransfer | null | undefined,
): boolean {
	if (dataTransferLooksLikeVaultMove(dt)) return false;
	if (!dt || !dataTransferLooksLikeOsFiles(dt)) return false;

	let sawPdf = false;
	let sawNonPdf = false;

	const items = dt.items;
	if (items?.length) {
		for (const item of items) {
			if (item.kind !== "file") continue;
			const type = (item.type || "").trim().toLowerCase();
			if (!type) continue;
			if (isPdfMimeOrUti(type)) {
				sawPdf = true;
			} else {
				sawNonPdf = true;
			}
		}
	}

	const names = fileNamesFromDataTransfer(dt);
	for (const name of names) {
		if (hasPdfExtension(name)) {
			sawPdf = true;
		} else if (/\.[a-z0-9]+$/i.test(name)) {
			sawNonPdf = true;
		}
	}

	if (sawPdf) return true;
	if (sawNonPdf) return false;
	return false;
}
