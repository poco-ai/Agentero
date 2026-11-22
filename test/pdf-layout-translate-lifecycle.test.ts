// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type UsePdfLayoutTranslateOptions,
	usePdfLayoutTranslate,
} from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import {
	type BackgroundTask,
	backgroundTasksStore,
} from "@/lib/core/background-tasks";
import type { JobSnapshot } from "@/lib/core/bindings";
import type { PdfLayoutSidecar } from "@/lib/pdf/layout/io";
import { LAYOUT_TEXT_ORDER_VERSION } from "@/lib/pdf/layout/io";
import type { LayoutTranslateSidecar } from "@/lib/pdf/layout/layout-translate";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";
import type { TranslationSnapshot } from "@/lib/pdf/layout/translation-job";
import type {
	LayoutTranslateCacheKey,
	LayoutTranslateItem,
	PdfLayoutDocumentResult,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { type Deferred, deferred } from "./helpers/deferred";
import { mountHook } from "./helpers/mount";

// Drive the real orchestration hook with real React and the real pure layout
// helpers (hydrate / sidecar apply / grouping / exclusions / progress). Only
// IO boundaries are mocked: sidecar reads/writes, the translation runner, the
// shared JobCenter subscription, layout enqueue, reflow preparation and toasts.
type Run = {
	items: LayoutTranslateItem[];
	signal: AbortSignal;
	onUpdate: (items: LayoutTranslateItem[]) => void;
	resolve: (items: LayoutTranslateItem[]) => void;
	reject: (error: unknown) => void;
};
type Observer = {
	start: boolean;
	force?: boolean;
	forceLayout?: boolean;
	purpose?: "complete";
	signal: AbortSignal;
	onUpdate: (job: JobSnapshot, snapshot: TranslationSnapshot | null) => void;
	onJob?: (jobId: string) => void;
};
type EnqueueRequest = {
	paperAbsPath: string;
	focus: boolean;
	onError: (error: unknown) => void;
};
type SidecarEntry = { id: string; source: string; translated: string };

const io = vi.hoisted(() => ({
	runs: [] as Run[],
	observers: [] as Observer[],
	writes: [] as unknown[][],
	flushes: [] as unknown[][],
	errors: [] as unknown[][],
	warnings: [] as unknown[][],
	dismissed: [] as unknown[][],
	enqueues: [] as EnqueueRequest[],
	cancels: [] as string[],
	openSettings: [] as string[],
	publishedLayouts: [] as PdfLayoutDocumentResult[],
	layoutWrites: new Set<(path: string) => void>(),
	cachedLayout: null as PdfLayoutSidecar | null,
	cachedLayoutReadGate: null as Deferred | null,
	translateSidecar: null as LayoutTranslateSidecar | null,
	sharedJob: null as JobSnapshot | null,
	sharedSnapshot: null as TranslationSnapshot | null,
	sharedGate: null as Deferred | null,
	prepareGate: null as Deferred | null,
	prepareTransform: null as
		| ((items: LayoutTranslateItem[]) => LayoutTranslateItem[])
		| null,
	reflowInput: [] as LayoutTranslateItem[],
	cacheKey: {
		providerId: "tencenttransmart",
		sourceLang: "en",
		targetLang: "zh",
		serviceKey: "test",
	} as LayoutTranslateCacheKey,
}));

vi.mock("react-i18next", async () => ({
	...(await import("./helpers/i18n")),
	// The real `@/i18n` bootstrap (loaded by layout modules) needs this plugin.
	initReactI18next: { type: "3rdParty", init() {} },
}));

vi.mock("@/components/viewer/pdf/hooks/use-pdf-reflow", () => {
	// Stable identity like the real useCallback: the pane hydrate effect lists
	// `prepare` in its deps and would re-run on every render otherwise.
	const prepare = async (next: LayoutTranslateItem[]) => {
		if (io.prepareGate) await io.prepareGate.promise;
		return io.prepareTransform ? io.prepareTransform(next) : next;
	};
	const exportTranslatedPdf = async () => {};
	return {
		usePdfReflow: (
			_context: unknown,
			_regions: unknown,
			items: LayoutTranslateItem[],
		) => {
			io.reflowInput = items;
			return {
				reflowItems: items,
				reflowBusy: false,
				reflowReady: false,
				reflowOutput: null,
				reflowPages: null,
				prepare,
				exportTranslatedPdf,
			};
		},
	};
});

vi.mock("@/lib/pdf/layout/translation-job", () => ({
	observePaperTranslation: async (observer: Observer) => {
		io.observers.push(observer);
		if (io.sharedGate) await io.sharedGate.promise;
		if (io.sharedJob) observer.onJob?.(io.sharedJob.id);
		if (!io.sharedJob || observer.signal.aborted) return null;
		observer.onUpdate(io.sharedJob, io.sharedSnapshot);
		return { jobId: io.sharedJob.id, dispose() {} };
	},
}));

vi.mock("@/lib/core/tasks", async (importOriginal) => ({
	...(await importOriginal<object>()),
	cancelTask: (id: string) => {
		io.cancels.push(id);
	},
}));

vi.mock("@/lib/core/notify", () => ({
	notifyError: (...args: unknown[]) => io.errors.push(args),
	notifyWarning: (...args: unknown[]) => io.warnings.push(args),
	notifySuccess: () => {},
	notifyUndo: () => {},
	notifyAction: () => {},
	notifyReminder: () => {},
}));

vi.mock("@/lib/shell/settings-window", () => ({
	openSettingsWindow: (surface: string) => io.openSettings.push(surface),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(() => {}, {
		dismiss: (...args: unknown[]) => io.dismissed.push(args),
		error: () => {},
		success: () => {},
		warning: () => {},
		info: () => {},
		loading: () => {},
		message: () => {},
	}),
}));

vi.mock("@/lib/pdf/layout/io", async (importOriginal) => ({
	...(await importOriginal<object>()),
	readLayoutSidecar: async () => {
		if (io.cachedLayoutReadGate) await io.cachedLayoutReadGate.promise;
		else await new Promise((resolve) => setTimeout(resolve, 0));
		return io.cachedLayout;
	},
	subscribeLayoutSidecarWrite: (listener: (path: string) => void) => {
		io.layoutWrites.add(listener);
		return () => {
			io.layoutWrites.delete(listener);
		};
	},
}));

vi.mock("@/lib/pdf/layout", async (importOriginal) => ({
	...(await importOriginal<object>()),
	currentLayoutTranslateCacheKey: () => io.cacheKey,
	readLayoutTranslateSidecar: async () => io.translateSidecar,
	persistLayoutTranslateSidecarBestEffort: (...args: unknown[]) => {
		io.writes.push(args);
	},
	flushLayoutTranslateSidecar: async (...args: unknown[]) => {
		io.flushes.push(args);
		io.writes.push(args);
	},
	runLayoutRegionTranslate: (options: Omit<Run, "resolve" | "reject">) =>
		new Promise<LayoutTranslateItem[]>((resolve, reject) => {
			io.runs.push({ ...options, resolve, reject });
			options.onUpdate(
				options.items.map((item) =>
					item.status === "done" ? item : { ...item, status: "running" },
				),
			);
		}),
	enqueuePaperLayoutAnalysis: (request: EnqueueRequest) => {
		io.enqueues.push(request);
	},
	// The viewer wires published results back into `layoutRawRegions`; the
	// harness applies them on flush instead of a real layout-regions hook.
	setLayoutDocumentResult: (result: PdfLayoutDocumentResult) => {
		io.publishedLayouts.push(result);
	},
}));

function region(pageIndex: number): PdfLayoutRegion {
	return {
		id: `region-${pageIndex}`,
		pageIndex,
		kind: "text",
		label: "text",
		score: 1,
		readingOrder: pageIndex,
		rect: { x: 0, y: 0, w: 100, h: 20 },
		bbox: { x: 0, y: 0, w: 1, h: 1 },
		text: `Source ${pageIndex}`,
	};
}

function item(
	pageIndex: number,
	patch: Partial<LayoutTranslateItem> = {},
): LayoutTranslateItem {
	return { ...region(pageIndex), status: "pending", ...patch };
}

function entry(
	page: number,
	translated: string,
	source = `Source ${page}`,
): SidecarEntry {
	return { id: `region-${page}`, source, translated };
}

function setTranslateSidecar(entries: SidecarEntry[]) {
	io.translateSidecar = {
		schemaVersion: 2,
		source: {
			mode: "pdf-layout-translate",
			generatedAt: "cached",
			providerId: io.cacheKey.providerId,
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "test",
		},
		items: entries.map((e) => ({ ...region(0), ...e })),
	};
}

function setCachedLayout(regions: PdfLayoutRegion[], notifyPath?: string) {
	const pageCount = Math.max(1, ...regions.map((r) => r.pageIndex + 1));
	io.cachedLayout = {
		schemaVersion: 3,
		source: {
			mode: "embedpdf-layout",
			generatedAt: "cached",
			textLayerExtracted: true,
			sourceStylesExtracted: true,
			textOrderVersion: LAYOUT_TEXT_ORDER_VERSION,
			completeness: {
				pageCount,
				processedPages: Array.from({ length: pageCount }, (_, i) => i),
				textLayerComplete: true,
				pageStats: regions.map((r) => ({
					pageIndex: r.pageIndex,
					regionCount: 1,
					textChars: 100,
					translatableRegionCount: 1,
				})),
				warnings: [],
				contentRepairAttempted: true,
			},
		},
		regions,
	};
	if (notifyPath) for (const listener of io.layoutWrites) listener(notifyPath);
}

function sharedJob(state: JobSnapshot["state"] = "running"): JobSnapshot {
	return {
		id: "bg-1",
		kind: "layoutTranslate",
		state,
		vaultPath: "/vault",
		paperPath: "papers/a",
		force: false,
	} as JobSnapshot;
}

function sharedSnapshot(items: LayoutTranslateItem[]): TranslationSnapshot {
	return { revision: 1, cacheKey: io.cacheKey, items };
}

function setShared(job: JobSnapshot, snapshot: TranslationSnapshot | null) {
	io.sharedJob = job;
	io.sharedSnapshot = snapshot;
}

const runningItem = (page: number) => item(page, { status: "running" });
const doneItem = (page: number, translated: string) =>
	item(page, { status: "done", translated });
const errorItem = (page: number, error = "boom") =>
	item(page, { status: "error", error });

function setSharedItems(
	state: JobSnapshot["state"],
	...items: LayoutTranslateItem[]
) {
	setShared(sharedJob(state), sharedSnapshot(items));
}

function task(id: string, status: BackgroundTask["status"]): BackgroundTask {
	return {
		id,
		kind: "layoutAnalyze",
		title: "parse",
		status,
		paperPath: "papers/a",
		progress: null,
		queueIndex: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function completed(run: Run, translated = "Translated"): LayoutTranslateItem[] {
	return run.items.map((it) => ({ ...it, status: "done", translated }));
}

function resetIo() {
	for (const list of [
		io.runs,
		io.observers,
		io.writes,
		io.flushes,
		io.errors,
		io.warnings,
		io.dismissed,
		io.enqueues,
		io.cancels,
		io.openSettings,
		io.publishedLayouts,
	])
		list.length = 0;
	io.layoutWrites.clear();
	io.cachedLayout = null;
	io.cachedLayoutReadGate = null;
	io.translateSidecar = null;
	io.sharedJob = null;
	io.sharedSnapshot = null;
	io.sharedGate = null;
	io.prepareGate = null;
	io.prepareTransform = null;
	io.reflowInput = [];
}

const mountedHooks: { unmount: () => Promise<void> }[] = [];

async function mountHarness(
	initial: Partial<UsePdfLayoutTranslateOptions> = {},
) {
	const props: UsePdfLayoutTranslateOptions = {
		docId: "paper-a",
		paperAbsPath: "/vault/papers/a",
		paperRelPath: "papers/a",
		layoutRawRegions: [region(0), region(1)],
		...initial,
	};
	const mounted = mountHook(usePdfLayoutTranslate, props);
	mountedHooks.push(mounted);
	let applied: PdfLayoutDocumentResult | undefined;
	const h = {
		get view() {
			return mounted.result.current;
		},
		get partial() {
			return mounted.result.current.layoutTranslatePartial;
		},
		async render(next: Partial<UsePdfLayoutTranslateOptions> = {}) {
			Object.assign(props, next);
			await mounted.render(props);
		},
		async run(fn: () => void) {
			await act(async () => {
				fn();
			});
		},
		async toggle() {
			await h.run(() => h.view.toggleLayoutTranslate());
		},
		async togglePage(pageIndex: number) {
			await h.run(() => h.view.togglePageLayoutTranslate(pageIndex));
		},
		async start() {
			await h.toggle();
			await h.flush();
		},
		async startPage(pageIndex: number) {
			await h.togglePage(pageIndex);
			await h.flush();
		},
		/** Drain microtasks and coalesced publishes; wire published layouts back. */
		async flush(rounds = 3) {
			for (let i = 0; i < rounds; i++) {
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
				const published = io.publishedLayouts.at(-1);
				if (published && published !== applied) {
					applied = published;
					await h.render({ layoutRawRegions: published.rawRegions });
				}
			}
		},
		async publishShared(
			job: JobSnapshot,
			snapshot: TranslationSnapshot | null,
		) {
			setShared(job, snapshot);
			await h.run(() => {
				for (const observer of io.observers)
					if (!observer.signal.aborted) observer.onUpdate(job, snapshot);
			});
			await h.flush();
		},
		async unmount() {
			await mounted.unmount();
		},
	};
	await mounted.render(props);
	return h;
}

type Harness = Awaited<ReturnType<typeof mountHarness>>;

function pageText(h: Harness, page: number) {
	return h.view.layoutTranslateItemsByPage.get(page)?.[0]?.translated;
}

async function settleRun(h: Harness, run: Run, items: LayoutTranslateItem[]) {
	await h.run(() => run.resolve(items));
	await h.flush();
}

beforeEach(() => {
	resetIo();
	backgroundTasksStore.setState({ tasks: [] });
	layoutAnalysisStore.setState({
		ui: { stage: "idle" },
		activeDocumentId: null,
		activePaperAbsPath: null,
	});
	// The hook coalesces streaming publishes through rAF; keep the real
	// trailing-edge behaviour but settle it on the macrotask queue.
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
		setTimeout(() => cb(0), 0),
	);
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(async () => {
	for (const hook of mountedHooks.splice(0)) await hook.unmount();
	vi.unstubAllGlobals();
});

it("starts from an existing layout cache without a new parse or viewer file event", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	setCachedLayout([region(0)]);
	await h.start();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	expect(io.runs.length).toBe(1);
	expect(io.publishedLayouts.length).toBe(1);
});

it("hydrates a partial sidecar without a request and keeps the partial entry closed", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.start();
	expect(io.runs.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.view.layoutTranslatePendingRequired).toBe(1);
	expect(pageText(h, 0)).toBe("译文 0");
	// Page generation and missing translations never open the popover.
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
	expect(h.partial.pageRange).toEqual({ start: 2, end: 2 });
	await h.run(() => h.partial.onOpenChange(true));
	expect(h.partial.open).toBe(true);
	await h.run(() => h.partial.onOpenChange(false));
	expect(h.partial.open).toBe(false);
	// Hide/show switches the cached overlays without translating again.
	await h.toggle();
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	await h.start();
	expect(h.view.layoutTranslateItemsByPage.size).toBe(2);
	expect(io.runs.length).toBe(0);
});

it("audits an unverified layout before showing a complete translation cache", async () => {
	setCachedLayout([region(0)]);
	if (io.cachedLayout) delete io.cachedLayout.source.completeness;
	setTranslateSidecar([entry(0, "译文 0")]);
	setSharedItems("running", runningItem(0));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(io.observers.length).toBe(1);
	expect(io.observers[0].start).toBe(true);
	expect(io.runs.length).toBe(0);
});

it("subscribes to a running automatic document without cancelling or starting requests", async () => {
	setSharedItems("running", doneItem(0, "Already translated"), runningItem(1));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(io.observers.length).toBe(1);
	expect(io.observers[0].start).toBe(true);
	expect(io.runs.length).toBe(0);
	expect(io.cancels).toEqual([]);
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(h.view.layoutTranslateProgress ?? 0).toBeGreaterThan(0);
	await h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot([doneItem(0, "Finished"), doneItem(1, "Finished")]),
	);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(h.view.layoutTranslateItemsByPage.size).toBe(2);
});

it("shows a layout warning even when every layout block is translated", async () => {
	setShared(sharedJob("succeeded"), {
		...sharedSnapshot([]),
		layoutWarnings: [{ code: "content-gap", pages: [2, 6, 7, 8] }],
		layoutPageCount: 15,
	});
	const h = await mountHarness({ vaultPath: "/vault", layoutRawRegions: [] });
	await h.start();
	expect(h.view.layoutTranslatePendingRequired).toBe(0);
	expect(h.partial.visible).toBe(true);
	expect(h.partial.layoutWarningPages).toBe("3, 7–9");
	expect(h.partial.layoutPageCount).toBe(15);
	await h.run(() => h.partial.onReparseAndTranslate());
	await h.flush();
	expect(io.observers.at(-1)?.forceLayout).toBe(true);
});

it("shows queued translation and continues when the same job starts", async () => {
	setShared(sharedJob("queued"), null);
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(h.view.layoutTranslateQueued).toBe(true);
	await h.publishShared(sharedJob(), sharedSnapshot([runningItem(0)]));
	expect(h.view.layoutTranslateQueued).toBe(false);
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(io.runs.length).toBe(0);
});

it("opens a complete paper cache without joining a blocked translation queue", async () => {
	setCachedLayout([region(0), region(1)]);
	setShared(sharedJob("queued"), null);
	io.prepareTransform = (items) =>
		items.map((it) => ({ ...it, source: `Prepared ${it.source}` }));
	setTranslateSidecar([
		entry(0, "Cached 0", "Prepared Source 0"),
		entry(1, "Cached 1", "Prepared Source 1"),
	]);
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(io.observers.length).toBe(0);
	expect(io.runs.length).toBe(0);
	expect(io.writes.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(io.reflowInput[1].translated).toBe("Cached 1");
	await h.toggle(); // hide
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	expect(io.cancels).toEqual([]);
	await h.run(() => h.partial.onRetranslateAll());
	await h.flush();
	expect(io.observers.length).toBe(1);
	expect(io.observers[0].start).toBe(true);
	expect(io.observers[0].force).toBe(true);
});

it("opens a cached paper translation pane before its layout store is populated", async () => {
	setTranslateSidecar([entry(0, "Cached 0"), entry(1, "Cached 1")]);
	setCachedLayout([region(0), region(1)]);
	const h = await mountHarness({
		vaultPath: "/vault",
		translationPane: true,
		layoutRawRegions: [],
	});
	await h.start();
	expect(io.observers.length).toBe(0);
	expect(io.publishedLayouts.length).toBe(1);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(io.reflowInput.length).toBe(2);
});

it("opens a partial paper cache with a warning and no automatic completion", async () => {
	for (const translationPane of [false, true]) {
		setCachedLayout([region(0), region(1)]);
		setShared(sharedJob("queued"), null);
		setTranslateSidecar([entry(0, "Cached")]);
		const h = await mountHarness({ vaultPath: "/vault", translationPane });
		await h.start();
		expect(io.observers.length).toBe(0);
		expect(io.runs.length).toBe(0);
		expect(io.writes.length).toBe(0);
		expect(h.view.layoutTranslateStatus).toBe("partial");
		expect(io.reflowInput.map((it) => it.translated)).toEqual([
			"Cached",
			undefined,
		]);
		expect(h.partial.visible).toBe(true);
		expect(h.partial.open).toBe(false);
		expect(h.partial.pendingRequired).toBe(1);
		await h.toggle(); // hide, then show the retained cache
		expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
		await h.start();
		expect(pageText(h, 0)).toBe("Cached");
		setSharedItems("running", doneItem(0, "Cached"), runningItem(1));
		await h.run(() => h.partial.onCompleteMissing());
		await h.flush();
		expect(io.observers.length).toBe(1);
		expect(io.observers[0].start).toBe(true);
		expect(io.observers[0].force).toBe(false);
		expect(h.partial.open).toBe(false);
		expect(h.view.layoutTranslatePageCounts?.total).toBe(1);
		expect(io.runs.length).toBe(0);
		await h.unmount();
		resetIo();
	}
});

it("queues a paper when its sidecar does not match prepared source", async () => {
	setCachedLayout([region(0), region(1)]);
	setShared(sharedJob("queued"), null);
	setTranslateSidecar([entry(0, "Cached", "Old source")]);
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(io.observers.length).toBe(1);
	expect(io.observers[0].start).toBe(true);
	expect(h.view.layoutTranslateQueued).toBe(true);
	expect(io.runs.length).toBe(0);
});

it("stop/close during paper cache preparation prevents a late render or enqueue", async () => {
	for (const action of ["stop", "close"] as const) {
		setCachedLayout([region(0), region(1)]);
		setTranslateSidecar([entry(0, "Cached 0"), entry(1, "Cached 1")]);
		const h = await mountHarness({ vaultPath: "/vault" });
		io.prepareGate = deferred();
		await h.start();
		if (action === "stop") await h.toggle();
		else await h.unmount();
		io.prepareGate?.resolve();
		io.prepareGate = null;
		await h.flush();
		expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
		expect(io.observers.length).toBe(0);
		expect(io.cancels).toEqual([]);
		expect(io.writes.length).toBe(0);
		await h.unmount();
		resetIo();
	}
});

it("a page click joins automatic items and never cancels the document", async () => {
	setSharedItems("running", runningItem(0), runningItem(1));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.startPage(0);
	expect(io.runs.length).toBe(0);
	expect(io.observers[0].start).toBe(false);
	await h.startPage(0);
	expect(io.cancels).toEqual([]);
	expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(false);
	await h.start();
	expect(io.observers.at(-1)?.start).toBe(true);
	expect(io.runs.length).toBe(0);
	expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(true);
});

it("closing a viewer detaches while the shared task continues", async () => {
	setSharedItems("running", runningItem(0));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	await h.unmount();
	expect(io.observers[0].signal.aborted).toBe(true);
	expect(io.cancels).toEqual([]);
	const writes = io.writes.length;
	await h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot([doneItem(0, "Background result")]),
	);
	expect(io.writes.length).toBe(writes);
	expect(io.errors.length).toBe(0);
});

it("the full-document stop action cancels the shared job", async () => {
	setSharedItems("running", runningItem(0));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	await h.start();
	expect(io.cancels).toEqual(["bg-1"]);
	expect(h.view.layoutTranslateStatus).toBe("cancelled");
});

it("keeps shared partial recovery available and counts only the pages being completed", async () => {
	const cached = doneItem(0, "Cached");
	setSharedItems("failed", cached, errorItem(1));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(h.partial.visible).toBe(true);
	await h.toggle(); // a real warning opens the summary card
	await h.flush();
	expect(h.partial.open).toBe(true);
	await h.run(() => h.partial.onOpenChange(false));
	expect(h.partial.visible).toBe(true);
	setSharedItems("running", cached, runningItem(1));
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(h.view.layoutTranslateProgress).toBe(0);
	expect(h.view.layoutTranslatePageCounts).toEqual({ done: 0, total: 1 });
	await h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot([cached, doneItem(1, "Completed")]),
	);
	expect(h.partial.visible).toBe(false);
	expect(h.view.layoutTranslatePageCounts).toEqual({ done: 1, total: 1 });
});

