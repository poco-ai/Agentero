import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { logger, logOp } from "@/lib/core/logger";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import type { ReflowBuildCacheStore } from "./build-cache";
import type { ReflowBuildProvider, ReflowBuildTarget } from "./builder";
import type { ReflowIrCacheStore } from "./cache";
import {
	buildReflowPage,
	buildReflowPdf,
	interleaveReflowPdf,
	layoutReflowPdf,
	type ReflowOutput,
	replaceReflowPages,
} from "./export";
import { loadReflowFonts, type ReflowFontBytes } from "./fonts";
import {
	type ReflowOutputVersion,
	reflowOutputVersion,
} from "./output-version";
import { prepareReflowItems, reflowDocumentFromItems } from "./service";
import type { PageLayout, Paragraph, ReflowDocument } from "./types";

type PageInput = {
	key: string;
	sourceKey: string;
	items: LayoutTranslateItem[];
	ready: boolean;
};
type Preview = {
	key: string;
	sourceKey: string;
	url: string;
	blob: Blob;
	layout: PageLayout;
	items: LayoutTranslateItem[];
	/** Output byte versions whose page contains this exact preview. */
	outputSources: WeakSet<ReflowOutputVersion>;
};
type Job = { key: string; abort: AbortController };
const BUILD_DOCUMENT_IDLE_MS = 5_000;

// Hold at most one warm result per reader window, including its fallback images.
const RECENT_FINAL_MAX_BYTES = 64 * 1024 * 1024;
let recentFinal: {
	key: string;
	output: ReflowOutput;
	rasters: ReadonlyMap<number, Blob>;
} | null = null;

/** Cap the preview raster DPR: 2x is enough for Retina at normal zoom. */
function previewDpr(): number {
	if (typeof window === "undefined") return 1;
	return Math.min(window.devicePixelRatio || 1, 2);
}

/**
 * A4 at 2x scale on a Retina display allocates a 32 MB bitmap. On long papers
 * those allocations land after dozens of page builds and can exhaust the
 * PDFium wasm heap. Keep each preview under a fixed budget and let quality
 * fall back on unusually large pages.
 */
const PREVIEW_MAX_BITMAP_BYTES = 16 * 1024 * 1024;
const PREVIEW_SCALE = 2;
const PREVIEW_MIN_SCALE = 0.5;

export function previewRasterScale(
	page: { width: number; height: number },
	dpr: number,
): number {
	const area = Math.max(1, page.width * page.height);
	const cap = Math.sqrt(PREVIEW_MAX_BITMAP_BYTES / 4 / area);
	return Math.max(
		PREVIEW_MIN_SCALE,
		Math.min(PREVIEW_SCALE, cap / Math.max(1, dpr)),
	);
}

export function isRasterAllocationError(error: unknown): boolean {
	const text = (
		error &&
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
			? error.message
			: errorText(error)
	).toLowerCase();
	return (
		text.includes("failed to allocate") ||
		text.includes("out of memory") ||
		text.includes("total memory usage would exceed")
	);
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | undefined): number {
	if (!value) return 0;
	let id = identities.get(value);
	if (id === undefined) {
		id = ++nextIdentity;
		identities.set(value, id);
	}
	return id;
}

/** Import from the caller so `regions ?? NO_REGIONS` keeps one array identity. */
export const NO_REGIONS: PdfLayoutRegion[] = [];
const EMPTY_PAGE_REGIONS: PdfLayoutRegion[] = [];
const regionsByPageCache = new WeakMap<
	PdfLayoutRegion[],
	Map<number, PdfLayoutRegion[]>
>();
/**
 * Group regions per page once per regions-array identity. Region objects are
 * immutable within one array, so their identity numbers form the page part of
 * the input key without re-serializing every region on every batch.
 */
function regionsByPageOf(
	regions: PdfLayoutRegion[],
): Map<number, PdfLayoutRegion[]> {
	let grouped = regionsByPageCache.get(regions);
	if (!grouped) {
		grouped = new Map();
		for (const region of regions) {
			const list = grouped.get(region.pageIndex) ?? [];
			list.push(region);
			grouped.set(region.pageIndex, list);
		}
		regionsByPageCache.set(regions, grouped);
	}
	return grouped;
}

