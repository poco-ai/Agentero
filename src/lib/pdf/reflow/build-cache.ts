/**
 * Persistent cache for finished reflow outputs.
 *
 * Page builds and the document-level build repeat the same expensive work on
 * every restart: PDFium text redaction, full CJK font embedding, and pdf-lib
 * serialization. The bytes depend only on the source geometry IR, the exact
 * translations, the font bytes, and the reflow schema — so they are stored
 * under the app cache directory and reused verbatim. Translations already live
 * in the `layout-translate.json` sidecar; this cache stores build output, not
 * translation state.
 *
 * Every file is named by a SHA-256 content key and re-read through
 * `pdf-lib.load`, which validates PDF structure. A truncated or corrupt file
 * simply fails the load and the caller rebuilds.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { gunzipBytes, gzipBytes, pdfSha256, sha256Bytes } from "./cache-utils";
import type { ReflowFontBytes } from "./fonts";
import type { ReflowDocument } from "./types";

const CACHE_DIR = "reflow-build";
/** Font content pins the parser version too: new font bytes invalidate entries. */
const FONT_ASSET_REVISION = "1eeeec2a63b05fe6fe7a1f45f0955a8fa98793c4";
const REFLOW_BUILD_CACHE_VERSION = 1;
/**
 * Bump when layout/export produce different PDFs for the same IR + translations
 * + fonts (the built bytes are reused verbatim, so layout.ts or export.ts
 * changes must invalidate old entries even when the IR schema is unchanged).
 */
const REFLOW_BUILD_PIPELINE_VERSION = 1;

export type ReflowBuildCacheSource = {
	/** Stable paper identifier, usually the vault-relative paper folder. */
	paperKey: string | null | undefined;
	/** Viewer bytes; keyed by content so a changed PDF never reuses old builds. */
	pdfBytes: ArrayBuffer | Uint8Array | null | undefined;
};

/** Cache operations for finished reflow builds; fakes are used by tests. */
export type ReflowBuildCacheStore = {
	readPage(
		document: ReflowDocument,
		pageIndex: number,
		translations: ReadonlyMap<string, string>,
		fonts: ReflowFontBytes,
	): Promise<Uint8Array | null>;
	writePage(
		document: ReflowDocument,
		pageIndex: number,
		translations: ReadonlyMap<string, string>,
		fonts: ReflowFontBytes,
		bytes: Uint8Array,
	): Promise<void>;
	readFinal(
		document: ReflowDocument,
		translations: ReadonlyMap<string, string>,
		fonts: ReflowFontBytes,
	): Promise<Uint8Array | null>;
	writeFinal(
		document: ReflowDocument,
		translations: ReadonlyMap<string, string>,
		fonts: ReflowFontBytes,
		bytes: Uint8Array,
	): Promise<void>;
};

type BuildBase = { dir: string; pdfSha256: string };

function fontFingerprint(fonts: ReflowFontBytes): Promise<string> {
	const keys = Object.keys(fonts).sort() as (keyof ReflowFontBytes)[];
	return sha256Bytes(
		new TextEncoder().encode(
			`${FONT_ASSET_REVISION}:${keys.map((key) => fonts[key].byteLength).join(",")}`,
		),
	);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, val) =>
		val instanceof Uint8Array ? undefined : val,
	);
}

function translationsFingerprint(
	entries: readonly [string, string][],
): Promise<string> {
	const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
	return sha256Bytes(new TextEncoder().encode(stableJson(sorted)));
}

async function documentFingerprint(
	document: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fonts?: ReflowFontBytes,
): Promise<string> {
	const parts = [
		REFLOW_BUILD_CACHE_VERSION,
		REFLOW_BUILD_PIPELINE_VERSION,
		document.version,
		stableJson(document.pages),
		await translationsFingerprint([...translations]),
	];
	if (fonts) parts.push(await fontFingerprint(fonts));
	return sha256Bytes(new TextEncoder().encode(parts.join("\n")));
}

async function resolveBase(
	source: ReflowBuildCacheSource,
): Promise<BuildBase | null> {
	if (!isTauri() || !source.pdfBytes) return null;
	try {
		return {
			dir: await join(await appCacheDir(), CACHE_DIR),
			pdfSha256: await pdfSha256(source.pdfBytes),
		};
	} catch (error) {
		logger.warn("pdf.reflow.buildCache key failed", {
			error: errorText(error),
		});
		return null;
	}
}

async function readCacheEntry(path: string): Promise<Uint8Array | null> {
	try {
		return gunzipBytes(await readFile(path));
	} catch {
		// Missing cache is a normal miss.
		return null;
	}
}

/** Best-effort write; cache failures never break a running translation. */
async function writeCacheEntry(path: string, bytes: Uint8Array): Promise<void> {
	try {
		await mkdir(path.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
		await writeFile(path, await gzipBytes(bytes));
	} catch (error) {
		logger.warn("pdf.reflow.buildCache write failed", {
			error: errorText(error),
		});
	}
}

/**
 * Build the real cache store. Key material is computed lazily so a session
 * without a local paper PDF never touches disk.
 */
export function createReflowBuildCache(
	source: ReflowBuildCacheSource,
): ReflowBuildCacheStore {
	let base: Promise<BuildBase | null> | undefined;
	const baseIdentity = () => (base ??= resolveBase(source).catch(() => null));

	const entryPath = async (fingerprint: string): Promise<string | null> => {
		const cacheBase = await baseIdentity();
		if (!cacheBase) return null;
		return join(
			cacheBase.dir,
			`${cacheBase.pdfSha256.slice(0, 16)}-${fingerprint.slice(0, 32)}.pdf`,
		);
	};

	return {
		async readPage(document, page, translations, fonts) {
			const fingerprint = await documentFingerprint(
				document,
				translations,
				fonts,
			);
			const path = await entryPath(
				`p${String(page).padStart(4, "0")}-${fingerprint}`,
			);
			if (!path) return null;
			return readCacheEntry(path);
		},
		async writePage(document, page, translations, fonts, bytes) {
			const fingerprint = await documentFingerprint(
				document,
				translations,
				fonts,
			);
			const path = await entryPath(
				`p${String(page).padStart(4, "0")}-${fingerprint}`,
			);
			if (!path) return;
			await writeCacheEntry(path, bytes);
		},
		async readFinal(document, translations, fonts) {
			const fingerprint = await documentFingerprint(
				document,
				translations,
				fonts,
			);
			const path = await entryPath(`final-${fingerprint}`);
			if (!path) return null;
			return readCacheEntry(path);
		},
		async writeFinal(document, translations, fonts, bytes) {
			const fingerprint = await documentFingerprint(
				document,
				translations,
				fonts,
			);
			const path = await entryPath(`final-${fingerprint}`);
			if (!path) return;
			await writeCacheEntry(path, bytes);
		},
	};
}
