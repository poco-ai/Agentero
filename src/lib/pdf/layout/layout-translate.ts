/**
 * Bulk page translation for layout body-text regions (text / abstract / header).
 * Progressive: callers apply each result as soon as it completes.
 */

import i18n from "@/i18n";
import { listenAgentCompleted, listenAgentFailed, runOnce } from "@/lib/agent";
import { commands, type Json } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { parseBbox } from "@/lib/pdf/layout/layout-index";
import {
	draftChainSentences,
	draftReflowSentences,
	joinTranslatedDisplays,
	type LayoutSentenceDraft,
	paintSentenceTranslations,
	reflowSentenceValidator,
} from "@/lib/pdf/layout/layout-sentences";
import {
	buildLayoutTranslateChains,
	type LayoutTranslateChain,
} from "@/lib/pdf/layout/layout-translate-source";
import { splitTranslationChunks } from "@/lib/pdf/layout/translation-chunks";
import type {
	LayoutTranslateItem,
	LayoutTranslateRegion,
	LayoutTranslateSentence,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import { loadSettings } from "@/lib/settings";
import { runTranslate } from "@/lib/translate";
import { isTranslateTransportError } from "@/lib/translate/errors";
import { langsFromSettings } from "@/lib/translate/lang";
import {
	type MaskedToken,
	maskInlineTokens,
	restoreInlineTokens,
} from "@/lib/translate/mask";
import { resolveConfiguredTranslateAgent } from "@/lib/translate/resolve-agent";
import type {
	CommercialTranslateProviderId,
	TranslateProviderId,
	TranslateRunOptions,
	TranslateSettings,
} from "@/lib/translate/types";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";

/** Parallel free/commercial MT workers (order of *start* follows reading order). */
export const LAYOUT_TRANSLATE_CONCURRENCY = 2;

/**
 * Consecutive transport failures before a run stops calling the provider.
 *
 * A dead endpoint (expired TLS certificate, DNS failure, blocked route) fails
 * every block the same way. Without this bound a whole-document run keeps
 * issuing doomed requests with the meter pinned near full; three failures is
 * enough to tell an unreachable provider from a single flaky request.
 */
export const LAYOUT_TRANSLATE_PROVIDER_DOWN_FAILURES = 3;

/**
 * Soft cap on the summed payload per batch request. The Host rejects text over
 * 5000 chars (`MAX_TEXT_CHARS`), so keep batches comfortably below it while
 * still grouping ~one double-column page of paragraphs for shared context.
 */
export const LAYOUT_TRANSLATE_BATCH_CHARS = 4500;

export const LAYOUT_TRANSLATE_SIDECAR_SCHEMA_VERSION = 2;
export const LAYOUT_TRANSLATE_SIDECAR_FILE = "layout-translate.json";

/**
 * Trailing debounce for the whole-file `layout-translate.json` write. Each
 * translated block used to rewrite the entire sidecar immediately (400+ writes
 * for a long paper); coalescing keeps crash-recovery progress while bounding
 * disk churn. See paper-pipeline-orchestration.md §8.1.
 */
export const LAYOUT_TRANSLATE_WRITE_DEBOUNCE_MS = 500;

/** Pending debounced sidecar writes, keyed by paper folder. */
const translateSidecarWriteTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();

export type {
	LayoutTranslateItem,
	LayoutTranslateItemStatus,
	LayoutTranslateRegion,
	LayoutTranslateSentence,
} from "@/lib/pdf/layout/types";

export type LayoutTranslateCacheKey = {
	providerId: TranslateProviderId;
	sourceLang: string;
	targetLang: string;
	serviceKey: string;
};

export type LayoutTranslateSidecarItem = {
	id: string;
	pageIndex: number;
	bbox: PdfLayoutRegion["bbox"];
	kind: PdfLayoutRegion["kind"];
	readingOrder: number;
	source: string;
	translated: string;
	/** Present when this block was paired sentence by sentence. */
	sentences?: LayoutTranslateSentence[];
};

export type LayoutTranslateSidecar = {
	schemaVersion: number;
	source: {
		mode: "pdf-layout-translate";
		generatedAt: string;
		providerId: TranslateProviderId;
		sourceLang: string;
		targetLang: string;
		serviceKey: string;
	};
	items: LayoutTranslateSidecarItem[];
};

export type LayoutTranslateWriteOptions = {
	/**
	 * Page and background runs can write a subset of the document. Preserve
	 * all completed cached blocks when merging that subset.
	 */
	preserveExisting?: boolean;
};

export {
	isAlgorithmTitleText,
	isAsideTextLayoutLabel,
	isInsideAlgorithmRegion,
	layoutRegionSourceText,
	listTranslatableLayoutRegions,
} from "@/lib/pdf/layout/translatable";

export function toLayoutTranslateItems(
	regions: readonly LayoutTranslateRegion[],
): LayoutTranslateItem[] {
	return regions.map((r) => ({ ...r, status: "pending" as const }));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** FNV-1a 32-bit fingerprint of the custom translate prompt — cache-busting only. */
function promptFingerprint(prompt: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < prompt.length; i++) {
		h ^= prompt.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * Service identity for the sidecar cache. A non-empty custom prompt appends
 * its fingerprint so changing the prompt re-translates instead of hitting the
 * old cache; empty keeps the prompt-less key byte-identical so existing
 * `layout-translate.json` caches survive upgrades.
 */
export function translateServiceKey(settings: TranslateSettings): string {
	const providerId = settings.provider;
	const promptSource = [
		settings.customPrompt,
		settings.customSystem,
		settings.customUser,
		Object.keys(settings.glossaries ?? {}).length
			? JSON.stringify(
					Object.entries(settings.glossaries).sort(([a], [b]) =>
						a.localeCompare(b),
					),
				)
			: "",
	]
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n");
	const promptPart =
		promptSource.length > 0 ? `:p${promptFingerprint(promptSource)}` : "";
	if (providerId === "agent") {
		return `agent:${settings.agentId || "default"}:${settings.modelId || "default"}${promptPart}`;
	}
	const configs = settings.providerConfigs as Partial<
		Record<
			CommercialTranslateProviderId,
			{
				baseUrl?: string;
				region?: string;
				model?: string;
				extraRequestBody?: string;
			}
		>
	>;
	const config = configs[providerId as CommercialTranslateProviderId];
	if (!config) return `${providerId}${promptPart}`;
	const extra = config.extraRequestBody?.trim() ?? "";
	const optionsPart =
		providerId === "openaiCompatible" && extra
			? `:o${promptFingerprint(extra)}`
			: "";
	return (
		[
			providerId,
			config.baseUrl?.trim() ?? "",
			config.region?.trim() ?? "",
			config.model?.trim() ?? "",
		].join(":") +
		promptPart +
		optionsPart
	);
}

export function currentLayoutTranslateCacheKey(): LayoutTranslateCacheKey {
	const settings = loadSettings();
	const langs = langsFromSettings(settings.translate, i18n.language ?? "en");
	return {
		providerId: settings.translate.provider,
		sourceLang: langs.sourceLang,
		targetLang: langs.targetLang,
		serviceKey: translateServiceKey(settings.translate),
	};
}

function sameLayoutTranslateCacheKey(
	a: LayoutTranslateCacheKey,
	b: LayoutTranslateCacheKey,
): boolean {
	return (
		a.providerId === b.providerId &&
		a.sourceLang === b.sourceLang &&
		a.targetLang === b.targetLang &&
		a.serviceKey === b.serviceKey
	);
}

export function layoutTranslateSidecarPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, "source"),
		LAYOUT_TRANSLATE_SIDECAR_FILE,
	);
}