it("routes shared document failures through partial recovery, not error toasts", async () => {
	for (const allFailed of [false, true]) {
		const message = "Translation service unavailable";
		setShared(
			{ ...sharedJob("failed"), error: allFailed ? message : null },
			sharedSnapshot([
				allFailed ? errorItem(0, message) : doneItem(0, "Saved translation"),
				errorItem(1, message),
			]),
		);
		const h = await mountHarness({ vaultPath: "/vault" });
		await h.start();
		expect(io.errors.length).toBe(0);
		expect(h.partial.visible).toBe(true);
		expect(h.partial.open).toBe(false);
		expect(h.partial.pendingRequired).toBe(allFailed ? 2 : 1);
		await h.unmount();
		resetIo();
	}
});

it("keeps a shared page failure inline instead of raising an error toast", async () => {
	setSharedItems("succeeded", errorItem(0, "Translation service unavailable"));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.startPage(0);
	expect(io.errors.length).toBe(0);
	// The failed block keeps its error state so the paragraph-tail retry
	// marker can render, and the page tab keeps reporting an incomplete page.
	expect(
		h.view.layoutTranslateItemsByPage
			.get(0)
			?.some((item) => item.status === "error"),
	).toBe(true);
	expect(h.view.layoutTranslatePageStateByPage.get(0)?.status).toBe("error");
	expect(h.partial.visible).toBe(false);
});