/** One serial queue per open document; unrelated batches never cancel a ready page. */
export class ReflowPreviewSession {
	private inputs = new Map<number, PageInput>();
	private paragraphKeys = new WeakMap<Paragraph, number>();
	private previews = new Map<number, Preview>();
	private jobs = new Map<number | "final", Job>();
	private attempted = new Map<number | "final", string>();
	private queue: Promise<void> = Promise.resolve();
	private finalKey = "";
	private pageOnly = false;
	private preparing = 0;
	private lifetime = new AbortController();
	/**
	 * Set when the last final build failed. Page previews will not arrive until
	 * the inputs change, so callers must not wait for them.
	 */
	private finalBuildFailed = false;
	private outputKey = "";
	private outputInputs = new Map<number, PageInput>();
	private outputLayouts: PageLayout[] = [];
	private disposed = false;
	private buildIdle: ReturnType<typeof setTimeout> | undefined;
	/** Set when decorated state (previews, busy, output) changed since the last notify. */
	private dirty = false;
	output: Uint8Array | null = null;
	progress = 0;
	/** Pages built so far in the current final pass; cleared by a rebuild. */
	pages: { done: number; total: number } | null = null;

	constructor(
		private engine: PdfEngine,
		readonly document: PdfDocumentObject,
		private changed: () => void,
		private failed: (error: unknown) => void,
		/** Builds run on this dedicated engine so scroll rendering keeps the viewer queue. */
		private build?: ReflowBuildProvider,
		/** Finished-build cache: skips PDFium redaction + font embedding on repeats. */
		private buildCache?: ReflowBuildCacheStore | null,
	) {}

	/** The retained display may be older while a replacement is building. */
	get ready(): boolean {
		if (this.pageOnly) {
			const translated = [...this.inputs].filter(([, input]) => input.ready);
			return (
				translated.length > 0 &&
				translated.every(
					([index, input]) => this.previews.get(index)?.key === input.key,
				)
			);
		}
		return Boolean(
			this.output && this.finalKey && this.outputKey === this.finalKey,
		);
	}

	/** A failed final build retracts page/paragraph loading until inputs change. */
	get finalFailed(): boolean {
		return this.finalBuildFailed;
	}

	/**
	 * Drop in-flight page / final builds without touching published previews or
	 * the retained export output. Used when the reader stops page generation
	 * after the translation job already settled: that build is local work, so
	 * only this session can end it. Same inputs are not enqueued again until
	 * they change (`attempted` keeps the key).
	 */
	cancelBuilds(): void {
		if (this.disposed) return;
		if (!this.jobs.size && this.buildIdle === undefined) return;
		for (const job of this.jobs.values()) job.abort.abort();
		this.jobs.clear();
		this.cancelBuildIdle();
		this.dirty = true;
		this.notify();
		this.scheduleBuildIdle();
	}

	get busy(): boolean {
		return this.jobs.size > 0;
	}

	/**
	 * `update()` runs on every coalesced translation batch. Notifying then would
	 * re-decorate all items while nothing preview-visible changed; only a
	 * preview publish/revoke, a busy transition, or a new export output does.
	 */
	private notify(): void {
		if (this.disposed || !this.dirty) return;
		this.dirty = false;
		this.changed();
	}

	private paragraphKey(
		paragraph: Paragraph | undefined,
		previous: Paragraph | undefined,
	): number {
		if (!paragraph) return 0;
		const known = this.paragraphKeys.get(paragraph);
		if (known !== undefined) return known;
		// Preparation can rehydrate identical IR into new objects. Compare only
		// those replacements, then retain a compact identity. Keeping serialized
		// glyphs in page/final keys multiplies memory and work on every update.
		const key =
			previous && JSON.stringify(paragraph) === JSON.stringify(previous)
				? (this.paragraphKeys.get(previous) ?? identity(previous))
				: identity(paragraph);
		this.paragraphKeys.set(paragraph, key);
		return key;
	}

	decorate(items: LayoutTranslateItem[]): LayoutTranslateItem[] {
		return items.map((item) => {
			const preview = this.previews.get(item.pageIndex);
			const displayed = preview?.items.find((entry) => entry.id === item.id);
			return {
				...item,
				...(displayed && {
					translated: displayed.translated,
					sentences: displayed.sentences,
					reflow: displayed.reflow,
				}),
				reflowPreview: preview?.url,
				reflowLayout: preview?.layout.paragraphs.find((p) => p.id === item.id),
				reflowPreviewSources: preview?.outputSources,
			};
		});
	}