/**
 * Drop malformed sentence entries. A bad entry does not reject the block or
 * the file; the block simply has fewer pairs, or none.
 */
function parseSidecarSentences(
	value: unknown,
): LayoutTranslateSentence[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: LayoutTranslateSentence[] = [];
	for (const entry of value) {
		if (!isObject(entry)) continue;
		const { quote, source, translated, display } = entry;
		if (typeof quote !== "string" || !quote.trim()) continue;
		if (typeof source !== "string" || !source.trim()) continue;
		if (typeof translated !== "string" || !translated.trim()) continue;
		const sentence: LayoutTranslateSentence = {
			quote,
			source,
			translated: translated.trim(),
		};
		if (
			typeof display === "string" &&
			display.trim() &&
			display.trim() !== sentence.translated
		) {
			sentence.display = display.trim();
		}
		out.push(sentence);
	}
	return out.length > 0 ? out : undefined;
}

function sidecarSentences(
	sentences: readonly LayoutTranslateSentence[] | undefined,
): LayoutTranslateSentence[] | undefined {
	return parseSidecarSentences(sentences);
}

function parseLayoutTranslateSidecarItem(
	value: unknown,
): LayoutTranslateSidecarItem | null {
	if (!isObject(value)) return null;
	const { id, pageIndex, bbox, kind, readingOrder, source, translated } = value;
	if (
		typeof id !== "string" ||
		!isFiniteNumber(pageIndex) ||
		typeof kind !== "string" ||
		!isFiniteNumber(readingOrder) ||
		typeof source !== "string" ||
		typeof translated !== "string" ||
		!translated.trim()
	) {
		return null;
	}
	const parsedBbox = parseBbox(bbox);
	if (!parsedBbox) return null;
	const item: LayoutTranslateSidecarItem = {
		id,
		pageIndex,
		bbox: parsedBbox,
		kind: kind as PdfLayoutRegion["kind"],
		readingOrder,
		source,
		translated,
	};
	const sentences = parseSidecarSentences(value.sentences);
	if (sentences) item.sentences = sentences;
	return item;
}

export function parseLayoutTranslateSidecar(
	raw: unknown,
	expectedKey?: LayoutTranslateCacheKey,
): LayoutTranslateSidecar | null {
	if (!isObject(raw)) return null;
	if (raw.schemaVersion !== LAYOUT_TRANSLATE_SIDECAR_SCHEMA_VERSION)
		return null;
	if (!isObject(raw.source) || raw.source.mode !== "pdf-layout-translate") {
		return null;
	}
	const { generatedAt, providerId, sourceLang, targetLang, serviceKey } =
		raw.source;
	if (
		typeof generatedAt !== "string" ||
		typeof providerId !== "string" ||
		typeof sourceLang !== "string" ||
		typeof targetLang !== "string" ||
		typeof serviceKey !== "string"
	) {
		return null;
	}
	const key: LayoutTranslateCacheKey = {
		providerId: providerId as TranslateProviderId,
		sourceLang,
		targetLang,
		serviceKey,
	};
	if (expectedKey && !sameLayoutTranslateCacheKey(key, expectedKey))
		return null;
	if (!Array.isArray(raw.items)) return null;
	const items = raw.items.map(parseLayoutTranslateSidecarItem);
	if (items.some((item) => !item)) return null;
	return {
		schemaVersion: LAYOUT_TRANSLATE_SIDECAR_SCHEMA_VERSION,
		source: {
			mode: "pdf-layout-translate",
			generatedAt,
			providerId: key.providerId,
			sourceLang,
			targetLang,
			serviceKey,
		},
		items: items as LayoutTranslateSidecarItem[],
	};
}