it.each([
	{
		stage: "before publishing items",
		items: null,
		status: "partial",
		pending: 0,
	},
	{
		stage: "with missing translations",
		items: [errorItem(0, "Translation service unavailable")],
		status: "partial",
		pending: 1,
	},
	{
		stage: "after translating every item",
		items: [doneItem(0, "Saved translation")],
		status: "done",
		pending: 0,
	},
])("shows shared job failures on the warning button $stage", async ({
	items,
	status,
	pending,
}) => {
	const message = "Cache write failed";
	setShared(
		{ ...sharedJob("failed"), error: message },
		items ? sharedSnapshot(items) : null,
	);
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(io.errors).toHaveLength(0);
	expect(h.view.layoutTranslateStatus).toBe(status);
	expect(h.partial).toMatchObject({
		visible: true,
		failureMessage: message,
		pendingRequired: pending,
	});
});

it("resets a shared retranslation's progress after the previous run completed", async () => {
	setSharedItems("succeeded", doneItem(0, "Finished"));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.start();
	expect(h.view.layoutTranslateProgress).toBe(1);
	setSharedItems("running", runningItem(0));
	await h.run(() => h.partial.onRetranslateAll());
	await h.flush();
	expect(h.view.layoutTranslateProgress).toBe(0);
	expect(io.observers.at(-1)?.force).toBe(true);
	expect(io.runs.length).toBe(0);
});