	update(
		items: LayoutTranslateItem[],
		regions: PdfLayoutRegion[],
		running: boolean,
		pageOnly = false,
	): void {
		if (this.disposed) return;
		this.pageOnly = pageOnly;
		const regionsByPage = regionsByPageOf(regions);
		const groups = new Map<number, LayoutTranslateItem[]>();
		for (const item of items) {
			const group = groups.get(item.pageIndex) ?? [];
			group.push(item);
			groups.set(item.pageIndex, group);
		}
		this.inputs = new Map(
			[...groups].map(([index, group]) => {
				const current = new Map(
					this.inputs.get(index)?.items.map((item) => [item.id, item]),
				);
				const previous = new Map(
					(this.pageOnly
						? (this.previews.get(index)?.items ??
							this.outputInputs.get(index)?.items)
						: this.outputInputs.get(index)?.items
					)?.map((item) => [item.id, item]),
				);
				// A retranslation keeps the last successful text visible until a
				// completed replacement arrives, including after cancellation.
				const effective = group.map((item) => {
					if (item.status === "done") return item;
					const retained = previous.get(item.id);
					return retained?.source === item.source && retained.translated?.trim()
						? {
								...item,
								status: "done" as const,
								translated: retained.translated,
								sentences: retained.sentences,
							}
						: item;
				});
				return [
					index,
					{
						key: JSON.stringify([
							effective.map((i) => [
								i.id,
								i.source,
								i.status === "done" ? i.translated : undefined,
								this.paragraphKey(
									i.reflow,
									current.get(i.id)?.reflow ?? previous.get(i.id)?.reflow,
								),
							]),
							(regionsByPage.get(index) ?? EMPTY_PAGE_REGIONS).map(identity),
						]),
						sourceKey: JSON.stringify([
							group.map((i) => [i.id, i.source]),
							(regionsByPage.get(index) ?? EMPTY_PAGE_REGIONS).map(identity),
						]),
						items: effective,
						ready:
							group.every(
								(i) => i.status !== "pending" && i.status !== "running",
							) &&
							group.some(
								(i) => i.reflow && i.status === "done" && i.translated?.trim(),
							),
					},
				] as const;
			}),
		);
		const effectiveItems =
			!running && !pageOnly
				? [...this.inputs.values()].flatMap((input) => input.items)
				: [];
		const selected = effectiveItems.filter(
			(item) =>
				item.reflow && item.status === "done" && item.translated?.trim(),
		);
		const finalKey =
			!running && !pageOnly && selected.length
				? JSON.stringify(
						[...this.inputs].map(([index, input]) => [index, input.key]),
					)
				: "";
		if (finalKey !== this.finalKey) {
			this.progress = 0;
			this.pages = null;
			this.finalBuildFailed = false;
			this.dirty = true;
		}
		this.finalKey = finalKey;
		if (!items.length) {
			this.output = null;
			this.outputKey = "";
			this.outputInputs.clear();
			this.outputLayouts = [];
		}
		for (const [index, job] of this.jobs) {
			const key = index === "final" ? finalKey : this.inputs.get(index)?.key;
			if (key !== job.key) {
				job.abort.abort();
				this.jobs.delete(index);
				this.attempted.delete(index);
				this.dirty = true;
			}
		}
		for (const [index, preview] of this.previews) {
			if (this.inputs.get(index)?.sourceKey !== preview.sourceKey) {
				URL.revokeObjectURL(preview.url);
				this.previews.delete(index);
				this.dirty = true;
			}
		}
		for (const index of this.attempted.keys()) {
			if (index === "final" ? !finalKey : !this.inputs.has(index))
				this.attempted.delete(index);
		}
		if (running || pageOnly) {
			for (const [index, input] of this.inputs) {
				if (!input.ready || this.previews.get(index)?.key === input.key)
					continue;
				this.enqueue(index, input.key, async (signal) => {
					const fonts = await loadReflowFonts();
					signal.throwIfAborted();
					const ir = reflowDocumentFromItems(
						this.document,
						input.items,
						regionsByPage.get(index) ?? EMPTY_PAGE_REGIONS,
					);
					const translations = new Map(
						input.items
							.filter((i) => i.status === "done" && i.translated?.trim())
							.map((i) => [i.id, i.translated ?? ""]),
					);
					const target = await this.obtainBuild(signal);
					const built = await logOp("pdf.reflow.page", { page: index }, () =>
						buildReflowPage(
							target.engine,
							target.document,
							ir,
							translations,
							fonts,
							signal,
						),
					);
					await this.publish(target.engine, built, signal, true);
				});
			}
			if (!this.jobs.size) this.scheduleBuildIdle();
		} else if (finalKey) {
			this.enqueue("final", finalKey, async (signal) => {
				const report = (
					ratio: number,
					pages?: { done: number; total: number },
				) => {
					if (signal.aborted || this.disposed || this.finalKey !== finalKey)
						return;
					const next = Math.floor(ratio * 100) / 100;
					const pageGrew = pages ? pages.done > (this.pages?.done ?? 0) : false;
					if (pages) this.pages = pages;
					if (next <= this.progress && !pageGrew) return;
					this.progress = Math.max(this.progress, next);
					this.dirty = true;
					this.notify();
				};
				const fonts = await loadReflowFonts();
				signal.throwIfAborted();
				// Retain untranslated IR paragraphs as obstacles (including fallback text).
				const ir = reflowDocumentFromItems(
					this.document,
					effectiveItems,
					regions,
				);
				const translations = new Map(
					selected.map((i) => [i.id, i.translated ?? ""]),
				);
				const previousOutput = this.output;
				const incremental = Boolean(
					previousOutput &&
						[...this.outputInputs].every(
							([index, input]) =>
								this.inputs.get(index)?.sourceKey === input.sourceKey,
						),
				);
				const changedPages = incremental
					? ir.pages.filter(
							(page) =>
								this.outputInputs.get(page.index)?.key !==
								this.inputs.get(page.index)?.key,
						)
					: ir.pages;
				const finish = (bytes: Uint8Array, layouts: PageLayout[]) => {
					signal.throwIfAborted();
					this.output = bytes;
					this.outputKey = finalKey;
					this.outputInputs = new Map(this.inputs);
					this.outputLayouts = layouts;
					this.finalBuildFailed = false;
					// Unchanged previews also belong to the retained display. A changed
					// preview belongs only to outputs assembled after it was published.
					const version = reflowOutputVersion(bytes);
					for (const page of layouts) {
						if (this.previewMatches(page))
							this.previews.get(page.index)?.outputSources.add(version);
					}
					report(1);
				};
				if (incremental && !changedPages.length && previousOutput) {
					finish(previousOutput, this.outputLayouts);
					return;
				}
				const cacheKey = incremental
					? null
					: await this.buildCache
							?.keyForFinal?.(ir, translations, fonts)
							.catch(() => null);
				signal.throwIfAborted();
				const warm =
					cacheKey && recentFinal?.key === cacheKey ? recentFinal : null;
				// Incremental pages retain the previous document's other layouts.
				// The disk cache describes a full common-scale build, so only full
				// builds read/write it; partial results stay in this live session.
				const cached =
					warm?.output ??
					(incremental
						? null
						: await this.cachedFinal(ir, translations, fonts, signal));
				if (cached) {
					if (warm) {
						for (const page of cached.pages) {
							const blob = warm.rasters.get(page.index);
							if (blob) this.setPreview(page, blob, cached.bytes);
						}
					}
					const target = await this.obtainBuild(signal);
					let opened = false;
					try {
						await this.publish(
							target.engine,
							cached,
							signal,
							false,
							undefined,
							() => {
								finish(cached.bytes, cached.pages);
								opened = true;
							},
						);
						if (cacheKey) this.rememberFinal(cacheKey, cached);
						return;
					} catch (error) {
						signal.throwIfAborted();
						logger.warn("pdf.reflow.buildCache preview failed", {
							error: errorText(error),
						});
						// The display document can still render when only a fallback image failed.
						if (opened) return;
					}
				}
				const target = await this.obtainBuild(signal);
				const built = await logOp("pdf.reflow.final", undefined, () =>
					buildReflowPdf(
						target.engine,
						target.document,
						{ ...ir, pages: changedPages },
						translations,
						fonts,
						signal,
						!incremental,
						(ratio, pages) => report(ratio * 0.8, pages),
					),
				);
				if (incremental && previousOutput) {
					const bytes = await replaceReflowPages(
						previousOutput,
						built.bytes,
						changedPages.map((page) => page.index),
						signal,
					);
					signal.throwIfAborted();
					const changed = new Map(
						built.pages.map((page) => [page.index, page]),
					);
					const layouts = ir.pages.map(
						(page) =>
							changed.get(page.index) ??
							this.outputLayouts.find(
								(layout) => layout.index === page.index,
							) ?? {
								index: page.index,
								width: page.width,
								height: page.height,
								paragraphs: [],
							},
					);
					await this.publish(target.engine, built, signal, false, (ratio) =>
						report(0.8 + ratio * 0.19),
					);
					finish(bytes, layouts);
				} else {
					await this.publish(target.engine, built, signal, false, (ratio) =>
						report(0.8 + ratio * 0.19),
					);
					finish(built.bytes, built.pages);
					if (cacheKey) this.rememberFinal(cacheKey, built);
					await this.saveFinal(ir, translations, fonts, built.bytes);
				}
			});
		}
		this.notify();
	}

