/**
 * Markdown image insertion: binary files live next to the note under `./assets/`,
 * and the document stores portable relative links (`![alt](./assets/name.ext)`).
 */

import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { isTauri } from "@/lib/core/tauri";
import { writeVaultBytes } from "@/lib/vault";
import { imageMimeFromPath } from "@/lib/workspace/viewer";

/** Relative link prefix written into Markdown (Obsidian-friendly). */
const MARKDOWN_ASSETS_DIR = "assets";
const MARKDOWN_ASSETS_REL = `./${MARKDOWN_ASSETS_DIR}`;
/** Derived from the constant above so renaming the folder cannot miss a spot. */
const MANAGED_ASSET_URL_RE = new RegExp(
	`^(?:\\./)?${MARKDOWN_ASSETS_DIR}/`,
	"i",
);

const DATA_URL_RE = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i;

const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
};

/** True when the image src is remote / inline and needs no vault resolution. */
export function isRemoteOrInlineImageUrl(url: string): boolean {
	return /^(https?|data|blob):/i.test(url.trim());
}

/**
 * True when the Markdown image points at this note's managed `assets/` folder
 * (not remote URLs or arbitrary relative paths outside `assets/`).
 */
export function isManagedMarkdownAssetUrl(url: string): boolean {
	return MANAGED_ASSET_URL_RE.test(url.trim().replace(/\\/g, "/"));
}

/** Serialize an image node as portable Markdown syntax. */
export function formatMarkdownImageSyntax(alt: string, url: string): string {
	return `![${alt ?? ""}](${url ?? ""})`;
}

type WalkNode = {
	type?: string;
	url?: string;
	children?: WalkNode[];
};

/** Count image `url` values in a Plate/Slate node tree. */
export function collectImageUrlCounts(
	nodes: readonly unknown[],
): Map<string, number> {
	const counts = new Map<string, number>();
	const walk = (list: readonly unknown[]) => {
		for (const raw of list) {
			if (!raw || typeof raw !== "object") continue;
			const n = raw as WalkNode;
			if (n.type === "img" && typeof n.url === "string") {
				const url = n.url.trim();
				if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
			}
			if (Array.isArray(n.children)) walk(n.children);
		}
	};
	walk(nodes);
	return counts;
}

/**
 * Delete a managed `./assets/…` file for this Markdown document.
 * Returns true when a file was removed. Never deletes outside `{mdDir}/assets/`.
 */
export async function deleteManagedMarkdownAsset(
	mdFilePath: string,
	url: string,
): Promise<boolean> {
	if (!isTauri() || !mdFilePath?.trim() || !isManagedMarkdownAssetUrl(url)) {
		return false;
	}
	const abs = resolveMarkdownImageAbs(mdFilePath, url);
	if (!abs) return false;

	const assetsDir = joinFilePath(parentDir(mdFilePath), MARKDOWN_ASSETS_DIR);
	const normAbs = abs.replace(/\\/g, "/").toLowerCase();
	const normAssets = assetsDir.replace(/\\/g, "/").toLowerCase();
	// Stay strictly inside this note's assets folder
	if (normAbs !== normAssets && !normAbs.startsWith(`${normAssets}/`)) {
		return false;
	}
	// Refuse directory deletes
	if (normAbs === normAssets) return false;

	try {
		const { exists, remove } = await import("@tauri-apps/plugin-fs");
		if (!(await exists(abs))) return false;
		await remove(abs);
		return true;
	} catch {
		return false;
	}
}

/**
 * Grace period before deleting a managed asset after its last document ref
 * disappears. Cut → paste / undo must still find the file on disk.
 */
const ASSET_GC_DEBOUNCE_MS = 15_000;

function assetGcKey(mdFilePath: string, url: string): string {
	return `${mdFilePath}\0${url}`;
}

/**
 * Debounced GC for managed `./assets/` files.
 *
 * Immediate delete on cut made copy/cut/paste of images lose the bitmap:
 * the node path returned on paste, but the file was already removed.
 * Schedule deletions; cancel if the URL is referenced again before the timer.
 */