it("filters old reference translations before a remote pane publishes cached blocks", async () => {
	for (const savedLayout of [false, true]) {
		const reference = {
			...region(1),
			label: "reference",
			text: "[1] Smith. A reference.",
		};
		setTranslateSidecar([
			entry(0, "正文缓存"),
			entry(1, "旧参考文献译文", "[1] Smith. A reference."),
		]);
		if (savedLayout) setCachedLayout([region(0), reference]);
		io.prepareGate = deferred();
		const h = await mountHarness({
			translationPane: true,
			vaultPath: "remote:server/vault",
			layoutRawRegions: savedLayout ? [] : [region(0), reference],
		});
		await h.flush();
		expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(false);
		expect(pageText(h, 0)).toBe("正文缓存");
		io.prepareGate?.resolve();
		io.prepareGate = null;
		await h.flush();
		expect(h.view.layoutTranslatePendingRequired).toBe(0);
		expect(io.runs.length).toBe(0);
		await h.unmount();
		resetIo();
	}
});

it("waits for layout before publishing an unclassified remote sidecar without engine preparation", async () => {
	const reference = { ...region(1), label: "reference" };
	setTranslateSidecar([entry(0, "正文缓存"), entry(1, "旧参考文献译文")]);
	const h = await mountHarness({
		translationPane: true,
		vaultPath: "remote:server/vault",
		layoutRawRegions: [],
	});
	await h.flush();
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	await h.render({ layoutRawRegions: [region(0), reference] });
	await h.flush();
	expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(false);
	expect(h.view.layoutTranslatePendingRequired).toBe(0);
	expect(io.runs.length).toBe(0);
});