	private rememberFinal(key: string, output: ReflowOutput): void {
		let size = output.bytes.byteLength;
		if (size > RECENT_FINAL_MAX_BYTES) return;
		const version = reflowOutputVersion(output.bytes);
		const rasters = new Map<number, Blob>();
		for (const page of output.pages) {
			if (!page.paragraphs.length) continue;
			const preview = this.previews.get(page.index);
			if (!preview?.outputSources.has(version)) continue;
			if (size + preview.blob.size > RECENT_FINAL_MAX_BYTES) continue;
			size += preview.blob.size;
			rasters.set(page.index, preview.blob);
		}
		recentFinal = { key, output, rasters };
	}

	private async exportBytes(
		regions: PdfLayoutRegion[],
	): Promise<Uint8Array | null> {
		if (!this.ready || this.disposed) return null;
		if (!this.pageOnly) return this.output;
		const snapshot = this.inputs;
		const items = [...snapshot.values()].flatMap((input) => input.items);
		const translations = new Map(
			items
				.filter((item) => item.status === "done" && item.translated?.trim())
				.map((item) => [item.id, item.translated ?? ""]),
		);
		const signal = this.lifetime.signal;
		this.preparing += 1;
		this.cancelBuildIdle();
		try {
			const fonts = await loadReflowFonts();
			signal.throwIfAborted();
			const target = await this.obtainBuild(signal);
			const ir = reflowDocumentFromItems(this.document, items, regions);
			const built = await logOp(
				"pdf.reflow.export",
				{ pages: ir.pages.length },
				() =>
					buildReflowPdf(
						target.engine,
						target.document,
						ir,
						translations,
						fonts,
						signal,
						false,
					),
			);
			return this.pageOnly && this.matchesInputs(snapshot) ? built.bytes : null;
		} finally {
			this.preparing -= 1;
			this.scheduleBuildIdle();
		}
	}

