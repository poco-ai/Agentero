/**
 * Persistent character-IR cache for the reflow path.
 *
 * Extraction is the expensive PDFium step that runs before any translation
 * work. The translation sidecar already makes a restart cheap for text, but
 * the character geometry still had to be rebuilt from scratch. This cache
 * stores only the source `ReflowDocument` pages (never translations) under the
 * app cache directory, keyed by PDF bytes + `layout.json` bytes + the exact
 * page inputs + the IR schema/algorithm versions.
 *
 * One file per page keeps page-only and full-document runs independent. Every
 * file carries its full key in the header; a mismatch, corrupt gzip stream, or
 * unreadable page simply falls back to a fresh extract.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import {
	mkdir,
	readDir,
	readFile,
	remove,
	rename,
	stat,
	writeFile,
} from "@tauri-apps/plugin-fs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { layoutSidecarPath } from "@/lib/pdf/layout/io";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { readVaultBytes } from "@/lib/vault/fs";
import {
	type Box,
	type Character,
	type CharacterCoverage,
	type CharacterDisposition,
	type CharacterStyle,
	type Formula,
	type Paragraph,
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowPage,
} from "./types";

export const REFLOW_IR_CACHE_FORMAT = "agentero.reflow-ir";
/** Bump when this file's header/filename contract changes. */
export const REFLOW_IR_CACHE_FORMAT_VERSION = 1;
/**
 * Bump whenever extraction, paragraph grouping, formula detection, or coverage
 * changes the IR for the same PDF and layout, even if the persisted shape stays
 * compatible. Old cache files then fail the key check and are re-extracted.
 */
export const REFLOW_IR_ALGORITHM_VERSION = 1;
const CACHE_DIR = "reflow-ir";
/** Bound stale-key accumulation; the app cache directory may also be cleared by the OS. */
const MAX_FILES_PER_PAPER = 96;

export type ReflowIrCacheSource = {
	/** Stable paper identifier, usually the vault-relative paper folder. */
	paperKey: string | null | undefined;
	/** Local paper folder containing `source/layout.json`. */
	paperAbsPath: string | null | undefined;
	/** Viewer bytes; keyed by content so a changed PDF never reuses old boxes. */
	pdfBytes: ArrayBuffer | Uint8Array | null | undefined;
	/** Items the current prepare call will turn into paragraphs. */
	items: readonly LayoutTranslateItem[];
	/** Region list the current prepare call uses for formulas/obstacles. */
	regions: readonly PdfLayoutRegion[];
};

/** Cache operations used by `prepareReflowItems`; fakes are used by tests. */
export type ReflowIrCacheStore = {
	read(pageIndexes: readonly number[]): Promise<Map<number, ReflowPage>>;
	write(pages: readonly ReflowPage[]): Promise<void>;
};

export type ReflowIrPageHeader = {
	format: string;
	formatVersion: number;
	schemaVersion: number;
	algorithmVersion: number;
	key: string;
	paperKey: string;
	pdfSha256: string;
	layoutSha256: string;
	pageIndex: number;
	itemsSha256: string;
	regionsSha256: string;
};

type ReflowIrCacheFile = ReflowIrPageHeader & { page: ReflowPage };
type CacheBase = {
	paperKey: string;
	dir: string;
	pdfSha256: string;
	layoutSha256: string;
};
type PageIdentity = {
	pageIndex: number;
	dir: string;
	filePath: string;
	header: ReflowIrPageHeader;
};

const pdfDigests = new WeakMap<object, Promise<string>>();

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return Array.from(new Uint8Array(digest), (n) =>
		n.toString(16).padStart(2, "0"),
	).join("");
}

function sha256Text(value: string): Promise<string> {
	return sha256(new TextEncoder().encode(value));
}

function pdfSha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	let pending = pdfDigests.get(bytes);
	if (!pending) {
		pending = sha256(
			bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
		).catch((error) => {
			pdfDigests.delete(bytes);
			throw error;
		});
		pdfDigests.set(bytes, pending);
	}
	return pending;
}

const boxParts = (box: Box) => [box.x, box.y, box.w, box.h];

/**
 * Fingerprint only what extraction reads. Item status/translation and region
 * text change during a run and must not churn the key; their geometry and
 * classification do.
 */
function itemsFingerprint(items: readonly LayoutTranslateItem[]): string {
	return JSON.stringify(
		items.map((item) => [
			item.id,
			item.pageIndex,
			item.kind,
			item.readingOrder,
			...boxParts(item.bbox),
		]),
	);
}

function regionsFingerprint(regions: readonly PdfLayoutRegion[]): string {
	return JSON.stringify(
		regions.map((region) => [
			region.id,
			region.pageIndex,
			region.kind,
			region.label,
			region.score,
			region.readingOrder,
			...boxParts(region.rect),
			...boxParts(region.bbox),
		]),
	);
}