export function createManagedAssetGc(options?: {
	debounceMs?: number;
	/** Called after one or more files are actually removed. */
	onDeleted?: (removed: number) => void;
	/** Injectable for tests. */
	deleteAsset?: (mdFilePath: string, url: string) => Promise<boolean>;
	now?: () => number;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
}) {
	const debounceMs = options?.debounceMs ?? ASSET_GC_DEBOUNCE_MS;
	const deleteAsset = options?.deleteAsset ?? deleteManagedMarkdownAsset;
	const setTimer = options?.setTimer ?? setTimeout;
	const clearTimer = options?.clearTimer ?? clearTimeout;

	const pending = new Map<
		string,
		{ mdFilePath: string; url: string; timer: ReturnType<typeof setTimeout> }
	>();

	const cancel = (mdFilePath: string, url: string) => {
		const key = assetGcKey(mdFilePath, url);
		const entry = pending.get(key);
		if (!entry) return;
		clearTimer(entry.timer);
		pending.delete(key);
	};

	const schedule = (mdFilePath: string, url: string) => {
		if (!isManagedMarkdownAssetUrl(url)) return;
		const key = assetGcKey(mdFilePath, url);
		const existing = pending.get(key);
		if (existing) {
			clearTimer(existing.timer);
		}
		const timer = setTimer(() => {
			pending.delete(key);
			void deleteAsset(mdFilePath, url).then((ok) => {
				if (ok) options?.onDeleted?.(1);
			});
		}, debounceMs);
		pending.set(key, { mdFilePath, url, timer });
	};

	return {
		/** Apply ref-count delta: schedule GC for dropped URLs, cancel for revived. */
		observe(
			mdFilePath: string,
			prev: Map<string, number>,
			next: Map<string, number>,
		) {
			if (!mdFilePath) return;
			for (const [url, nextCount] of next) {
				if (nextCount > 0) cancel(mdFilePath, url);
			}
			for (const [url, prevCount] of prev) {
				if (prevCount <= 0) continue;
				const nextCount = next.get(url) ?? 0;
				if (nextCount > 0) continue;
				schedule(mdFilePath, url);
			}
		},

		/** Pending scheduled URLs (tests / debug). */
		pendingUrls(): string[] {
			return [...pending.values()].map((e) => e.url);
		},

		/** Cancel all timers without deleting (e.g. tests). */
		cancelAll() {
			for (const entry of pending.values()) clearTimer(entry.timer);
			pending.clear();
		},

		/**
		 * Run all pending deletes now (editor unmount: cut without paste still
		 * should free disk eventually when leaving the file).
		 */
		async flush(): Promise<number> {
			const entries = [...pending.values()];
			pending.clear();
			for (const e of entries) clearTimer(e.timer);
			let removed = 0;
			for (const e of entries) {
				if (await deleteAsset(e.mdFilePath, e.url)) removed += 1;
			}
			if (removed > 0) options?.onDeleted?.(removed);
			return removed;
		},
	};
}

/** Parent directory of a file path (preserves path separator style). */
export function parentDir(filePath: string): string {
	const trimmed = filePath.replace(/[/\\]+$/, "");
	const fwd = trimmed.lastIndexOf("/");
	const back = trimmed.lastIndexOf("\\");
	const i = Math.max(fwd, back);
	if (i < 0) return "";
	return trimmed.slice(0, i);
}

function pathSep(p: string): string {
	return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

/** Join parent + name with the parent's path separator style. */
export function joinFilePath(parent: string, name: string): string {
	if (!parent) return name;
	const sep = pathSep(parent);
	const base = parent.replace(/[/\\]+$/, "");
	return `${base}${sep}${name}`;
}

/**
 * Resolve a Markdown image `url` (relative to the `.md` file) to an absolute path.
 * Returns null for remote/inline URLs or empty input.
 */
export function resolveMarkdownImageAbs(
	mdFilePath: string,
	url: string,
): string | null {
	const raw = url?.trim();
	if (!raw || isRemoteOrInlineImageUrl(raw)) return null;
	if (!mdFilePath?.trim()) return null;

	// Absolute filesystem path (not a relative Markdown link)
	if (/^([A-Za-z]:[\\/]|\/)/.test(raw) && !raw.startsWith("./")) {
		return raw;
	}

	let rel = raw.replace(/\\/g, "/");
	if (rel.startsWith("./")) rel = rel.slice(2);
	while (rel.startsWith("/")) rel = rel.slice(1);
	if (!rel || rel.split("/").includes("..")) return null;

	const dir = parentDir(mdFilePath);
	const parts = rel.split("/").filter(Boolean);
	let abs = dir;
	for (const part of parts) {
		abs = abs ? joinFilePath(abs, part) : part;
	}
	return abs || null;
}

/** Sanitize a single file name segment (no path traversal). */
export function sanitizeAssetFileName(name: string): string {
	const base = name.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
	const cleaned = base
		.replace(/[^\w.\-()+[\] ]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 180);
	return cleaned || "image";
}

function extFromMime(mime: string): string {
	const key = mime.trim().toLowerCase();
	return MIME_EXT[key] ?? "png";
}

function ensureExtension(fileName: string, ext: string): string {
	if (/\.[a-z0-9]+$/i.test(fileName)) return fileName;
	return `${fileName}.${ext}`;
}

function stampForFileName(): string {
	// filesystem-safe local-ish stamp
	return new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.slice(0, 19);
}

export type ParsedImagePayload = {
	bytes: Uint8Array;
	mime: string;
	ext: string;
};

/** Parse Plate `uploadImage` input (data URL string or raw buffer). */
export function parseImagePayload(
	data: ArrayBuffer | string,
): ParsedImagePayload {
	if (typeof data === "string") {
		const m = data.trim().match(DATA_URL_RE);
		if (!m) {
			throw new Error(i18n.t("editor:image.invalidPayload"));
		}
		const mime = (m[1] || "image/png").trim().toLowerCase();
		const b64 = m[2];
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return { bytes, mime, ext: extFromMime(mime) };
	}
	const bytes = new Uint8Array(data);
	return { bytes, mime: "image/png", ext: "png" };
}

async function ensureUniqueName(
	assetsDir: string,
	preferred: string,
): Promise<string> {
	const { exists } = await import("@tauri-apps/plugin-fs");
	const name = preferred;
	const abs0 = joinFilePath(assetsDir, name);
	if (!(await exists(abs0))) return name;

	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let n = 1; n < 1000; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!(await exists(joinFilePath(assetsDir, candidate)))) return candidate;
	}
	return `${stem}-${nanoid(6)}${ext}`;
}