	async exportPdf(
		regions: PdfLayoutRegion[],
		dual: boolean,
	): Promise<Uint8Array | null> {
		const snapshot = this.inputs;
		const output = await this.exportBytes(regions);
		if (!output || !this.matchesInputs(snapshot) || !this.ready) return null;
		if (!dual) return output;
		const signal = this.lifetime.signal;
		signal.throwIfAborted();
		const original = new Uint8Array(
			await this.engine.saveAsCopy(this.document).toPromise(),
		);
		const bytes = await interleaveReflowPdf(original, output, signal);
		return this.matchesInputs(snapshot) && this.ready ? bytes : null;
	}

	private matchesInputs(snapshot: Map<number, PageInput>): boolean {
		return (
			snapshot.size === this.inputs.size &&
			[...snapshot].every(
				([index, input]) => this.inputs.get(index)?.key === input.key,
			)
		);
	}

	/**
	 * Reuse a previously built final PDF when IR, translations, and fonts are
	 * unchanged. Layout metrics are recomputed in the worker for the overlay.
	 */
	private async cachedFinal(
		ir: ReflowDocument,
		translations: Map<string, string>,
		fonts: ReflowFontBytes,
		signal: AbortSignal,
	): Promise<ReflowOutput | null> {
		const cache = this.buildCache;
		if (!cache) return null;
		try {
			const bytes = await logOp(
				"pdf.reflow.buildCache",
				{ phase: "read" },
				() => cache.readFinal(ir, translations, fonts),
			);
			signal.throwIfAborted();
			if (!bytes) {
				logger.info("pdf.reflow.buildCache", { result: "miss" });
				return null;
			}
			logger.info("pdf.reflow.buildCache", {
				result: "hit",
				bytes: bytes.byteLength,
			});
			// Layout metrics are recomputed in memory against the same embedded
			// fonts, so overlays match the cached render without rebuilding it.
			return {
				bytes,
				pages: await layoutReflowPdf(ir, translations, fonts, signal),
			};
		} catch (error) {
			if (signal.aborted) throw error;
			logger.warn("pdf.reflow.buildCache read failed", {
				error: errorText(error),
			});
			return null;
		}
	}