function pageCacheKey(
	base: CacheBase,
	pageIndex: number,
	itemsSha256: string,
	regionsSha256: string,
): string {
	return [
		`format=${REFLOW_IR_CACHE_FORMAT_VERSION}`,
		`schema=${REFLOW_IR_SCHEMA_VERSION}`,
		`algorithm=${REFLOW_IR_ALGORITHM_VERSION}`,
		`paper=${base.paperKey}`,
		`pdf=${base.pdfSha256}`,
		`layout=${base.layoutSha256}`,
		`page=${pageIndex}`,
		`items=${itemsSha256}`,
		`regions=${regionsSha256}`,
	].join(":");
}

function paperSlug(paperKey: string): string {
	const base =
		paperKey.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "paper";
	const slug = base
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
	return slug || "paper";
}

function groupByPage<T extends { pageIndex: number }>(
	entries: readonly T[],
): Map<number, T[]> {
	const grouped = new Map<number, T[]>();
	for (const entry of entries) {
		const list = grouped.get(entry.pageIndex) ?? [];
		list.push(entry);
		grouped.set(entry.pageIndex, list);
	}
	return grouped;
}

async function resolveBase(
	source: ReflowIrCacheSource,
): Promise<CacheBase | null> {
	const paperKey = source.paperKey?.trim();
	const paperAbsPath = source.paperAbsPath?.trim();
	if (!isTauri() || !paperKey || !paperAbsPath || !source.pdfBytes) return null;
	let layoutBytes: Uint8Array;
	try {
		layoutBytes = await readVaultBytes(layoutSidecarPath(paperAbsPath));
	} catch {
		// No usable layout sidecar means there is no stable key to cache under.
		return null;
	}
	const [pdfHash, layoutHash, paperHash] = await Promise.all([
		pdfSha256(source.pdfBytes),
		sha256(layoutBytes),
		sha256Text(paperKey),
	]);
	return {
		paperKey,
		// Spell the folder with a readable paper name plus a stable hash.
		dir: await join(
			await appCacheDir(),
			CACHE_DIR,
			`${paperSlug(paperKey)}-${paperHash.slice(0, 12)}`,
		),
		pdfSha256: pdfHash,
		layoutSha256: layoutHash,
	};
}

/**
 * Build the real cache store. Key material is computed lazily on the first
 * read/write so a prepare call without a paper/layout/PDF never touches disk.
 */
export function createReflowIrCache(
	source: ReflowIrCacheSource,
): ReflowIrCacheStore {
	const itemsByPage = groupByPage(source.items);
	const regionsByPage = groupByPage(source.regions);
	let base: Promise<CacheBase | null> | undefined;
	const pages = new Map<number, Promise<PageIdentity | null>>();

	const baseIdentity = (): Promise<CacheBase | null> => {
		base ??= resolveBase(source).catch((error) => {
			logger.warn("pdf.reflow.cache key failed", { error: errorText(error) });
			return null;
		});
		return base;
	};

	const pageIdentity = (pageIndex: number): Promise<PageIdentity | null> => {
		const existing = pages.get(pageIndex);
		if (existing) return existing;
		const pending = (async () => {
			const cacheBase = await baseIdentity();
			if (!cacheBase) return null;
			const pageItems = itemsByPage.get(pageIndex) ?? [];
			if (!pageItems.length) return null;
			const pageRegions = regionsByPage.get(pageIndex) ?? [];
			const [itemsSha256, regionsSha256] = await Promise.all([
				sha256Text(itemsFingerprint(pageItems)),
				sha256Text(regionsFingerprint(pageRegions)),
			]);
			const key = pageCacheKey(
				cacheBase,
				pageIndex,
				itemsSha256,
				regionsSha256,
			);
			const keyHash = (await sha256Text(key)).slice(0, 20);
			return {
				pageIndex,
				dir: cacheBase.dir,
				filePath: await join(cacheBase.dir, `${pageIndex}-${keyHash}.json.gz`),
				header: {
					format: REFLOW_IR_CACHE_FORMAT,
					formatVersion: REFLOW_IR_CACHE_FORMAT_VERSION,
					schemaVersion: REFLOW_IR_SCHEMA_VERSION,
					algorithmVersion: REFLOW_IR_ALGORITHM_VERSION,
					key,
					paperKey: cacheBase.paperKey,
					pdfSha256: cacheBase.pdfSha256,
					layoutSha256: cacheBase.layoutSha256,
					pageIndex,
					itemsSha256,
					regionsSha256,
				},
			};
		})().catch((error) => {
			logger.warn("pdf.reflow.cache key failed", {
				page: pageIndex,
				error: errorText(error),
			});
			return null;
		});
		pages.set(pageIndex, pending);
		return pending;
	};

	return {
		async read(pageIndexes) {
			const found = new Map<number, ReflowPage>();
			await Promise.all(
				[...new Set(pageIndexes)].map(async (pageIndex) => {
					const identity = await pageIdentity(pageIndex);
					if (!identity) return;
					let bytes: Uint8Array;
					try {
						bytes = await readFile(identity.filePath);
					} catch {
						// Missing page cache is a normal miss.
						return;
					}
					const page = await decodeReflowIrCachePage(bytes, identity.header);
					if (page) found.set(pageIndex, page);
					else
						logger.warn("pdf.reflow.cache rejected", {
							page: pageIndex,
							paper: identity.header.paperKey,
						});
				}),
			);
			return found;
		},
		async write(cachedPages) {
			const targets = await Promise.all(
				cachedPages.map(async (page) => {
					const identity = await pageIdentity(page.index);
					if (!identity) return null;
					return { identity, page };
				}),
			);
			if (!targets.some(Boolean)) return;
			await Promise.all(
				targets.filter(Boolean).map(async (target) => {
					if (!target) return;
					try {
						await mkdir(target.identity.dir, { recursive: true });
						const payload = await encodeReflowIrCachePage({
							...target.identity.header,
							page: target.page,
						});
						const temp = `${target.identity.filePath}.${crypto.randomUUID()}.tmp`;
						await writeFile(temp, payload);
						try {
							await rename(temp, target.identity.filePath);
						} catch (error) {
							await remove(temp).catch(() => {});
							throw error;
						}
					} catch (error) {
						logger.warn("pdf.reflow.cache write failed", {
							page: target.page.index,
							error: errorText(error),
						});
					}
				}),
			);
			const cacheBase = await baseIdentity();
			if (cacheBase) await pruneCacheDir(cacheBase.dir);
		},
	};
}