export async function readLayoutTranslateSidecar(
	paperAbsPath: string | null | undefined,
	key: LayoutTranslateCacheKey,
): Promise<LayoutTranslateSidecar | null> {
	if (!paperAbsPath) return null;
	try {
		const text = await readVaultFile(layoutTranslateSidecarPath(paperAbsPath));
		return parseLayoutTranslateSidecar(JSON.parse(text), key);
	} catch {
		return null;
	}
}

export function applyLayoutTranslateSidecar(
	items: readonly LayoutTranslateItem[],
	sidecar: LayoutTranslateSidecar | null,
	options?: { requireReflowSentencePairs?: boolean },
): LayoutTranslateItem[] {
	if (!sidecar?.items.length) return items.map((it) => ({ ...it }));
	const byId = new Map(sidecar.items.map((item) => [item.id, item]));
	return items.map((item) => {
		const cached = byId.get(item.id);
		if (!cached || cached.source !== item.source) return { ...item };
		if (options?.requireReflowSentencePairs && item.reflow) {
			const drafts = draftReflowSentences(item.reflow);
			if (
				drafts.length > 1 &&
				(cached.sentences?.length !== drafts.length ||
					drafts.some(
						(draft, index) => draft.quote !== cached.sentences?.[index]?.quote,
					))
			) {
				return {
					...item,
					status: "pending",
					translated: undefined,
					sentences: undefined,
					error: undefined,
				};
			}
		}
		return {
			...item,
			status: "done" as const,
			translated: cached.translated.trim(),
			sentences: cached.sentences,
			error: undefined,
		};
	});
}

/** Cached translations recovered from `layout-translate.json`, plus what is left. */
export type LayoutTranslateCacheHydration = {
	items: LayoutTranslateItem[];
	/** Blocks with a non-empty translation after applying the sidecar. */
	cachedCount: number;
	/** Blocks whose translation is still empty; the partial-translate scope. */
	pendingRequired: number;
	/** At least one block already had a translation (cached or carried over). */
	fromCache: boolean;
};

/**
 * Apply a sidecar to the full block list and report what the UI must show.
 *
 * This is the single place both translation entrypoints hydrate a cache, so a
 * stopped/partially failed document renders the same `{ items, pendingRequired }`
 * regardless of which mode opened it. Callers decide the job status: no cache
 * keeps the normal translate flow, a complete cache renders immediately, and a
 * cache with gaps renders immediately as partial without a network request.
 */
export function hydrateLayoutTranslateItems(
	items: readonly LayoutTranslateItem[],
	sidecar: LayoutTranslateSidecar | null,
	options?: { requireReflowSentencePairs?: boolean },
): LayoutTranslateCacheHydration {
	const hydrated = applyLayoutTranslateSidecar(items, sidecar, options);
	let cachedCount = 0;
	for (const item of hydrated) {
		if (item.translated?.trim()) cachedCount += 1;
	}
	return {
		items: hydrated,
		cachedCount,
		pendingRequired: hydrated.length - cachedCount,
		fromCache: cachedCount > 0,
	};
}

/** Blocks that still have no translation, in reading order. */
export function countPendingLayoutTranslateItems(
	items: readonly LayoutTranslateItem[],
): number {
	let pending = 0;
	for (const item of items) {
		if (!item.translated?.trim()) pending += 1;
	}
	return pending;
}

/** 1-based inclusive page span of untranslated blocks, for the partial hint. */
export function layoutTranslatePendingPageRange(
	items: readonly LayoutTranslateItem[],
): { start: number; end: number } | null {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		if (item.translated?.trim()) continue;
		first = Math.min(first, item.pageIndex);
		last = Math.max(last, item.pageIndex);
	}
	return Number.isFinite(first) && Number.isFinite(last)
		? { start: first + 1, end: last + 1 }
		: null;
}

export async function writeLayoutTranslateSidecar(
	paperAbsPath: string | null | undefined,
	key: LayoutTranslateCacheKey,
	items: readonly LayoutTranslateItem[],
	options: LayoutTranslateWriteOptions = {},
): Promise<void> {
	if (!paperAbsPath) return;
	const done = items
		.filter((item) => item.status === "done" && item.translated?.trim())
		.map((item): LayoutTranslateSidecarItem => {
			const written: LayoutTranslateSidecarItem = {
				id: item.id,
				pageIndex: item.pageIndex,
				bbox: item.bbox,
				kind: item.kind,
				readingOrder: item.readingOrder,
				source: item.source,
				translated: item.translated?.trim() ?? "",
			};
			const sentences = sidecarSentences(item.sentences);
			if (sentences) written.sentences = sentences;
			return written;
		});
	const merged = new Map<string, LayoutTranslateSidecarItem>();
	if (
		options.preserveExisting &&
		(!isTauri() || paperAbsPath.startsWith("remote:"))
	) {
		const existing = await readLayoutTranslateSidecar(paperAbsPath, key);
		for (const item of existing?.items ?? []) {
			merged.set(item.id, item);
		}
	}
	for (const item of done) {
		merged.set(item.id, item);
	}
	const sidecar: LayoutTranslateSidecar = {
		schemaVersion: LAYOUT_TRANSLATE_SIDECAR_SCHEMA_VERSION,
		source: {
			mode: "pdf-layout-translate",
			generatedAt: new Date().toISOString(),
			providerId: key.providerId,
			sourceLang: key.sourceLang,
			targetLang: key.targetLang,
			serviceKey: key.serviceKey,
		},
		items: [...merged.values()].sort(
			(a, b) =>
				a.pageIndex - b.pageIndex ||
				a.readingOrder - b.readingOrder ||
				a.bbox.y - b.bbox.y ||
				a.bbox.x - b.bbox.x,
		),
	};
	if (isTauri() && !paperAbsPath.startsWith("remote:")) {
		await callApi(() =>
			commands.layoutTranslateCacheWrite({
				paperAbsPath,
				sidecar: sidecar as unknown as Json,
				preserveExisting: options.preserveExisting ?? false,
			}),
		);
		return;
	}
	await writeVaultFile(
		layoutTranslateSidecarPath(paperAbsPath),
		`${JSON.stringify(sidecar, null, 2)}\n`,
	);
}