	/** Best-effort persistence of a freshly built final PDF; never fails the job. */
	private saveFinal(
		ir: ReflowDocument,
		translations: Map<string, string>,
		fonts: ReflowFontBytes,
		bytes: Uint8Array,
	): Promise<void> {
		const cache = this.buildCache;
		if (!cache || cache.writesEnabled?.() === false) return Promise.resolve();
		return logOp("pdf.reflow.buildCache", { phase: "write" }, async () => {
			try {
				await cache.writeFinal(ir, translations, fonts, bytes);
			} catch (error) {
				logger.warn("pdf.reflow.buildCache write failed", {
					error: errorText(error),
				});
			}
		}).then(() => {});
	}

	/** Background build document when available; the viewer pair is the fallback. */
	private async obtainBuild(signal: AbortSignal): Promise<ReflowBuildTarget> {
		if (!this.build) return { engine: this.engine, document: this.document };
		return this.build.get(signal);
	}

	/** Start extraction on the dedicated engine so prepare stays off the viewer queue too. */
	async prepare(
		seed: LayoutTranslateItem[],
		regions: PdfLayoutRegion[],
		signal?: AbortSignal,
		cache?: ReflowIrCacheStore | null,
	): Promise<LayoutTranslateItem[]> {
		const activeSignal = signal
			? AbortSignal.any([signal, this.lifetime.signal])
			: this.lifetime.signal;
		this.preparing += 1;
		this.cancelBuildIdle();
		try {
			activeSignal.throwIfAborted();
			return await logOp("pdf.reflow.prepare", { items: seed.length }, () =>
				prepareReflowItems(
					this.engine,
					this.document,
					seed,
					regions,
					activeSignal,
					cache,
					() => this.obtainBuild(activeSignal),
				),
			);
		} finally {
			this.preparing -= 1;
			this.scheduleBuildIdle();
		}
	}

	private scheduleBuildIdle(): void {
		if (
			this.disposed ||
			this.preparing ||
			this.jobs.size ||
			!this.build ||
			this.buildIdle !== undefined
		)
			return;
		this.buildIdle = setTimeout(() => {
			this.buildIdle = undefined;
			this.build?.idle();
		}, BUILD_DOCUMENT_IDLE_MS);
	}

	private cancelBuildIdle(): void {
		if (this.buildIdle === undefined) return;
		clearTimeout(this.buildIdle);
		this.buildIdle = undefined;
	}

	private enqueue(
		index: number | "final",
		key: string,
		run: (signal: AbortSignal) => Promise<void>,
	): void {
		if (this.attempted.get(index) === key) return;
		this.attempted.set(index, key);
		if (this.pageOnly) this.finalBuildFailed = false;
		const job = { key, abort: new AbortController() };
		this.jobs.set(index, job);
		this.dirty = true;
		// A pending idle deadline would release the dedicated engine (and its
		// private document) out from under this build; every in-flight PDFium
		// RPC then never settles and wedges the serial queue (hide → rebuild).
		this.cancelBuildIdle();
		this.queue = this.queue.then(async () => {
			const signal = job.abort.signal;
			try {
				signal.throwIfAborted();
				await run(signal);
			} catch (error) {
				if (!signal.aborted) {
					if (index === "final" || this.pageOnly) this.finalBuildFailed = true;
					this.failed(error);
				}
			} finally {
				if (this.jobs.get(index) === job) this.jobs.delete(index);
				if (!this.disposed) {
					// Busy / output may have transitioned even when the job aborted.
					this.dirty = true;
					this.notify();
					// Queue drained: the dedicated engine can settle down.
					if (!this.jobs.size) this.scheduleBuildIdle();
				}
			}
		});
	}