it("hydrates a remote translation pane through the cache path", async () => {
	setTranslateSidecar([entry(0, "Cached")]);
	const h = await mountHarness({
		translationPane: true,
		vaultPath: "remote:server/vault",
	});
	await h.flush();
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.partial.visible).toBe(true);
	expect(io.runs.length).toBe(0);
	expect(io.observers.length).toBe(0);
});

it("stop/close while enqueueing cancels or retains the eventual shared job", async () => {
	for (const action of ["stop", "close"] as const) {
		setShared(sharedJob(), null);
		const h = await mountHarness({ vaultPath: "/vault" });
		io.sharedGate = deferred();
		await h.start();
		if (action === "stop") await h.toggle();
		else await h.unmount();
		io.sharedGate?.resolve();
		io.sharedGate = null;
		await h.flush();
		expect(io.cancels).toEqual(action === "stop" ? ["bg-1"] : []);
		await h.unmount();
		resetIo();
	}
});

it("keeps a closed partial hint closed during repeated cache hydration", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.start();
	await h.run(() => h.partial.onOpenChange(true));
	expect(h.partial.open).toBe(true);
	await h.run(() => h.partial.onOpenChange(false));
	// A repeated layout notification must not reopen the same gap set.
	await h.render({
		translationPane: true,
		layoutRawRegions: [region(0), region(1)],
	});
	await h.flush();
	expect(h.partial.open).toBe(false);
	await h.run(() => h.partial.onOpenChange(true));
	expect(h.partial.open).toBe(true);
});

it("offers pending-only completion when a translation pane reopens a partial cache", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness({ translationPane: true });
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.partial.open).toBe(false);
	// Leaving and returning to the document re-hydrates without reopening.
	await h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
	await h.flush();
	await h.render({ docId: "paper-a", paperAbsPath: "/vault/papers/a" });
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items[0].status).toBe("done");
	expect(io.runs[0].items[0].translated).toBe("译文 0");
	expect(io.runs[0].items[1].status).toBe("running");
	await settleRun(h, io.runs[0], [
		io.runs[0].items[0],
		doneItem(1, "补全译文"),
	]);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(h.partial.visible).toBe(false);
});

it("does not let a late translation-pane hydrate erase a completed recovery", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness({ translationPane: true });
	await h.flush();
	expect(h.view.layoutTranslateStatus).toBe("partial");
	io.prepareGate = deferred();
	await h.render({ layoutRawRegions: [region(0), region(1)] });
	await h.flush();
	expect(io.runs.length).toBe(0);
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	expect(io.runs.length).toBe(1);
	await settleRun(h, io.runs[0], completed(io.runs[0], "补全译文"));
	expect(h.view.layoutTranslateStatus).toBe("done");
	// The older hydrate started before the recovery and is still preparing.
	io.prepareGate?.resolve();
	io.prepareGate = null;
	await h.flush();
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(h.view.layoutTranslatePendingRequired).toBe(0);
	expect(pageText(h, 1)).toBe("补全译文");
	expect(io.runs.length).toBe(1);
});

it("completes only pending blocks and rewrites the sidecar", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.start();
	const writes = io.writes.length;
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items[0].status).toBe("done");
	expect(io.runs[0].items[0].translated).toBe("译文 0");
	expect(io.runs[0].items[1].status).toBe("running");
	expect(h.view.layoutTranslateRunning).toBe(true);
	await settleRun(h, io.runs[0], [
		doneItem(0, "译文 0"),
		doneItem(1, "补全译文"),
	]);
	expect(h.view.layoutTranslateRunning).toBe(false);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(pageText(h, 0)).toBe("译文 0");
	expect(pageText(h, 1)).toBe("补全译文");
	expect(io.writes.length).toBe(writes + 1);
});

it("keeps the partial entry after a failed completion without reopening", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.start();
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	await settleRun(h, io.runs[0], [io.runs[0].items[0], errorItem(1)]);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.view.layoutTranslatePendingRequired).toBe(1);
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
	expect(h.partial.completionFailed).toBe(true);
	expect(io.errors.length).toBe(0);
});