export function hasPendingLayoutTranslateItems(
	items: readonly LayoutTranslateItem[],
): boolean {
	return items.some(
		(item) => item.status !== "done" || !item.translated?.trim(),
	);
}

/** Chains translate as one unit, so one stale fragment re-runs all of them. */
function chainNeedsTranslate(chain: LayoutTranslateChain): boolean {
	return hasPendingLayoutTranslateItems(chain.members);
}

const pendingSidecarWrites = new Map<
	string,
	{
		key: LayoutTranslateCacheKey;
		items: readonly LayoutTranslateItem[];
		options: LayoutTranslateWriteOptions;
	}
>();

function mergePendingSidecarWrite(
	paper: string,
	key: LayoutTranslateCacheKey,
	items: readonly LayoutTranslateItem[],
	options: LayoutTranslateWriteOptions,
): readonly LayoutTranslateItem[] {
	const pending = pendingSidecarWrites.get(paper);
	if (
		!pending ||
		!options.preserveExisting ||
		!pending.options.preserveExisting ||
		!sameLayoutTranslateCacheKey(pending.key, key)
	)
		return items;
	const merged = new Map(
		pending.items
			.filter((item) => item.status === "done")
			.map((item) => [item.id, item]),
	);
	for (const item of items)
		if (item.status === "done") merged.set(item.id, item);
	return [...merged.values()];
}

export function persistLayoutTranslateSidecarBestEffort(
	paperAbsPath: string | null | undefined,
	key: LayoutTranslateCacheKey,
	items: readonly LayoutTranslateItem[],
	options: LayoutTranslateWriteOptions = {},
): void {
	if (!paperAbsPath) return;
	const pending = translateSidecarWriteTimers.get(paperAbsPath);
	if (pending) clearTimeout(pending);
	const merged = mergePendingSidecarWrite(paperAbsPath, key, items, options);
	pendingSidecarWrites.set(paperAbsPath, { key, items: merged, options });
	const timer = setTimeout(() => {
		translateSidecarWriteTimers.delete(paperAbsPath);
		const pending = pendingSidecarWrites.get(paperAbsPath);
		pendingSidecarWrites.delete(paperAbsPath);
		if (!pending) return;
		void writeLayoutTranslateSidecar(
			paperAbsPath,
			pending.key,
			pending.items,
			pending.options,
		).catch((error) => {
			logger.warn("layout translate cache write failed", {
				error: errorText(error),
			});
		});
	}, LAYOUT_TRANSLATE_WRITE_DEBOUNCE_MS);
	translateSidecarWriteTimers.set(paperAbsPath, timer);
}

/**
 * Flush a finished run's sidecar immediately, cancelling its pending debounce.
 * A page toggle issued right after the run must be able to read the blocks
 * that just completed instead of starting a second translation pass.
 */
export async function flushLayoutTranslateSidecar(
	paperAbsPath: string | null | undefined,
	key: LayoutTranslateCacheKey,
	items: readonly LayoutTranslateItem[],
	options: LayoutTranslateWriteOptions = {},
): Promise<void> {
	if (!paperAbsPath) return;
	const pending = translateSidecarWriteTimers.get(paperAbsPath);
	if (pending) clearTimeout(pending);
	translateSidecarWriteTimers.delete(paperAbsPath);
	const merged = mergePendingSidecarWrite(paperAbsPath, key, items, options);
	pendingSidecarWrites.delete(paperAbsPath);
	await writeLayoutTranslateSidecar(paperAbsPath, key, merged, options).catch(
		(error) => {
			logger.warn("layout translate cache write failed", {
				error: errorText(error),
			});
		},
	);
}

/** Paint-relevant identity of one bucket slot (id, progress, partial text). */
function sameLayoutTranslateBucketSlot(
	before: LayoutTranslateItem | undefined,
	after: LayoutTranslateItem,
): boolean {
	return (
		before !== undefined &&
		before.id === after.id &&
		before.status === after.status &&
		before.translated === after.translated &&
		before.reflow === after.reflow &&
		before.reflowPreview === after.reflowPreview &&
		before.reflowPreviewSources === after.reflowPreviewSources &&
		before.reflowLayout === after.reflowLayout &&
		sentencePaintKey(before) === sentencePaintKey(after)
	);
}

function sentencePaintKey(item: LayoutTranslateItem): string {
	return (item.sentences ?? [])
		.map(
			(sentence) =>
				`${sentence.quote}\0${sentence.display ?? sentence.translated}`,
		)
		.join("\n");
}

