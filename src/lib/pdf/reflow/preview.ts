import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { PDFDocument } from "pdf-lib";
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
	embedReflowFonts,
	type ReflowOutput,
} from "./export";
import { loadReflowFonts, type ReflowFontBytes } from "./fonts";
import { layoutReflowDocument } from "./layout";
import { prepareReflowItems, reflowDocumentFromItems } from "./service";
import type { PageLayout, ReflowDocument } from "./types";

type PageInput = { key: string; items: LayoutTranslateItem[]; ready: boolean };
type Preview = { key: string; url: string; layout: PageLayout };
type Job = { key: string; abort: AbortController };
/**
 * The dedicated build engine costs ~25–35 MB (PDFium worker + private source
 * copy). Keep it while translation is streaming, drop it once builds settle.
 */
const BUILD_ENGINE_IDLE_MS = 30_000;

/** Cap the preview raster DPR: 2x is enough for Retina at normal zoom. */
function previewDpr(): number {
	if (typeof window === "undefined") return 1;
	return Math.min(window.devicePixelRatio || 1, 2);
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
	private previews = new Map<number, Preview>();
	private jobs = new Map<number | "final", Job>();
	private attempted = new Map<number | "final", string>();
	private queue: Promise<void> = Promise.resolve();
	private finalKey = "";
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

	decorate(items: LayoutTranslateItem[]): LayoutTranslateItem[] {
		return items.map((item) => {
			const preview = this.previews.get(item.pageIndex);
			return {
				...item,
				reflowPreview: preview?.url,
				reflowLayout: preview?.layout.paragraphs.find((p) => p.id === item.id),
			};
		});
	}

	update(
		items: LayoutTranslateItem[],
		regions: PdfLayoutRegion[],
		running: boolean,
	): void {
		if (this.disposed) return;
		const regionsByPage = regionsByPageOf(regions);
		const groups = new Map<number, LayoutTranslateItem[]>();
		for (const item of items) {
			const group = groups.get(item.pageIndex) ?? [];
			group.push(item);
			groups.set(item.pageIndex, group);
		}
		this.inputs = new Map(
			[...groups].map(([index, group]) => [
				index,
				{
					// IR is immutable. Identity avoids serializing every glyph on every batch.
					key: JSON.stringify([
						group.map((i) => [
							i.id,
							i.status,
							i.source,
							i.translated,
							identity(i.reflow),
						]),
						(regionsByPage.get(index) ?? EMPTY_PAGE_REGIONS).map(identity),
					]),
					items: group,
					ready:
						group.every(
							(i) => i.status !== "pending" && i.status !== "running",
						) &&
						group.some(
							(i) => i.reflow && i.status === "done" && i.translated?.trim(),
						),
				},
			]),
		);
		const selected = items.filter(
			(i) => i.reflow && i.status === "done" && i.translated?.trim(),
		);
		const finalKey =
			!running && selected.length
				? JSON.stringify(
						[...this.inputs].map(([index, input]) => [index, input.key]),
					)
				: "";
		if (finalKey !== this.finalKey) {
			this.output = null;
			this.progress = 0;
			this.pages = null;
		}
		this.finalKey = finalKey;
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
			if (this.inputs.get(index)?.key !== preview.key) {
				URL.revokeObjectURL(preview.url);
				this.previews.delete(index);
				this.dirty = true;
			}
		}
		for (const index of this.attempted.keys()) {
			if (index === "final" ? !finalKey : !this.inputs.has(index))
				this.attempted.delete(index);
		}
		if (running) {
			this.cancelBuildIdle();
			// The same promise is shared with builders; a failure is reported by the job.
			void loadReflowFonts().catch(() => {});
			for (const [index, input] of this.inputs) {
				if (!input.ready || this.previews.has(index)) continue;
				this.enqueue(index, input.key, async (signal) => {
					const fonts = await loadReflowFonts();
					signal.throwIfAborted();
					const ir = reflowDocumentFromItems(
						this.document,
						input.items,
						regions,
					);
					const translations = new Map(
						input.items
							.filter((i) => i.status === "done" && i.translated?.trim())
							.map((i) => [i.id, i.translated ?? ""]),
					);
					// Page builds are never persisted: each one embeds the full
					// CJK font pair (~20 MB). Only the final document is cached.
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
				const ir = reflowDocumentFromItems(this.document, items, regions);
				const translations = new Map(
					selected.map((i) => [i.id, i.translated ?? ""]),
				);
				const cached = await this.cachedFinal(ir, translations, fonts, signal);
				if (cached) {
					await this.publish(this.engine, cached, signal, false, (ratio) =>
						report(0.8 + ratio * 0.19),
					);
					signal.throwIfAborted();
					this.output = cached.bytes;
					report(1, { done: ir.pages.length, total: ir.pages.length });
					return;
				}
				const target = await this.obtainBuild(signal);
				const built = await logOp("pdf.reflow.final", undefined, () =>
					buildReflowPdf(
						target.engine,
						target.document,
						ir,
						translations,
						fonts,
						signal,
						true,
						(ratio, pages) => report(ratio * 0.8, pages),
					),
				);
				await this.saveFinal(ir, translations, fonts, built.bytes);
				await this.publish(target.engine, built, signal, false, (ratio) =>
					report(0.8 + ratio * 0.19),
				);
				signal.throwIfAborted();
				this.output = built.bytes;
				report(1);
			});
		}
		this.notify();
	}

	/**
	 * Reuse a previously built final PDF when IR, translations, and fonts are
	 * unchanged. Layouts are recomputed in memory (cheap) so preview publishing
	 * works identically to a fresh build. Per-page builds are never cached:
	 * each embeds the full CJK font pair (~20 MB), which would dwarf the disk
	 * budget for a marginal win over the one-shot final entry.
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
			const embedded = await embedReflowFonts(
				await PDFDocument.create(),
				fonts,
			);
			return {
				bytes,
				pages: layoutReflowDocument(ir, translations, embedded, true),
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

	/** Dedicated build engine when available; the viewer pair is the fallback. */
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
		void loadReflowFonts().catch(() => {});
		this.cancelBuildIdle();
		const target = this.disposed
			? { engine: this.engine, document: this.document }
			: await this.obtainBuild(signal ?? new AbortController().signal);
		return logOp("pdf.reflow.prepare", { items: seed.length }, () =>
			prepareReflowItems(
				target.engine,
				target.document,
				seed,
				regions,
				signal,
				cache,
			),
		);
	}

	private scheduleBuildIdle(): void {
		if (!this.build || this.buildIdle !== undefined) return;
		this.buildIdle = setTimeout(() => {
			this.buildIdle = undefined;
			this.build?.idle();
		}, BUILD_ENGINE_IDLE_MS);
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
				if (!signal.aborted) this.failed(error);
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
	): Promise<void> {
		signal.throwIfAborted();
		const changed = built.pages.filter(
			(page) =>
				page.paragraphs.length &&
				JSON.stringify(this.previews.get(page.index)?.layout) !==
					JSON.stringify(page),
		);
		if (!changed.length) return;
		const preview = await engine
			.openDocumentBuffer({
				id: `reflow-preview-${crypto.randomUUID()}`,
				content: built.bytes.slice().buffer,
			})
			.toPromise();
		try {
			for (const [pageIndex, page] of changed.entries()) {
				signal.throwIfAborted();
				const blob = await logOp(
					"pdf.reflow.render",
					{ page: page.index },
					() =>
						engine
							.renderPage(preview, preview.pages[single ? 0 : page.index], {
								scaleFactor: 2,
								dpr: previewDpr(),
							})
							.toPromise(),
				);
				signal.throwIfAborted();
				const input = this.inputs.get(page.index);
				if (!input) continue;
				const previous = this.previews.get(page.index);
				this.previews.set(page.index, {
					key: input.key,
					url: URL.createObjectURL(blob),
					layout: page,
				});
				if (previous) URL.revokeObjectURL(previous.url);
				this.dirty = true;
				this.notify();
				onProgress?.((pageIndex + 1) / changed.length);
			}
		} finally {
			await engine.closeDocument(preview).toPromise();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancelBuildIdle();
		this.build?.dispose();
		for (const job of this.jobs.values()) job.abort.abort();
		this.jobs.clear();
		for (const preview of this.previews.values())
			URL.revokeObjectURL(preview.url);
		this.previews.clear();
		this.output = null;
	}
}