/**
 * Write image bytes next to the Markdown file under `assets/`.
 * Returns the portable relative Markdown path (`./assets/…`).
 */
export async function saveBytesToMarkdownAssets(
	mdFilePath: string,
	bytes: Uint8Array,
	opts?: { preferredName?: string; ext?: string },
): Promise<string> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	if (!mdFilePath?.trim()) {
		throw new Error(i18n.t("editor:image.noFile"));
	}

	const ext = (opts?.ext ?? "png").replace(/^\./, "").toLowerCase() || "png";
	const preferred = ensureExtension(
		sanitizeAssetFileName(
			opts?.preferredName?.trim() || `image-${stampForFileName()}-${nanoid(6)}`,
		),
		ext,
	);

	const dir = parentDir(mdFilePath);
	const assetsDir = joinFilePath(dir, MARKDOWN_ASSETS_DIR);
	const { mkdir } = await import("@tauri-apps/plugin-fs");
	await mkdir(assetsDir, { recursive: true });

	const fileName = await ensureUniqueName(assetsDir, preferred);
	const abs = joinFilePath(assetsDir, fileName);
	await writeVaultBytes(abs, bytes);
	return `${MARKDOWN_ASSETS_REL}/${fileName}`;
}

/**
 * Plate `uploadImage` handler: data URL / buffer → `./assets/…` on disk.
 */
export async function saveImageToMarkdownAssets(
	mdFilePath: string,
	data: ArrayBuffer | string,
	preferredName?: string,
): Promise<string> {
	const { bytes, ext } = parseImagePayload(data);
	return saveBytesToMarkdownAssets(mdFilePath, bytes, {
		preferredName,
		ext,
	});
}

/**
 * Copy an existing local image file into the Markdown file's `./assets/`.
 * Returns the relative Markdown path.
 */
export async function copyFileToMarkdownAssets(
	mdFilePath: string,
	sourceAbsPath: string,
): Promise<string> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	const { readFile } = await import("@tauri-apps/plugin-fs");
	const bytes = await readFile(sourceAbsPath);
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);

	const base =
		sourceAbsPath.replace(/\\/g, "/").split("/").pop() || "image.png";
	const mime = imageMimeFromPath(base);
	const ext =
		base.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? extFromMime(mime);

	return saveBytesToMarkdownAssets(mdFilePath, copy, {
		preferredName: base,
		ext,
	});
}

/** Open a multi-select image dialog; returns absolute paths or empty. */
export async function pickImageFiles(): Promise<string[]> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	const { open } = await import("@tauri-apps/plugin-dialog");
	const selected = await open({
		multiple: true,
		title: i18n.t("editor:image.pickTitle"),
		filters: [
			{
				name: i18n.t("editor:image.pickFilter"),
				extensions: [
					"png",
					"jpg",
					"jpeg",
					"gif",
					"webp",
					"bmp",
					"svg",
					"avif",
					"ico",
				],
			},
		],
	});
	if (!selected) return [];
	return Array.isArray(selected) ? selected : [selected];
}