/**
 * Bucket job items by page so each page overlay reads its own list instead of
 * filtering the whole job. When `previous` is given, a bucket whose
 * paint-relevant contents are unchanged reuses the previous array identity, so
 * memoized page overlays bail out while the streaming job only touches the
 * page currently translating.
 */
export function groupLayoutTranslateItemsByPage(
	items: readonly LayoutTranslateItem[],
	previous?: ReadonlyMap<number, readonly LayoutTranslateItem[]>,
): ReadonlyMap<number, readonly LayoutTranslateItem[]> {
	const grouped = new Map<number, LayoutTranslateItem[]>();
	for (const item of items) {
		const bucket = grouped.get(item.pageIndex);
		if (bucket) bucket.push(item);
		else grouped.set(item.pageIndex, [item]);
	}
	if (!previous) return grouped;
	const next: Map<number, readonly LayoutTranslateItem[]> = new Map(grouped);
	for (const [pageIndex, bucket] of grouped) {
		const prev = previous.get(pageIndex);
		if (
			prev &&
			prev.length === bucket.length &&
			bucket.every((item, i) => sameLayoutTranslateBucketSlot(prev[i], item))
		) {
			next.set(pageIndex, prev);
		}
	}
	return next;
}

/** Non-streaming Agent runner for bulk layout translate (settings provider=agent). */
async function resolveLayoutTranslateAgentOpts(options: {
	paperKey: string | null | undefined;
	vaultPath: string | null | undefined;
}): Promise<TranslateRunOptions | undefined> {
	const settings = loadSettings();
	if (settings.translate.provider !== "agent") return undefined;
	const resolved = await resolveConfiguredTranslateAgent();
	if (!resolved.agentId) {
		throw new Error("No Agent configured for translation");
	}
	const agentId = resolved.agentId;
	const modelId = resolved.modelId;
	const { paperKey, vaultPath } = options;
	return {
		agent: {
			runOnce: async (prompt: string) => {
				const cachedSessionId = getAgentTranslateSessionId(
					paperKey,
					agentId,
					modelId,
				);
				const accepted = await runOnce({
					prompt,
					agentId,
					modelId,
					sessionId: cachedSessionId ?? undefined,
					vaultPath: vaultPath ?? undefined,
					workflow: "translate",
					permissionMode: "auto",
					hideFromChatHistory: true,
				});
				const sessionId = accepted.sessionId;
				return await new Promise<string>((resolve, reject) => {
					const unsubs: Array<() => void> = [];
					const cleanup = () => {
						for (const u of unsubs) u();
					};
					void listenAgentCompleted((ev) => {
						if (ev.sessionId !== sessionId) return;
						cleanup();
						if (ev.providerSessionId && ev.stopReason !== "cancelled") {
							setAgentTranslateSessionId(
								paperKey,
								agentId,
								modelId,
								ev.providerSessionId,
							);
						}
						resolve((ev.content ?? "").trim());
					}).then((u) => unsubs.push(u));
					void listenAgentFailed((ev) => {
						if (ev.sessionId !== sessionId) return;
						cleanup();
						evictAgentTranslateSessionId(paperKey, agentId, modelId);
						reject(new Error(ev.error || "Agent translation failed"));
					}).then((u) => unsubs.push(u));
				});
			},
		},
	};
}

/**
 * Marker used to number sentences inside a batch payload, e.g. `[[1]] …`.
 * Double brackets distinguish it from single-bracket citations (`[1]`) that the
 * translation may legitimately contain.
 */
const TRANSLATE_BATCH_MARKER_RE = /(\[{2}|［{2})\s*(\d+)\s*(\]{2}|］{2})/g;

/** Anything batchable: a single region or a joined paragraph chain. */
type TranslateUnit = { source: string };

/** Projected payload length of a batch (matches {@link buildNumberedPayload}). */
function batchPayloadLength(batch: readonly TranslateUnit[]): number {
	if (batch.length === 0) return 0;
	if (batch.length === 1) return batch[0]?.source.length ?? 0;
	let total = 0;
	batch.forEach((unit, i) => {
		total += `[[${i + 1}]] `.length + unit.source.length;
		if (i > 0) total += 2; // "\n\n"
	});
	return total;
}

/**
 * Group units (already in reading order) into batches whose combined payload
 * stays under {@link LAYOUT_TRANSLATE_BATCH_CHARS}. Oversized units are kept
 * alone and split by the transport. Batches may span adjacent pages; results are mapped
 * back per unit, so positions are unaffected.
 */