async function pruneCacheDir(directory: string): Promise<void> {
	try {
		const entries = await readDir(directory);
		const files = entries.filter(
			(entry) => entry.isFile && entry.name.endsWith(".json.gz"),
		);
		if (files.length <= MAX_FILES_PER_PAPER) return;
		const dated = await Promise.all(
			files.map(async (entry) => {
				try {
					const info = await stat(await join(directory, entry.name));
					return { name: entry.name, at: info.mtime?.getTime() ?? 0 };
				} catch {
					return { name: entry.name, at: 0 };
				}
			}),
		);
		const stale = dated.sort((a, b) => b.at - a.at).slice(MAX_FILES_PER_PAPER);
		await Promise.all(
			stale.map(async (entry) =>
				remove(await join(directory, entry.name)).catch(() => {}),
			),
		);
	} catch {
		// Pruning must never fail a translation.
	}
}

export async function encodeReflowIrCachePage(
	file: ReflowIrCacheFile,
): Promise<Uint8Array> {
	const json = new TextEncoder().encode(JSON.stringify(file));
	if (typeof CompressionStream === "undefined") return json;
	const stream = new Blob([json])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeReflowIrCachePage(
	bytes: Uint8Array,
	expected: ReflowIrPageHeader,
): Promise<ReflowPage | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(await decompress(bytes)));
	} catch {
		return null;
	}
	if (!isObject(raw)) return null;
	const header = parsePageHeader(raw);
	if (!header || !sameHeader(header, expected)) return null;
	const page = parseReflowPage(raw.page);
	return page?.index === header.pageIndex ? page : null;
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
	if (typeof DecompressionStream === "undefined")
		throw new Error("gzip decompression is unavailable");
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sameHeader(a: ReflowIrPageHeader, b: ReflowIrPageHeader): boolean {
	return (
		a.format === b.format &&
		a.formatVersion === b.formatVersion &&
		a.schemaVersion === b.schemaVersion &&
		a.algorithmVersion === b.algorithmVersion &&
		a.key === b.key &&
		a.paperKey === b.paperKey &&
		a.pdfSha256 === b.pdfSha256 &&
		a.layoutSha256 === b.layoutSha256 &&
		a.pageIndex === b.pageIndex &&
		a.itemsSha256 === b.itemsSha256 &&
		a.regionsSha256 === b.regionsSha256
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isBox(value: unknown): value is Box {
	return (
		isObject(value) &&
		isFiniteNumber(value.x) &&
		isFiniteNumber(value.y) &&
		isFiniteNumber(value.w) &&
		isFiniteNumber(value.h)
	);
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isFiniteNumber);
}

function isStyle(value: unknown): value is CharacterStyle {
	if (
		!isObject(value) ||
		typeof value.font !== "string" ||
		!isFiniteNumber(value.size) ||
		typeof value.bold !== "boolean" ||
		typeof value.italic !== "boolean" ||
		!isObject(value.color)
	)
		return false;
	return (
		isFiniteNumber(value.color.r) &&
		isFiniteNumber(value.color.g) &&
		isFiniteNumber(value.color.b)
	);
}

function isCharacter(value: unknown): value is Character {
	if (
		!isObject(value) ||
		!Number.isInteger(value.index) ||
		typeof value.text !== "string" ||
		!isBox(value.box) ||
		!isBox(value.visualBox) ||
		!isStyle(value.style)
	)
		return false;
	if (
		value.clipBoxes !== undefined &&
		!(Array.isArray(value.clipBoxes) && value.clipBoxes.every(isNumberArray))
	)
		return false;
	if (value.renderMode !== undefined && !isFiniteNumber(value.renderMode))
		return false;
	if (value.textAngle !== undefined && !isFiniteNumber(value.textAngle))
		return false;
	if (value.textMatrix !== undefined && !isNumberArray(value.textMatrix))
		return false;
	return value.textObjectId === undefined || isFiniteNumber(value.textObjectId);
}

function isFormula(value: unknown): value is Formula {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		isBox(value.box) &&
		Array.isArray(value.characterIndexes) &&
		value.characterIndexes.every(Number.isInteger) &&
		isFiniteNumber(value.baselineOffset)
	);
}