it("keeps local document failures in the partial entry across retranslation", async () => {
	const h = await mountHarness();
	await h.start();
	await settleRun(h, io.runs[0], [
		doneItem(0, "Saved"),
		errorItem(1, "Service unavailable"),
	]);
	expect(io.errors.length).toBe(0);
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
	expect(h.partial.pendingRequired).toBe(1);
	await h.run(() => h.partial.onRetranslateAll());
	await h.flush();
	const run = io.runs[1];
	await settleRun(
		h,
		run,
		run.items.map((it) => ({
			...it,
			status: "error",
			error: "Service unavailable",
		})),
	);
	expect(io.errors.length).toBe(0);
	expect(h.partial.pendingRequired).toBe(1);
	expect(pageText(h, 0)).toBe("Saved");
});

it("opens the partial card when translate is clicked after a failure", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.start();
	await h.run(() => h.partial.onCompleteMissing());
	await h.flush();
	await settleRun(h, io.runs[0], [io.runs[0].items[0], errorItem(1)]);
	expect(h.partial.open).toBe(false);
	// The main button surfaces the warning instead of hiding existing pages.
	await h.toggle();
	expect(h.partial.open).toBe(true);
	// Closing the popover preserves its warning and manual recovery entry.
	await h.run(() => h.partial.onOpenChange(false));
	await h.toggle();
	expect(h.partial.open).toBe(true);
});

it("retranslates everything and restores old text for failed blocks", async () => {
	setTranslateSidecar([entry(0, "译文 0"), entry(1, "译文 1")]);
	const h = await mountHarness();
	await h.start();
	await h.run(() => h.partial.onRetranslateAll());
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items.map((it) => it.status)).toEqual([
		"pending",
		"pending",
	]);
	// Old text stays painted while the confirmed rerun streams.
	expect(io.runs[0].items[0].translated).toBe("译文 0");
	await settleRun(h, io.runs[0], [doneItem(0, "新译文 0"), errorItem(1)]);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(pageText(h, 0)).toBe("新译文 0");
	expect(pageText(h, 1)).toBe("译文 1");
	const lastWrite = io.writes.at(-1)?.[2] as LayoutTranslateItem[] | undefined;
	expect(lastWrite?.find((it) => it.id === "region-1")?.translated).toBe(
		"译文 1",
	);
});

it("loads the layout when a headless parse writes it without a viewer file event", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.start();
	setCachedLayout([region(0)], "/vault/papers/a");
	await h.flush();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	expect(io.runs.length).toBe(1);
});

it("does not load a cached layout after the wait has been cancelled", async () => {
	setCachedLayout([region(0)]);
	const readGate = deferred();
	io.cachedLayoutReadGate = readGate;
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.toggle();
	expect(h.view.layoutTranslateWaiting).toBe(true);
	await h.toggle();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	await h.run(() => readGate.resolve());
	await h.flush();
	expect(io.publishedLayouts.length).toBe(0);
	expect(io.runs.length).toBe(0);
});

it("exits preparation and reports an enqueue failure", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.toggle();
	await h.run(() => io.enqueues[0].onError(new Error("enqueue failed")));
	await h.flush();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	expect(io.errors.length).toBe(1);
});

it("ignores a replaced whole-document run's late result", async () => {
	const h = await mountHarness();
	await h.start();
	await h.toggle(); // stop
	await h.toggle(); // restart before the old request settles
	await h.flush();
	expect(io.runs.length).toBe(2);
	const writes = io.writes.length;
	await settleRun(h, io.runs[0], completed(io.runs[0], "Old"));
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(io.writes.length).toBe(writes);
	await settleRun(h, io.runs[1], completed(io.runs[1], "New"));
	expect(h.view.layoutTranslateRunning).toBe(false);
	expect(pageText(h, 0)).toBe("New");
});

it("ignores a replaced page run's late result, progress and errors", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	await h.startPage(1);
	expect(io.runs[0].signal.aborted).toBe(true);
	const writes = io.writes.length;
	await h.run(() => {
		io.runs[0].onUpdate(completed(io.runs[0], "Stale progress"));
		io.runs[0].resolve(completed(io.runs[0]));
		io.runs[0].reject(new Error("Late failure"));
	});
	await h.flush();
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(h.view.layoutTranslatePageStateByPage.get(0)?.running).toBe(false);
	expect(io.errors.length).toBe(0);
	expect(io.writes.length).toBe(writes);
});

it("stops, hides and shows a document run without resuming or losing completed text", async () => {
	const h = await mountHarness();
	await h.start();
	const run = io.runs[0];
	await h.run(() => run.onUpdate([doneItem(0, "Keep this"), runningItem(1)]));
	await h.flush();
	await h.toggle(); // stop: spinners drop immediately, completed text stays
	expect(h.view.layoutTranslateRunning).toBe(false);
	expect(h.view.layoutTranslatePageStateByPage.get(1)?.running).toBe(false);
	await h.toggle(); // hide, do not resume
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	const writes = io.writes.length;
	await settleRun(h, run, completed(run, "Late"));
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	expect(io.writes.length).toBe(writes);
	await h.toggle(); // show retained text
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(h.view.layoutTranslateStatus).toBe("cancelled");
	expect(h.view.layoutTranslatePendingRequired).toBe(1);
	expect(pageText(h, 0)).toBe("Keep this");
});

it("keeps overlays hidden after a late page result without losing completed text", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	const run = io.runs[0];
	await h.run(() => run.onUpdate(completed(run, "Visible progress")));
	await h.flush();
	await h.togglePage(0); // hide via the page tag
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	const writes = io.writes.length;
	await settleRun(h, run, completed(run, "Late"));
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	// A page-only run still persists its final result.
	expect(io.writes.length).toBeGreaterThan(writes);
	await h.togglePage(0); // show retained
	await h.flush();
	expect(pageText(h, 0)).toBe("Late");
	expect(io.runs.length).toBe(1);
});

it("discards late document/page results when switching documents", async () => {
	for (const mode of ["document", "page"] as const) {
		const h = await mountHarness();
		if (mode === "document") await h.toggle();
		else await h.togglePage(0);
		await h.flush();
		await h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
		const writes = io.writes.length;
		await settleRun(h, io.runs[0], completed(io.runs[0], "Wrong document"));
		expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
		expect(io.writes.length).toBe(writes);
		await h.unmount();
		resetIo();
	}
});