export function buildTranslateBatches<T extends TranslateUnit>(
	units: readonly T[],
): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	for (const unit of units) {
		const candidate = [...current, unit];
		if (
			current.length > 0 &&
			batchPayloadLength(candidate) > LAYOUT_TRANSLATE_BATCH_CHARS
		) {
			batches.push(current);
			current = [unit];
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Join a batch into one numbered payload; a lone unit is sent as-is. */
export function buildNumberedPayload(batch: readonly TranslateUnit[]): string {
	if (batch.length === 1) return batch[0]?.source ?? "";
	return batch.map((unit, i) => `[[${i + 1}]] ${unit.source}`).join("\n\n");
}

/**
 * Split a numbered translation back into `expected` segments by `[[n]]` markers.
 * Returns null when markers are missing/out of order or any segment is empty, so
 * the caller can fall back to translating each sentence individually.
 */
export function parseNumberedTranslation(
	result: string,
	expected: number,
): string[] | null {
	const trimmed = result.trim();
	if (expected <= 1) return trimmed ? [trimmed] : null;
	const markers: { n: number; start: number; end: number }[] = [];
	const re = new RegExp(TRANSLATE_BATCH_MARKER_RE.source, "g");
	let m = re.exec(trimmed);
	while (m !== null) {
		markers.push({
			n: Number(m[2]),
			start: m.index,
			end: m.index + m[0].length,
		});
		m = re.exec(trimmed);
	}
	if (markers.length !== expected || trimmed.slice(0, markers[0]?.start).trim())
		return null;
	const chosen = markers.slice(0, expected);
	for (let i = 0; i < expected; i++) {
		if (chosen[i]?.n !== i + 1) return null;
	}
	const segments: string[] = [];
	for (let i = 0; i < expected; i++) {
		const cur = chosen[i];
		if (!cur) return null;
		const nextStart = i + 1 < expected ? chosen[i + 1]?.start : trimmed.length;
		const seg = trimmed.slice(cur.end, nextStart ?? trimmed.length).trim();
		if (!seg) return null;
		segments.push(seg);
	}
	return segments;
}

/**
 * Translate regions with bounded concurrency. Invokes `onUpdate` after each
 * batch settles so the UI can paint overlays progressively.
 *
 * Continuation fragments are still chained, then cut into sentences on the
 * text-layer strings. Each sentence is one numbered unit. A sentence that
 * spans boxes is split back only within itself. If any sentence in a chain
 * fails, that chain does not store sentence pairs.
 */
export async function runLayoutRegionTranslate(options: {
	items: LayoutTranslateItem[];
	signal?: AbortSignal;
	concurrency?: number;
	onUpdate: (items: LayoutTranslateItem[]) => void;
	paperKey?: string | null;
	vaultPath?: string | null;
}): Promise<LayoutTranslateItem[]> {
	const started = performance.now();
	let firstResult = false;
	const agentOpts = await resolveLayoutTranslateAgentOpts({
		paperKey: options.paperKey,
		vaultPath: options.vaultPath,
	});
	// Agent is heavy — serialize; free/commercial MT keeps a small pool.
	const concurrency = Math.max(
		1,
		agentOpts ? 1 : (options.concurrency ?? LAYOUT_TRANSLATE_CONCURRENCY),
	);
	const items = options.items.map((it) => ({ ...it }));
	const signal = options.signal;
	const targetLang = langsFromSettings(
		loadSettings().translate,
		i18n.language ?? "en",
	).targetLang;

	type SentenceSlot = { state: "pending" | "ok" | "fail"; text: string };
	type ChainJob = {
		chain: LayoutTranslateChain;
		drafts: LayoutSentenceDraft[];
		slots: SentenceSlot[];
	};
	type SentenceUnit = {
		source: string;
		tokens: MaskedToken[];
		validateReflow?: (text: string) => boolean;
		job: ChainJob;
		draftIndex: number;
	};

	const units: SentenceUnit[] = [];
	for (const chain of buildLayoutTranslateChains(items).filter(
		chainNeedsTranslate,
	)) {
		const structural = chain.members[0]?.reflow;
		const drafts: LayoutSentenceDraft[] = structural
			? draftReflowSentences(structural)
			: draftChainSentences(chain.members);
		if (drafts.length === 0) {
			for (const member of chain.members) {
				member.status = "error";
				member.error = "Empty translation result";
				member.sentences = undefined;
			}
			continue;
		}
		const job: ChainJob = {
			chain,
			drafts,
			slots: drafts.map(() => ({ state: "pending", text: "" })),
		};
		drafts.forEach((draft, draftIndex) => {
			const masked = maskInlineTokens(draft.source);
			units.push({
				source: masked.text,
				tokens: masked.tokens,
				validateReflow: structural
					? reflowSentenceValidator(structural, draft)
					: undefined,
				job,
				draftIndex,
			});
		});
	}
	const batches = buildTranslateBatches(units);
	let nextBatch = 0;
	/** Consecutive transport failures; a success proves the endpoint is alive. */
	let transportFailures = 0;
	/** Set once the provider is deemed unreachable; short-circuits new requests. */
	let providerDown: string | null = null;

	const publish = () => {
		if (
			!firstResult &&
			items.some((i) => i.status === "done" && i.translated)
		) {
			firstResult = true;
			logger.info("pdf.translate.first-result", {
				duration_ms: Math.round(performance.now() - started),
			});
		}
		options.onUpdate(items.map((it) => ({ ...it })));
	};

	const translateText = async (
		text: string,
		pageIndex: number | undefined,
	): Promise<string> => {
		const parts: string[] = [];
		for (const chunk of splitTranslationChunks(
			text,
			LAYOUT_TRANSLATE_BATCH_CHARS,
		)) {
			if (signal?.aborted) return "";
			// The provider was already unreachable; a further request would only
			// spend another timeout on the same dead endpoint.
			if (providerDown) throw new Error(providerDown);
			let translated: string;
			try {
				translated = await runTranslate(
					{
						text: chunk,
						context: {
							page: pageIndex != null ? pageIndex + 1 : undefined,
							surface: "pdf-layout-bulk",
						},
					},
					agentOpts,
				);
			} catch (error) {
				const message = errorText(error);
				transportFailures = isTranslateTransportError(message)
					? transportFailures + 1
					: 0;
				if (transportFailures >= LAYOUT_TRANSLATE_PROVIDER_DOWN_FAILURES) {
					providerDown = message;
					logger.warn("pdf.translate.provider-down", {
						failures: transportFailures,
						error: message,
					});
				}
				throw error;
			}
			transportFailures = 0;
			if (!translated.trim()) throw new Error("Empty translation result");
			parts.push(translated.trim());
		}
		return joinTranslatedDisplays(parts, targetLang);
	};

	const pageOf = (unit: SentenceUnit) => unit.job.chain.members[0]?.pageIndex;

	// Only missing translations are content-recovery candidates. HTTP, network,
	// configuration and cancellation failures keep their existing handling.
	const isMissingTranslationResponse = (error: unknown) => {
		const message = errorText(error);
		return (
			message === "Empty translation result" ||
			message === "Unexpected Tencent Transmart translation response"
		);
	};
	const canRecoverProtectedResponse = (unit: SentenceUnit, error: unknown) =>
		!signal?.aborted &&
		isMissingTranslationResponse(error) &&
		unit.tokens.length > 0 &&
		/\p{L}/u.test(unit.source.replace(/⟦\d+⟧/gu, ""));

	/** Keep protected boundaries in source order and translate only their prose. */
	const translateProtectedSpans = async (
		unit: SentenceUnit,
		tokens: readonly MaskedToken[],
	): Promise<string> => {
		const protectedParts = unit.source.split(/(⟦\d+⟧)/u);
		const prose = protectedParts.flatMap((part, index) => {
			if (!part.trim() || /^⟦\d+⟧$/u.test(part) || !/\p{L}/u.test(part))
				return [];
			// Keep leading punctuation outside MT, which may echo the fragment.
			const leading = part.match(/^[\s.,;:!?。；，：！？)\]]*/u)?.[0] ?? "";
			return [{ index, leading, source: part.slice(leading.length) }];
		});
		for (const batch of buildTranslateBatches(prose)) {
			if (signal?.aborted) return "";
			let segments: string[] | null = null;
			try {
				const result = await translateText(
					buildNumberedPayload(batch),
					pageOf(unit),
				);
				segments = parseNumberedTranslation(result, batch.length);
			} catch (error) {
				if (signal?.aborted) return "";
				if (batch.length === 1 || !isMissingTranslationResponse(error))
					throw error;
			}
			for (const [index, part] of batch.entries()) {
				if (signal?.aborted) return "";
				protectedParts[part.index] =
					part.leading +
					(segments?.[index] ??
						(await translateText(part.source, pageOf(unit))));
			}
		}
		const segmented = restoreInlineTokens(
			protectedParts.join(" ").replace(/\s+/gu, " ").trim(),
			tokens,
		);
		if (
			!segmented.missing &&
			!segmented.invalid &&
			(!unit.validateReflow || unit.validateReflow(segmented.text))
		) {
			if (unit.validateReflow)
				unit.job.chain.members[0].reflowFallback = "protected-spans";
			return segmented.text;
		}
		throw new Error(i18n.t("viewer:pdf.layoutTranslate.invalidTokens"));
	};

	/** Retry with protection intact; never publish a corrupted formula/link. */
	const finalizeSentence = async (
		unit: SentenceUnit,
		segment: string,
		tokens: readonly MaskedToken[],
	): Promise<string> => {
		const restored = restoreInlineTokens(segment.trim(), tokens);
		const validateReflow = unit.validateReflow;
		if (
			restored.missing === 0 &&
			!restored.invalid &&
			(!validateReflow || validateReflow(restored.text))
		)
			return restored.text;
		if (signal?.aborted) return "";
		// A structural failure may recur with the same token spelling. Change
		// the spelling immediately instead of repeating the same request.
		let retry = restored;
		if (!validateReflow) {
			try {
				retry = restoreInlineTokens(
					await translateText(unit.source, pageOf(unit)),
					tokens,
				);
			} catch (error) {
				if (!canRecoverProtectedResponse(unit, error)) throw error;
				return translateProtectedSpans(unit, tokens);
			}
		}
		if (
			retry.missing ||
			retry.invalid ||
			(validateReflow && !validateReflow(retry.text))
		) {
			if (validateReflow) {
				// Some MT engines interpret a numeric placeholder as a number (e.g.
				// "factor of ⟦4⟧" becomes "4 倍"). Retry with nonnumeric opaque words.
				const aliases = tokens.map((token, index) => ({
					token: token.placeholder,
					alias: `ZXQ${index.toString(26).replace(/[0-9a-p]/g, (c) => String.fromCharCode(65 + Number.parseInt(c, 26)))}QXZ`,
				}));
				let protectedSource = unit.source;
				for (const { token, alias } of aliases)
					protectedSource = protectedSource.replaceAll(token, alias);
				let alternate = "";
				try {
					alternate = await translateText(protectedSource, pageOf(unit));
				} catch (error) {
					if (!canRecoverProtectedResponse(unit, error)) throw error;
				}
				for (const { token, alias } of aliases)
					alternate = alternate.replace(new RegExp(alias, "gi"), token);
				const restoredAlternate = restoreInlineTokens(alternate, tokens);
				if (
					!restoredAlternate.missing &&
					!restoredAlternate.invalid &&
					validateReflow(restoredAlternate.text)
				)
					return restoredAlternate.text;
				return translateProtectedSpans(unit, tokens);
			}
			throw new Error(i18n.t("viewer:pdf.layoutTranslate.invalidTokens"));
		}
		return retry.text;
	};

	const failUnit = (unit: SentenceUnit, error?: unknown) => {
		if (signal?.aborted) return;
		const slot = unit.job.slots[unit.draftIndex];
		if (!slot || slot.state === "ok") return;
		slot.state = "fail";
		slot.text = "";
		if (!error) return;
		const message = errorText(error);
		for (const member of unit.job.chain.members) {
			if (!member.error) member.error = message;
		}
	};

	const succeedUnit = (unit: SentenceUnit, text: string) => {
		const slot = unit.job.slots[unit.draftIndex];
		if (!slot) return;
		slot.state = "ok";
		slot.text = text.trim();
	};

	const paintJob = (job: ChainJob) => {
		if (signal?.aborted) return;
		if (job.slots.some((slot) => slot.state === "pending")) {
			const progress =
				job.slots.filter((slot) => slot.state !== "pending").length /
				job.slots.length;
			for (const member of job.chain.members) member.progress = progress;
			return;
		}
		const failed = job.slots.some((slot) => slot.state !== "ok");
		const painted = paintSentenceTranslations(
			job.drafts,
			job.slots.map((slot) => slot.text),
			job.chain.members.length,
			targetLang,
		);
		job.chain.members.forEach((member, index) => {
			const paint = painted[index];
			if (!failed && paint?.translated) {
				member.translated = paint.translated;
				member.sentences = paint.sentences;
				member.status = "done";
				member.error = undefined;
				return;
			}
			member.sentences = undefined;
			member.translated = undefined;
			member.status = "error";
			member.error = member.error || "Sentence translation failed";
		});
	};

	const translateSentence = async (unit: SentenceUnit) => {
		let raw: string | null;
		try {
			raw = await translateText(unit.source, pageOf(unit));
		} catch (error) {
			if (!canRecoverProtectedResponse(unit, error)) throw error;
			raw = null;
		}
		if (signal?.aborted) return;
		const text =
			raw === null
				? await translateProtectedSpans(unit, unit.tokens)
				: await finalizeSentence(unit, raw, unit.tokens);
		if (signal?.aborted) return;
		if (text) succeedUnit(unit, text);
		else failUnit(unit);
		paintJob(unit.job);
		publish();
	};

	const translateIndividually = async (batch: readonly SentenceUnit[]) => {
		for (const unit of batch) {
			if (signal?.aborted) return;
			try {
				await translateSentence(unit);
			} catch (error) {
				failUnit(unit, error);
				paintJob(unit.job);
				publish();
			}
		}
	};

	const translateSentenceBatch = async (batch: readonly SentenceUnit[]) => {
		const maskedUnits = batch.map((unit) => {
			return { unit, source: unit.source, tokens: unit.tokens };
		});
		let result: string;
		try {
			result = await translateText(
				buildNumberedPayload(maskedUnits),
				pageOf(batch[0] as SentenceUnit),
			);
		} catch (error) {
			if (!batch.some((unit) => canRecoverProtectedResponse(unit, error)))
				throw error;
			await translateIndividually(batch);
			return;
		}
		if (signal?.aborted) return;
		const segments = parseNumberedTranslation(result, batch.length);
		if (!segments) {
			await translateIndividually(batch);
			return;
		}
		const retries: {
			unit: SentenceUnit;
			segment: string;
			tokens: MaskedToken[];
		}[] = [];
		for (const [index, masked] of maskedUnits.entries()) {
			if (signal?.aborted) return;
			const segment = segments[index] ?? "";
			const restored = restoreInlineTokens(segment.trim(), masked.tokens);
			const validateReflow = masked.unit.validateReflow;
			if (
				restored.missing ||
				restored.invalid ||
				(validateReflow && !validateReflow(restored.text))
			) {
				retries.push({ ...masked, segment });
				continue;
			}
			succeedUnit(masked.unit, restored.text);
			paintJob(masked.unit.job);
			publish();
		}
		// Publish every valid paragraph before starting potentially slow repairs.
		for (const masked of retries) {
			if (signal?.aborted) return;
			try {
				const text = await finalizeSentence(
					masked.unit,
					masked.segment,
					masked.tokens,
				);
				if (text) succeedUnit(masked.unit, text);
				else failUnit(masked.unit);
			} catch (error) {
				failUnit(masked.unit, error);
			}
			// A slow protected-token retry in another paragraph must not hold
			// already valid results until the entire batch has settled.
			paintJob(masked.unit.job);
			publish();
		}
	};

	const jobsIn = (batch: readonly SentenceUnit[]): ChainJob[] => {
		const seen = new Set<ChainJob>();
		const out: ChainJob[] = [];
		for (const unit of batch) {
			if (seen.has(unit.job)) continue;
			seen.add(unit.job);
			out.push(unit.job);
		}
		return out;
	};

	const worker = async () => {
		while (true) {
			if (signal?.aborted) return;
			const b = nextBatch;
			nextBatch += 1;
			if (b >= batches.length) return;
			const batch = batches[b];
			if (!batch || batch.length === 0) continue;
			for (const unit of batch) {
				for (const member of unit.job.chain.members) {
					if (member.status !== "done") member.status = "running";
				}
			}
			publish();
			try {
				if (signal?.aborted) return;
				const only = batch[0];
				if (batch.length === 1 && only) await translateSentence(only);
				else await translateSentenceBatch(batch);
			} catch (error) {
				for (const unit of batch) failUnit(unit, error);
			}
			for (const job of jobsIn(batch)) paintJob(job);
			publish();
		}
	};

	const pool = Array.from(
		{ length: Math.min(concurrency, Math.max(1, batches.length)) },
		() => worker(),
	);
	await Promise.all(pool);

	if (signal?.aborted) {
		for (const it of items) {
			if (it.status === "pending" || it.status === "running") {
				it.status = "skipped";
			}
		}
		publish();
	}

	logger.info("pdf.translate.complete", {
		duration_ms: Math.round(performance.now() - started),
		cancelled: Boolean(signal?.aborted),
	});
	return items;
}
