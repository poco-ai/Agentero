/**
 * Persistent cache for the finished translated document.
 *
 * The document-level build repeats the same expensive work on every restart:
 * PDFium text redaction, formula fragment extraction, full CJK font embedding
 * (each embedded copy is ~20 MB), and pdf-lib serialization. The bytes depend
 * only on the source geometry IR, the exact translations, the font bytes, and
 * the reflow schema — so the finished PDF is stored under the app cache
 * directory and reused verbatim. Per-page preview builds are deliberately NOT
 * cached: each embeds the full CJK font pair, so caching them would cost
 * ~20 MB per page for a marginal win over the single final entry.
 *
 * The file is named by a SHA-256 content key and re-read through
 * `pdf-lib.load`, which validates PDF structure. A truncated or corrupt file
 * simply fails the load and the caller rebuilds.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import {
	mkdir,
	readDir,
	readFile,
	remove,
	stat,
	writeFile,
} from "@tauri-apps/plugin-fs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { gunzipBytes, pdfSha256, sha256Bytes } from "./cache-utils";
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
/**
 * Translation state churns with every page-level hide/restore, so one paper
 * can legitimately produce several distinct finals in a row. Keep the newest
 * few and drop the rest; page previews from the old per-page cache era are
 * always swept.
 */
const FINAL_KEEP_COUNT = 2;

export type ReflowBuildCacheSource = {
	/** Stable paper identifier, usually the vault-relative paper folder. */
	paperKey: string | null | undefined;
	/** Viewer bytes; keyed by content so a changed PDF never reuses old builds. */
	pdfBytes: ArrayBuffer | Uint8Array | null | undefined;
};

/** Cache operations for the finished reflow document; fakes are used by tests. */
export type ReflowBuildCacheStore = {
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

function sortedById<T extends { id: string }>(values: readonly T[]): T[] {
	return [...values].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Canonical view of the document for keying: paragraph order can jitter
 * between runs (page-level runs re-merge items, and equal-key ties resolve to
 * insertion order), which changes the PDF's draw order by a fragment without
 * changing any visible content. Sort everything addressable by id so such
 * jitter still hits the same cache entry.
 */
function canonicalDocument(document: ReflowDocument): unknown {
	return {
		version: document.version,
		pages: [...document.pages]
			.sort((a, b) => a.index - b.index)
			.map((page) => ({
				index: page.index,
				width: page.width,
				height: page.height,
				paragraphs: sortedById(page.paragraphs).map((paragraph) => ({
					...paragraph,
					characters: [...paragraph.characters].sort(
						(a, b) => a.index - b.index,
					),
					formulas: sortedById(paragraph.formulas),
				})),
				obstacles: [...page.obstacles].sort(
					(a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h,
				),
			})),
	};
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
		stableJson(canonicalDocument(document)),
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

/**
 * Reads tolerate both the current raw-PDF format and older gzip-wrapped
 * entries (`gunzipBytes` passes non-gzip bytes through), so upgrading does not
 * miss or corrupt existing caches.
 */
async function readCacheEntry(path: string): Promise<Uint8Array | null> {
	try {
		return gunzipBytes(await readFile(path));
	} catch {
		// Missing cache is a normal miss.
		return null;
	}
}

/**
 * Store the finished PDF as-is. PDFs with embedded fonts are already
 * compressed; gzip only saved ~10% while making the cache file impossible to
 * open outside the app. Best-effort: failures never break a translation.
 */
async function writeCacheEntry(path: string, bytes: Uint8Array): Promise<void> {
	try {
		await mkdir(path.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
		await writeFile(path, bytes);
	} catch (error) {
		logger.warn("pdf.reflow.buildCache write failed", {
			error: errorText(error),
		});
	}
}

/**
 * Bound per-paper disk usage: keep the newest few finals of this PDF and sweep
 * orphaned per-page previews left by the retired per-page cache. Pruning must
 * never fail the write that triggered it.
 */
async function pruneBuildDir(dir: string, prefix: string): Promise<void> {
	try {
		const entries = await readDir(dir);
		const finals = entries.filter(
			(entry) => entry.isFile && entry.name.startsWith(`${prefix}-final-`),
		);
		const stale: string[] = [];
		if (finals.length > FINAL_KEEP_COUNT) {
			const dated = await Promise.all(
				finals.map(async (entry) => {
					try {
						const info = await stat(await join(dir, entry.name));
						return { name: entry.name, at: info.mtime?.getTime() ?? 0 };
					} catch {
						return { name: entry.name, at: 0 };
					}
				}),
			);
			stale.push(
				...dated
					.sort((a, b) => b.at - a.at)
					.slice(FINAL_KEEP_COUNT)
					.map((entry) => entry.name),
			);
		}
		const pagePattern = new RegExp(`^${prefix}-p\\d+-`);
		for (const entry of entries)
			if (entry.isFile && pagePattern.test(entry.name)) stale.push(entry.name);
		await Promise.all(
			stale.map(async (name) => remove(await join(dir, name)).catch(() => {})),
		);
	} catch {
		// Pruning must never fail a translation.
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
			const cacheBase = await baseIdentity();
			if (cacheBase)
				await pruneBuildDir(cacheBase.dir, cacheBase.pdfSha256.slice(0, 16));
		},
	};
}