it("ignores late document/page results after unmount", async () => {
	for (const mode of ["document", "page"] as const) {
		const h = await mountHarness();
		if (mode === "document") await h.toggle();
		else await h.togglePage(0);
		await h.flush();
		await h.unmount();
		const writes = io.writes.length;
		await h.run(() => io.runs[0].resolve(completed(io.runs[0])));
		await h.flush();
		expect(io.writes.length).toBe(writes);
		expect(io.flushes.length).toBe(0);
		expect(io.errors.length).toBe(0);
		resetIo();
	}
});

it("persists a successful current page and flushes the sidecar immediately", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	const writes = io.writes.length;
	await settleRun(h, io.runs[0], completed(io.runs[0], "Current result"));
	expect(h.view.layoutTranslateRunning).toBe(false);
	expect(pageText(h, 0)).toBe("Current result");
	expect(io.writes.length).toBe(writes + 1);
	expect(io.flushes.length).toBe(1);
	expect(
		(io.flushes[0]?.[2] as LayoutTranslateItem[] | undefined)?.[0]?.translated,
	).toBe("Current result");
});

it("reuses finished document blocks when a page restarts before the cache write lands", async () => {
	// The runtime works on prepared (protected) sources, not the raw region
	// text; simulate that so the post-prepare reuse is what keeps a0 done.
	io.prepareTransform = (items) =>
		items.map((it) => ({ ...it, source: `prepared:${it.source}` }));
	const h = await mountHarness({
		layoutRawRegions: [
			{ ...region(0), id: "a0", text: "A0" },
			{ ...region(0), id: "a1", text: "A1" },
			{ ...region(1), id: "b0", text: "B0" },
		],
	});
	await h.start();
	await settleRun(h, io.runs[0], [
		{ ...io.runs[0].items[0], status: "done", translated: "译文 A0" },
		{ ...io.runs[0].items[1], status: "error", error: "boom" },
		{ ...io.runs[0].items[2], status: "done", translated: "译文 B0" },
	]);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	// Retry page 0 immediately: the sidecar may still be stale, so the finished
	// block must come from the in-memory prepared items.
	await h.startPage(0);
	expect(io.runs.length).toBe(2);
	expect(
		io.runs[1].items.map((it) => [it.id, it.status, it.translated ?? null]),
	).toEqual([
		["a0", "done", "译文 A0"],
		["a1", "pending", null],
	]);
});

it("does not abort a document run when a pending page tag is clicked", async () => {
	const h = await mountHarness();
	await h.start();
	await h.run(() => io.runs[0].onUpdate([runningItem(0), item(1)]));
	await h.flush();
	await h.togglePage(1); // page 1 is still queued in the doc run
	expect(io.runs[0].signal.aborted).toBe(false);
	expect(io.runs.length).toBe(1);
	expect(h.view.layoutTranslateRunning).toBe(true);
});

it("hydrates a page from the sidecar without a request", async () => {
	setTranslateSidecar([entry(0, "缓存页面")]);
	const h = await mountHarness();
	await h.startPage(0);
	expect(io.runs.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(pageText(h, 0)).toBe("缓存页面");
	// A page-scoped job never surfaces the document-level partial dialog.
	expect(h.partial.visible).toBe(false);
});

it("reports a page translation failure inline instead of as an error toast", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	// The reliability layer settles failed blocks on error instead of throwing,
	// so the hook sees terminal item errors and must not toast.
	await h.run(() =>
		io.runs[0].resolve(
			io.runs[0].items.map((item) => ({
				...item,
				status: "error" as const,
				translated: undefined,
				error: "Unexpected Tencent Transmart translation response",
			})),
		),
	);
	await h.flush();
	expect(io.errors.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.partial.visible).toBe(false);
	// Retry entry: the page's blocks keep status "error" and the page tab shows
	// the incomplete state, while tapping the marker retries the same page run.
	expect(h.view.layoutTranslatePageStateByPage.get(0)?.status).toBe("error");
	const runsBefore = io.runs.length;
	await h.togglePage(0);
	expect(io.runs.length).toBe(runsBefore + 1);
});

it("keeps a hidden page while another page finishes and restores it from its page tag", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	await settleRun(h, io.runs[0], completed(io.runs[0], "First page"));
	await h.togglePage(0); // hide
	await h.startPage(1);
	await settleRun(h, io.runs[1], completed(io.runs[1], "Second page"));
	expect(h.view.layoutTranslateItemsByPage.has(0)).toBe(false);
	expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(true);
	const writes = io.writes.length;
	await h.togglePage(0); // show the first page
	await h.flush();
	expect(pageText(h, 0)).toBe("First page");
	expect(pageText(h, 1)).toBe("Second page");
	expect(h.view.layoutTranslatePageStateByPage.get(0)?.active).toBe(true);
	await h.togglePage(1); // hide the second page
	expect(h.view.layoutTranslateItemsByPage.has(1)).toBe(false);
	expect(h.view.layoutTranslateItemsByPage.has(0)).toBe(true);
	expect(io.runs.length).toBe(2);
	expect(io.writes.length).toBe(writes);
});

it("starts a cache-first document run from the toolbar after a page-only translation", async () => {
	const h = await mountHarness();
	await h.startPage(0);
	await settleRun(h, io.runs[0], completed(io.runs[0], "Saved page"));
	// The auto-translation sidecar is complete for the whole paper.
	setTranslateSidecar([entry(0, "Saved page"), entry(1, "Cached page two")]);
	await h.start();
	// Cache-first document hydrate: no second request, both pages rendered.
	expect(io.runs.length).toBe(1);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(h.view.layoutTranslateItemsByPage.size).toBe(2);
	expect(pageText(h, 1)).toBe("Cached page two");
	await h.toggle(); // hide the whole document
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
});

it("queues behind layout analysis and auto-starts when regions land", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.run(() =>
		backgroundTasksStore.setState({ tasks: [task("job-1", "running")] }),
	);
	await h.toggle();
	expect(h.view.layoutTranslateWaiting).toBe(true);
	expect(io.runs.length).toBe(0);
	expect(io.enqueues.length).toBe(1); // explicitly promotes the existing parse
	expect(io.enqueues[0].focus).toBe(true);
	await h.render({ layoutRawRegions: [region(0)] });
	await h.flush();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(io.runs.length).toBe(1);
});