	private async publish(
		engine: PdfEngine,
		built: ReflowOutput,
		signal: AbortSignal,
		single: boolean,
		onProgress?: (ratio: number) => void,
		onOpened?: () => void,
	): Promise<void> {
		signal.throwIfAborted();
		const changed = built.pages.filter(
			(page) => page.paragraphs.length && !this.previewMatches(page),
		);
		if (!changed.length) {
			onOpened?.();
			return;
		}
		const preview = await engine
			.openDocumentBuffer({
				id: `reflow-preview-${crypto.randomUUID()}`,
				content: built.bytes.slice().buffer,
			})
			.toPromise();
		try {
			signal.throwIfAborted();
			onOpened?.();
			for (const [pageIndex, page] of changed.entries()) {
				signal.throwIfAborted();
				const blob = await logOp(
					"pdf.reflow.render",
					{ page: page.index },
					() =>
						this.renderPreview(
							engine,
							preview,
							preview.pages[single ? 0 : page.index],
							signal,
						),
				);
				signal.throwIfAborted();
				this.setPreview(page, blob, onOpened ? built.bytes : undefined);
				this.notify();
				onProgress?.((pageIndex + 1) / changed.length);
			}
		} finally {
			await engine.closeDocument(preview).toPromise();
		}
	}

	private previewMatches(page: PageLayout): boolean {
		const preview = this.previews.get(page.index);
		return Boolean(
			preview &&
				preview.key === this.inputs.get(page.index)?.key &&
				(preview.layout === page ||
					JSON.stringify(preview.layout) === JSON.stringify(page)),
		);
	}

	private setPreview(page: PageLayout, blob: Blob, output?: Uint8Array): void {
		const input = this.inputs.get(page.index);
		if (!input) return;
		const previous = this.previews.get(page.index);
		const outputSources = new WeakSet<ReflowOutputVersion>();
		if (output) outputSources.add(reflowOutputVersion(output));
		this.previews.set(page.index, {
			key: input.key,
			sourceKey: input.sourceKey,
			outputSources,
			url: URL.createObjectURL(blob),
			blob,
			layout: page,
			items: input.items,
		});
		if (previous) URL.revokeObjectURL(previous.url);
		this.dirty = true;
	}

	private async renderPreview(
		engine: PdfEngine,
		document: PdfDocumentObject,
		page: Parameters<PdfEngine["renderPage"]>[1],
		signal: AbortSignal,
	): Promise<Blob> {
		const dpr = previewDpr();
		const scale = previewRasterScale(page.size, dpr);
		const attempts = [...new Set([scale, Math.max(0.25, scale / 2)])];
		for (const [index, scaleFactor] of attempts.entries()) {
			try {
				return await engine
					.renderPage(document, page, { scaleFactor, dpr })
					.toPromise();
			} catch (error) {
				signal.throwIfAborted();
				if (index === attempts.length - 1 || !isRasterAllocationError(error))
					throw error;
				logger.warn("pdf.reflow.render retry", {
					page: page.index,
					scaleFactor,
					error:
						error &&
						typeof error === "object" &&
						"message" in error &&
						typeof error.message === "string"
							? error.message
							: errorText(error),
				});
			}
		}
		throw new Error("Preview render retry exhausted");
	}

	dispose(): void {
		this.disposed = true;
		this.lifetime.abort();
		this.cancelBuildIdle();
		this.build?.dispose();
		for (const job of this.jobs.values()) job.abort.abort();
		this.jobs.clear();
		for (const preview of this.previews.values())
			URL.revokeObjectURL(preview.url);
		this.previews.clear();
		this.inputs.clear();
		this.outputInputs.clear();
		this.outputLayouts = [];
		this.output = null;
	}
}