const dispositions = new Set<CharacterDisposition>([
	"translated",
	"formula",
	"table",
	"excluded",
	"rotated",
	"unresolved",
	"nonpainting",
	"clipped",
]);

function isCoverage(value: unknown): value is CharacterCoverage {
	return (
		isObject(value) &&
		Number.isInteger(value.index) &&
		typeof value.text === "string" &&
		typeof value.disposition === "string" &&
		dispositions.has(value.disposition as CharacterDisposition) &&
		(value.paragraphId === undefined || typeof value.paragraphId === "string")
	);
}

const origins = new Set<NonNullable<Paragraph["origin"]>>([
	"detected",
	"table",
	"fallback",
]);

function isParagraph(value: unknown): value is Paragraph {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		!Number.isInteger(value.pageIndex) ||
		!isBox(value.box) ||
		!Array.isArray(value.characters) ||
		!value.characters.every(isCharacter) ||
		!Array.isArray(value.formulas) ||
		!value.formulas.every(isFormula) ||
		!isObject(value.styles) ||
		!Object.values(value.styles).every(isStyle) ||
		typeof value.source !== "string" ||
		typeof value.protectedText !== "string" ||
		!isStyle(value.style) ||
		!isFiniteNumber(value.firstLineIndent) ||
		typeof value.heading !== "boolean"
	)
		return false;
	if (value.fixedBox !== undefined && typeof value.fixedBox !== "boolean")
		return false;
	if (value.layoutBox !== undefined && !isBox(value.layoutBox)) return false;
	return (
		value.origin === undefined ||
		(typeof value.origin === "string" &&
			origins.has(value.origin as NonNullable<Paragraph["origin"]>))
	);
}

function parseReflowPage(value: unknown): ReflowPage | null {
	if (
		!isObject(value) ||
		!Number.isInteger(value.index) ||
		(value.index as number) < 0 ||
		!isFiniteNumber(value.width) ||
		value.width <= 0 ||
		!isFiniteNumber(value.height) ||
		value.height <= 0 ||
		!Array.isArray(value.paragraphs) ||
		!value.paragraphs.every(isParagraph) ||
		!Array.isArray(value.obstacles) ||
		!value.obstacles.every(isBox)
	)
		return null;
	if (
		value.coverage !== undefined &&
		!(Array.isArray(value.coverage) && value.coverage.every(isCoverage))
	)
		return null;
	const page = value as unknown as ReflowPage;
	if (page.paragraphs.some((paragraph) => paragraph.pageIndex !== page.index))
		return null;
	return page;
}

function parsePageHeader(
	value: Record<string, unknown>,
): ReflowIrPageHeader | null {
	if (
		value.format !== REFLOW_IR_CACHE_FORMAT ||
		!Number.isInteger(value.formatVersion) ||
		!Number.isInteger(value.schemaVersion) ||
		!Number.isInteger(value.algorithmVersion) ||
		!Number.isInteger(value.pageIndex)
	)
		return null;
	for (const key of [
		"key",
		"paperKey",
		"pdfSha256",
		"layoutSha256",
		"itemsSha256",
		"regionsSha256",
	] as const)
		if (typeof value[key] !== "string") return null;
	return value as unknown as ReflowIrPageHeader;
}