it("cancels the queued wait on a second toggle or a tracked parse failure", async () => {
	for (const trigger of ["toggle", "failure"] as const) {
		const h = await mountHarness({ layoutRawRegions: [] });
		await h.run(() =>
			backgroundTasksStore.setState({ tasks: [task("job-1", "running")] }),
		);
		await h.toggle();
		expect(h.view.layoutTranslateWaiting).toBe(true);
		if (trigger === "toggle") {
			await h.toggle();
			expect(io.dismissed.length).toBe(1); // queued toast dismissed
		} else {
			await h.run(() =>
				backgroundTasksStore.setState({ tasks: [task("job-1", "failed")] }),
			);
			expect(io.warnings[0]?.[0]).toBe(
				"pdf.layoutTranslate.parseFailedWhileWaiting",
			);
		}
		expect(h.view.layoutTranslateWaiting).toBe(false);
		await h.render({ layoutRawRegions: [region(0)] });
		await h.flush();
		expect(io.runs.length).toBe(0); // no auto-start after cancel
		await h.unmount();
		resetIo();
	}
});

it("enqueues layout analysis when nothing is pending and ignores stale failures", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.run(() =>
		backgroundTasksStore.setState({ tasks: [task("old-job", "failed")] }),
	);
	await h.toggle();
	expect(h.view.layoutTranslateWaiting).toBe(true); // stale failure ignored
	expect(io.enqueues.length).toBe(1); // nothing pending → parse enqueued
});

it("keeps the legacy hint for a loose PDF with nothing to enqueue", async () => {
	const h = await mountHarness({
		layoutRawRegions: [],
		paperAbsPath: null,
		paperRelPath: null,
	});
	await h.toggle();
	expect(h.view.layoutTranslateWaiting).toBe(false);
	expect(io.runs.length).toBe(0);
	expect(io.errors[0]?.[0]).toBe("pdf.layoutTranslate.needLayout");
	expect(io.enqueues.length).toBe(0);
});

it("queues a page translate behind an in-viewer layout run", async () => {
	const h = await mountHarness({ layoutRawRegions: [] });
	await h.run(() =>
		layoutAnalysisStore.setState({
			ui: { stage: "running", message: "" },
			activeDocumentId: "paper-a",
		}),
	);
	await h.togglePage(0);
	expect(h.view.layoutTranslateWaiting).toBe(true);
	expect(io.runs.length).toBe(0);
	await h.render({ layoutRawRegions: [region(0), region(1)] });
	await h.flush();
	expect(h.view.layoutTranslateRunning).toBe(true);
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items.length).toBe(1); // only the queued page
});

it("completes pending blocks when a user gesture opens a partial translation", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items[0]).toMatchObject({
		status: "done",
		translated: "译文 0",
	});
	expect(io.runs[0].items[1]?.status).toBe("running");
	expect(pageText(h, 0)).toBe("译文 0");
	expect(h.partial.open).toBe(false);
	expect(io.errors).toEqual([]);
	expect(h.view.layoutTranslatePageCounts?.total).toBe(1);
});

it("hydrates a restored translation without completing pending blocks", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate());
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(io.observers.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(pageText(h, 0)).toBe("译文 0");
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
});

it("does not enqueue a second completion when the translation view is opened again", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.run(() => {
		h.view.ensureLayoutTranslate({ completePending: true });
		h.view.ensureLayoutTranslate({ completePending: true });
	});
	await h.flush();
	expect(io.runs.length).toBe(1);
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.errors).toEqual([]);
});

it("does not request anything when a gesture opens a complete translation cache", async () => {
	setTranslateSidecar([entry(0, "译文 0"), entry(1, "译文 1")]);
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(io.observers.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("done");
	expect(pageText(h, 0)).toBe("译文 0");
	expect(pageText(h, 1)).toBe("译文 1");
});

it("starts a full translation when a gesture opens a paper with no cache", async () => {
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items.map((item) => item.translated)).toEqual([
		undefined,
		undefined,
	]);
});

it("keeps a failed gesture completion on the partial entry without a toast or retry", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	await settleRun(h, io.runs[0], [io.runs[0].items[0], errorItem(1)]);
	expect(io.errors).toEqual([]);
	expect(h.view.layoutTranslateStatus).toBe("partial");
	expect(h.partial.visible).toBe(true);
	expect(h.partial.open).toBe(false);
	expect(h.partial.completionFailed).toBe(true);
	expect(pageText(h, 0)).toBe("译文 0");
	expect(io.runs.length).toBe(1);
});

it("completes pending blocks even when the translated page is hidden", async () => {
	setTranslateSidecar([entry(0, "译文 0")]);
	const h = await mountHarness();
	await h.run(() => h.view.ensureLayoutTranslate());
	await h.flush();
	expect(io.runs.length).toBe(0);
	await h.toggle();
	expect(h.view.layoutTranslateItemsByPage.size).toBe(0);
	expect(h.view.layoutTranslatePendingRequired).toBe(1);
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(1);
	expect(io.runs[0].items[0]?.translated).toBe("译文 0");
	expect(io.runs[0].items[1]?.status).toBe("running");
	expect(pageText(h, 0)).toBe("译文 0");
	expect(io.errors).toEqual([]);
});

it("queues one shared pending completion for a gesture and ignores a repeat", async () => {
	setCachedLayout([region(0), region(1)]);
	setTranslateSidecar([entry(0, "Cached")]);
	setSharedItems("running", doneItem(0, "Cached"), runningItem(1));
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.runs.length).toBe(0);
	expect(io.observers.length).toBe(1);
	expect(io.observers[0]?.purpose).toBe("complete");
	expect(io.observers[0]?.force).toBe(false);
	expect(io.observers[0]?.start).toBe(true);
	expect(pageText(h, 0)).toBe("Cached");
	expect(h.view.layoutTranslatePageCounts?.total).toBe(1);
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.observers.length).toBe(1);
	expect(io.errors).toEqual([]);
});

it("does not join the queue when a gesture opens a complete shared cache", async () => {
	setCachedLayout([region(0), region(1)]);
	setTranslateSidecar([entry(0, "Cached 0"), entry(1, "Cached 1")]);
	const h = await mountHarness({ vaultPath: "/vault" });
	await h.run(() => h.view.ensureLayoutTranslate({ completePending: true }));
	await h.flush();
	expect(io.observers.length).toBe(0);
	expect(io.runs.length).toBe(0);
	expect(io.writes.length).toBe(0);
	expect(h.view.layoutTranslateStatus).toBe("done");
});
