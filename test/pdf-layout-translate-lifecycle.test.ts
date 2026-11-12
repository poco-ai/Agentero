import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { it } from "vitest";
import type { JobSnapshot } from "@/lib/core/bindings";
import {
	layoutSidecarNeedsTextLayer,
	type PdfLayoutSidecar,
} from "@/lib/pdf/layout/io";
import * as translateProgress from "@/lib/pdf/layout/layout-translate-progress";
import * as translationExclusions from "@/lib/pdf/layout/translation-exclusions";
import type { TranslationSnapshot } from "@/lib/pdf/layout/translation-job";

// Exercise the real hook with deterministic request completion and hook slots.
// No DOM or Tauri runtime is needed; this does not replace desktop UI testing.
const hookCode = ts.transpileModule(
	readFileSync(
		new URL(
			"../src/components/viewer/pdf/hooks/use-pdf-layout-translate.ts",
			import.meta.url,
		),
		"utf8",
	),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	},
).outputText;

type Item = {
	id: string;
	pageIndex: number;
	bbox: { x: number; y: number; w: number; h: number };
	kind: string;
	label?: string;
	text?: string;
	score?: number;
	readingOrder: number;
	source: string;
	status?: string;
	translated?: string;
	error?: string;
};

type RunOptions = {
	items: Item[];
	signal: AbortSignal;
	onUpdate: (items: Item[]) => void;
};

type Run = RunOptions & {
	resolve: (items: Item[]) => void;
	reject: (error: unknown) => void;
};

type Options = {
	translationPane?: boolean;
	docId: string;
	paperAbsPath: string | null;
	paperRelPath?: string | null;
	vaultPath?: string | null;
	layoutRawRegions: Item[];
};

type CachedTranslate = {
	id: string;
	source: string;
	translated: string;
};

type PartialView = {
	pendingRequired: number;
	translatedCount: number;
	totalCount: number;
	pageRange: { start: number; end: number } | null;
	visible: boolean;
	open: boolean;
	completionFailed: boolean;
	onOpenChange: (open: boolean) => void;
	onCompleteMissing: () => void;
	onRetranslateAll: () => void;
};

type View = {
	layoutTranslateItemsByPage: ReadonlyMap<number, readonly Item[]>;
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
	layoutTranslateRunning: boolean;
	layoutTranslateWaiting: boolean;
	layoutTranslateQueued: boolean;
	layoutTranslateProgress: number | null;
	layoutTranslatePageCounts: { done: number; total: number } | null;
	layoutTranslateLabel: string;
	layoutTranslatePendingRequired: number;
	layoutTranslateStatus: string;
	layoutTranslateFromCache: boolean;
	layoutTranslatePartial: PartialView;
	toggleLayoutTranslate: () => void;
	togglePageLayoutTranslate: (pageIndex: number) => void;
};

type FakeTask = {
	id: string;
	kind: string;
	status: string;
	paperPath?: string | null;
};

type FakeStore<T> = {
	getState: () => T;
	setState: (patch: Partial<T>) => void;
	subscribe: (listener: (state: T, prev: T) => void) => () => void;
};

/** Minimal zustand-vanilla stand-in: sync notify, partial setState. */
function createFakeStore<T>(initial: T): FakeStore<T> {
	let state = initial;
	const listeners = new Set<(state: T, prev: T) => void>();
	return {
		getState: () => state,
		setState(patch) {
			const prev = state;
			state = { ...state, ...patch };
			for (const listener of listeners) listener(state, prev);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function region(pageIndex: number): Item {
	return {
		id: `region-${pageIndex}`,
		pageIndex,
		bbox: { x: 0, y: 0, w: 1, h: 1 },
		kind: "text",
		label: "text",
		score: 1,
		readingOrder: pageIndex,
		source: `Source ${pageIndex}`,
	};
}

type EffectSlot = {
	deps: readonly unknown[];
	cleanup: (() => void) | undefined;
	effect: true;
};

function createHarness() {
	const slots: unknown[] = [];
	const runs: Run[] = [];
	const writes: unknown[][] = [];
	const errors: unknown[][] = [];
	const actions: unknown[][] = [];
	const successes: unknown[][] = [];
	const warnings: unknown[][] = [];
	const dismissed: unknown[][] = [];
	const enqueues: unknown[][] = [];
	const flushes: unknown[][] = [];
	const cancels: string[] = [];
	type Observer = {
		start: boolean;
		force?: boolean;
		signal: AbortSignal;
		onUpdate: (job: JobSnapshot, snapshot: TranslationSnapshot | null) => void;
		onJob?: (id: string) => void;
	};
	const observers: Observer[] = [];
	let deferSharedRequest = false;
	let finishSharedRequest: (() => void) | undefined;
	let sharedJob: JobSnapshot | null = null;
	let sharedSnapshot: TranslationSnapshot | null = null;
	let cachedLayout: PdfLayoutSidecar | null = null;
	const layoutWrites = new Set<(path: string) => void>();
	const publishedLayouts: unknown[] = [];
	const backgroundTasks = createFakeStore<{ tasks: FakeTask[] }>({
		tasks: [],
	});
	const layoutUi = createFakeStore<{
		ui: { stage: string };
		activeDocumentId: string | null;
		activePaperAbsPath: string | null;
	}>({
		ui: { stage: "idle" },
		activeDocumentId: null,
		activePaperAbsPath: null,
	});
	let cursor = 0;
	let dirty = true;
	let effects: (() => void)[] = [];
	let stateWrites = 0;
	let reflowInput: Item[] = [];
	let reflowReady = false;
	let view: View;
	let options: Options = {
		docId: "paper-a",
		paperAbsPath: "/vault/papers/a",
		paperRelPath: "papers/a",
		layoutRawRegions: [0, 1].map((pageIndex) => region(pageIndex)),
	};
	const react = {
		useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
			const index = cursor++;
			if (!(index in slots)) slots[index] = initial;
			return [
				slots[index] as T,
				(next) => {
					slots[index] =
						typeof next === "function"
							? (next as (previous: T) => T)(slots[index] as T)
							: next;
					stateWrites++;
					dirty = true;
				},
			];
		},
		useRef<T>(initial: T): { current: T } {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { current: initial };
			return slots[index] as { current: T };
		},
		useCallback<T>(callback: T, deps: readonly unknown[]): T {
			const index = cursor++;
			const previous = slots[index] as
				| { deps: readonly unknown[]; callback: T }
				| undefined;
			if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i])))
				return previous.callback;
			slots[index] = { deps, callback };
			return callback;
		},
		useMemo: <T>(factory: () => T) => factory(),
		useEffect(
			effect: () => (() => void) | undefined,
			deps: readonly unknown[],
		) {
			const index = cursor++;
			const previous = slots[index] as EffectSlot | undefined;
			if (
				previous &&
				deps.every((dep, i) => Object.is(dep, previous.deps[i]))
			) {
				return;
			}
			effects.push(() => {
				previous?.cleanup?.();
				slots[index] = { deps, cleanup: effect(), effect: true };
			});
		},
	};
	let translateSidecar: { items: CachedTranslate[] } | null = null;
	const applyCachedTranslations = (
		items: Item[],
		sidecar: { items: CachedTranslate[] } | null,
	) => {
		if (!sidecar?.items.length) return items.map((item) => ({ ...item }));
		const byId = new Map(sidecar.items.map((item) => [item.id, item]));
		return items.map((item) => {
			const cached = byId.get(item.id);
			if (!cached || cached.source !== item.source) return { ...item };
			return {
				...item,
				status: "done",
				translated: cached.translated,
			};
		});
	};
	const layout = {
		readLayoutSidecar: async () => cachedLayout,
		mergeCaptionsIntoHosts: (regions: Item[]) => regions,
		buildLayoutDocumentResult: (
			documentId: string,
			regions: Item[],
			rawRegions: Item[],
		) => ({ documentId, regions, rawRegions }),
		setLayoutDocumentResult: (result: { rawRegions: Item[] }) => {
			publishedLayouts.push(result);
			options.layoutRawRegions = result.rawRegions;
			dirty = true;
		},
		listTranslatableLayoutRegions: (regions: Item[]) =>
			regions.filter(
				(region) =>
					!translationExclusions.isReferenceLayoutRegion({
						...region,
						label: region.label ?? region.kind,
					} as unknown as PdfLayoutSidecar["regions"][number]),
			),
		toLayoutTranslateItems: (regions: Item[]) =>
			regions.map((item) => ({ ...item, status: "pending" })),
		currentLayoutTranslateCacheKey: () => ({
			providerId: "test",
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "test",
		}),
		readLayoutTranslateSidecar: async () => translateSidecar,
		applyLayoutTranslateSidecar: applyCachedTranslations,
		hydrateLayoutTranslateItems: (
			items: Item[],
			sidecar: { items: CachedTranslate[] } | null,
		) => {
			const hydrated = applyCachedTranslations(items, sidecar);
			const cachedCount = hydrated.filter((item) =>
				item.translated?.trim(),
			).length;
			return {
				items: hydrated,
				cachedCount,
				pendingRequired: hydrated.length - cachedCount,
				fromCache: cachedCount > 0,
			};
		},
		countPendingLayoutTranslateItems: (items: Item[]) =>
			items.filter((item) => !item.translated?.trim()).length,
		layoutTranslatePendingPageRange: (items: Item[]) => {
			const pending = items.filter((item) => !item.translated?.trim());
			if (!pending.length) return null;
			const pages = pending.map((item) => item.pageIndex);
			return { start: Math.min(...pages) + 1, end: Math.max(...pages) + 1 };
		},
		hasPendingLayoutTranslateItems: (items: Item[]) =>
			items.some((item) => item.status !== "done" || !item.translated?.trim()),
		groupLayoutTranslateItemsByPage(items: Item[]) {
			const pages = new Map<number, Item[]>();
			for (const item of items) {
				const page = pages.get(item.pageIndex) ?? [];
				page.push(item);
				pages.set(item.pageIndex, page);
			}
			return pages;
		},
		persistLayoutTranslateSidecarBestEffort: (...args: unknown[]) =>
			writes.push(args),
		flushLayoutTranslateSidecar: (...args: unknown[]) => {
			flushes.push(args);
			writes.push(args);
		},

		normalizeLayoutPaperKey: (path: string) =>
			path.replace(/[/\\]+$/, "").replace(/\\/g, "/"),
		enqueuePaperLayoutAnalysis: (...args: unknown[]) => enqueues.push(args),
		layoutAnalysisStore: layoutUi,
		runLayoutRegionTranslate(runOptions: RunOptions) {
			return new Promise<Item[]>((resolve, reject) => {
				runs.push({ ...runOptions, resolve, reject });
				runOptions.onUpdate(
					runOptions.items.map((item) =>
						item.status === "done" ? item : { ...item, status: "running" },
					),
				);
			});
		},
	};
	let prepareTransform: ((items: Item[]) => Item[]) | null = null;
	let prepareGate: Promise<void> | null = null;
	let releasePrepare: (() => void) | null = null;
	const prepareReflow = async (items: Item[]) => {
		if (prepareGate) await prepareGate;
		return prepareTransform ? prepareTransform(items) : items;
	};
	const t = (key: string) => key;
	const modules: Record<string, unknown> = {
		"@/lib/core/tasks": { cancelTask: (id: string) => cancels.push(id) },
		"@/lib/pdf/layout/translation-job": {
			observePaperTranslation: async (observer: Observer) => {
				observers.push(observer);
				if (deferSharedRequest)
					await new Promise<void>((resolve) => {
						finishSharedRequest = resolve;
					});
				if (sharedJob) observer.onJob?.(sharedJob.id);
				if (!sharedJob || observer.signal.aborted) return null;
				observer.onUpdate(sharedJob, sharedSnapshot);
				return { jobId: sharedJob.id, dispose() {} };
			},
		},
		"./use-pdf-reflow": {
			usePdfReflow: (_context: unknown, _regions: unknown, items: Item[]) => {
				reflowInput = items;
				return {
					reflowItems: items,
					prepare: prepareReflow,
					reflowBusy: false,
					reflowReady,
					exportTranslatedPdf: async () => {},
				};
			},
		},
		react,
		"react-i18next": { useTranslation: () => ({ t }) },
		sonner: {
			toast: { dismiss: (...args: unknown[]) => dismissed.push(args) },
		},
		zustand: {
			useStore: <T, S>(store: FakeStore<T>, selector: (state: T) => S): S =>
				selector(store.getState()),
		},
		"@/lib/core/background-tasks": {
			backgroundTasksStore: backgroundTasks,
			cancelBackgroundTask: (id: string) => cancels.push(id),
		},
		"@/lib/core/error": { errorText: String },
		"@/lib/core/notify": {
			notifyError: (...args: unknown[]) => errors.push(args),
			notifyAction: (...args: unknown[]) => actions.push(args),
			notifySuccess: (...args: unknown[]) => successes.push(args),
			notifyWarning: (...args: unknown[]) => warnings.push(args),
		},
		"@/lib/core/path": {
			sameRelPaperPath: (a: string, b: string) =>
				Boolean(a) &&
				Boolean(b) &&
				a.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ===
					b.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
		},
		"@/lib/pdf/layout": layout,
		"@/lib/pdf/layout/constants": { LAYOUT_SIDEBAR_MIN_SCORE: 0.3 },
		"@/lib/pdf/layout/translation-exclusions": translationExclusions,
		"@/lib/pdf/layout/io": {
			layoutSidecarNeedsTextLayer,
			subscribeLayoutSidecarWrite: (listener: (path: string) => void) => {
				layoutWrites.add(listener);
				return () => layoutWrites.delete(listener);
			},
		},
		"@/lib/pdf/layout/layout-translate-progress": translateProgress,
		"@/lib/shell/settings-window": { openSettingsWindow: () => undefined },
		// Identity stub: the hook only maps known Host markers, else passes through.
		"@/lib/translate": { displayTranslateError: (message: string) => message },
	};
	const exported = {} as { usePdfLayoutTranslate: (options: Options) => View };
	runInNewContext(hookCode, {
		exports: exported,
		AbortController,
		require(name: string) {
			assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
			return modules[name];
		},
	});
	function render(nextOptions?: Partial<Options>): View {
		options = { ...options, ...nextOptions };
		for (let pass = 0; pass < 10; pass++) {
			cursor = 0;
			dirty = false;
			// biome-ignore lint/correctness/useHookAtTopLevel: Test driver uses mocked hook slots, not React.
			view = exported.usePdfLayoutTranslate(options);
			const pendingEffects = effects;
			effects = [];
			for (const effect of pendingEffects) effect();
			if (!dirty) return view;
		}
		throw new Error("Hook did not settle");
	}
	render();
	return {
		runs,
		writes,
		errors,
		actions,
		successes,
		warnings,
		dismissed,
		enqueues,
		flushes,
		cancels,
		observers,
		deferShared() {
			deferSharedRequest = true;
		},
		finishShared() {
			finishSharedRequest?.();
		},
		setShared(job: JobSnapshot, snapshot: TranslationSnapshot | null) {
			sharedJob = job;
			sharedSnapshot = snapshot;
		},
		publishShared(job: JobSnapshot, snapshot: TranslationSnapshot | null) {
			sharedJob = job;
			sharedSnapshot = snapshot;
			for (const observer of observers)
				if (!observer.signal.aborted) observer.onUpdate(job, snapshot);
		},
		publishedLayouts,
		setReflowReady(ready: boolean) {
			reflowReady = ready;
			dirty = true;
		},
		deferPrepare() {
			prepareGate = new Promise<void>((resolve) => {
				releasePrepare = resolve;
			});
		},
		releasePrepare() {
			releasePrepare?.();
			prepareGate = null;
			releasePrepare = null;
		},
		setPrepareTransform(transform: ((items: Item[]) => Item[]) | null) {
			prepareTransform = transform;
		},
		setTranslateSidecar(items: CachedTranslate[]) {
			translateSidecar = { items };
		},
		setCachedLayout(regions: Item[], notify = false) {
			cachedLayout = {
				schemaVersion: 3,
				source: {
					mode: "embedpdf-layout",
					generatedAt: "cached",
					textLayerExtracted: true,
					sourceStylesExtracted: true,
				},
				regions: regions as unknown as PdfLayoutSidecar["regions"],
			};
			if (notify && options.paperAbsPath)
				for (const listener of layoutWrites) listener(options.paperAbsPath);
		},
		tasks: backgroundTasks,
		analysis: layoutUi,
		render,
		get view() {
			return view;
		},
		get stateWrites() {
			return stateWrites;
		},
		get reflowInput() {
			return reflowInput;
		},
		async flush() {
			for (let i = 0; i < 12; i++) await Promise.resolve();
			return render();
		},
		unmount() {
			for (const slot of slots) {
				if (slot && typeof slot === "object" && "effect" in slot) {
					(slot as EffectSlot).cleanup?.();
				}
			}
		},
	};
}

function completed(run: RunOptions, translated = "Translated"): Item[] {
	return run.items.map((item) => ({ ...item, status: "done", translated }));
}

it("starts from an existing layout cache without a new parse or viewer file event", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.setCachedLayout([region(0)]);
	h.view.toggleLayoutTranslate();
	h.render();
	await h.flush();
	await h.flush();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.runs.length, 1);
	assert.equal(h.publishedLayouts.length, 1);
});

it("hydrates a partial sidecar and starts no translation request", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslatePendingRequired, 1);
	assert.equal(h.view.layoutTranslateFromCache, true);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"译文 0",
	);
});

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
function sharedSnapshot(items: Item[]): TranslationSnapshot {
	return {
		revision: 1,
		cacheKey: {
			providerId: "googleapi",
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "test",
		},
		items,
	} as TranslationSnapshot;
}

it("subscribes to a running automatic document without cancelling or starting requests", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob(),
		sharedSnapshot([
			{ ...region(0), status: "done", translated: "Already translated" },
			{ ...region(1), status: "running" },
		]),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.observers.length, 1);
	assert.equal(h.observers[0].start, true);
	assert.equal(h.runs.length, 0);
	assert.equal(h.cancels.length, 0);
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.ok((h.view.layoutTranslateProgress ?? 0) > 0);
	h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot(
			[0, 1].map((page) => ({
				...region(page),
				status: "done",
				translated: "Finished",
			})),
		),
	);
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslateItemsByPage.size, 2);
});

it("shows queued translation and continues when the same job starts", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(sharedJob("queued"), null);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslateQueued, true);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.queued");
	assert.equal(h.cancels.length, 0);
	h.publishShared(
		sharedJob(),
		sharedSnapshot([{ ...region(0), status: "running" }]),
	);
	await h.flush();
	assert.equal(h.view.layoutTranslateQueued, false);
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.runs.length, 0);
});

it("opens a complete paper cache without joining a blocked translation queue", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(sharedJob("queued"), null);
	h.setPrepareTransform((items) =>
		items.map((item) => ({ ...item, source: `Prepared ${item.source}` })),
	);
	h.setTranslateSidecar(
		[0, 1].map((page) => ({
			id: `region-${page}`,
			source: `Prepared Source ${page}`,
			translated: `Cached ${page}`,
		})),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.observers.length, 0);
	assert.equal(h.runs.length, 0);
	assert.equal(h.writes.length, 0);
	assert.equal(h.view.layoutTranslateQueued, false);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslateFromCache, true);
	assert.equal(h.reflowInput.length, 2);
	assert.equal(h.reflowInput[1].translated, "Cached 1");
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	assert.equal(h.cancels.length, 0);
	h.view.layoutTranslatePartial.onRetranslateAll();
	await h.flush();
	assert.equal(h.observers.length, 1);
	assert.equal(h.observers[0].start, true);
	assert.equal(h.observers[0].force, true);
});

it("opens a cached paper translation pane before its layout store is populated", async () => {
	const h = createHarness();
	h.setTranslateSidecar(
		[0, 1].map((page) => ({
			id: `region-${page}`,
			source: `Source ${page}`,
			translated: `Cached ${page}`,
		})),
	);
	h.setCachedLayout([region(0), region(1)]);
	h.render({
		vaultPath: "/vault",
		translationPane: true,
		layoutRawRegions: [],
	});
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.observers.length, 0);
	assert.equal(h.publishedLayouts.length, 1);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslateQueued, false);
	assert.equal(h.reflowInput.length, 2);
});

for (const translationPane of [false, true]) {
	it(`opens a partial paper cache with a warning and no automatic completion (${translationPane ? "translation pane" : "toolbar"})`, async () => {
		const h = createHarness();
		h.render({ vaultPath: "/vault", translationPane });
		h.setShared(sharedJob("queued"), null);
		h.setTranslateSidecar([
			{ id: "region-0", source: "Source 0", translated: "Cached" },
		]);
		h.view.toggleLayoutTranslate();
		await h.flush();
		assert.equal(h.observers.length, 0);
		assert.equal(h.runs.length, 0);
		assert.equal(h.writes.length, 0);
		assert.equal(h.view.layoutTranslateQueued, false);
		assert.equal(h.view.layoutTranslateRunning, false);
		assert.equal(h.view.layoutTranslateStatus, "partial");
		assert.equal(h.view.layoutTranslateFromCache, true);
		assert.equal(h.reflowInput.length, 2);
		assert.equal(h.reflowInput[0].translated, "Cached");
		assert.equal(h.reflowInput[1].translated, undefined);
		assert.equal(h.view.layoutTranslatePartial.visible, true);
		assert.equal(h.view.layoutTranslatePartial.open, false);
		assert.equal(h.view.layoutTranslatePartial.pendingRequired, 1);

		h.view.layoutTranslatePartial.onOpenChange(false);
		await h.flush();
		h.view.toggleLayoutTranslate();
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		h.view.toggleLayoutTranslate();
		await h.flush();
		assert.equal(
			h.view.layoutTranslateItemsByPage.get(0)?.[0].translated,
			"Cached",
		);
		assert.equal(h.observers.length, 0);

		h.setShared(
			sharedJob(),
			sharedSnapshot([
				{ ...region(0), status: "done", translated: "Cached" },
				{ ...region(1), status: "running" },
			]),
		);
		h.view.layoutTranslatePartial.onCompleteMissing();
		await h.flush();
		assert.equal(h.observers.length, 1);
		assert.equal(h.observers[0].start, true);
		assert.equal(h.observers[0].force, false);
		assert.equal(h.view.layoutTranslatePartial.open, false);
		assert.equal(h.view.layoutTranslatePageCounts?.total, 1);
		assert.equal(
			h.view.layoutTranslateItemsByPage.get(0)?.[0].translated,
			"Cached",
		);
		assert.equal(h.runs.length, 0);
	});
}

it("queues a paper when its sidecar does not match prepared source", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(sharedJob("queued"), null);
	h.setTranslateSidecar([
		{ id: "region-0", source: "Old source", translated: "Cached" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.observers.length, 1);
	assert.equal(h.observers[0].start, true);
	assert.equal(h.view.layoutTranslateQueued, true);
	assert.equal(h.runs.length, 0);
});

it("keeps a partial paper cache warning closed in a new document session without completing gaps", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "Cached" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.view.layoutTranslatePartial.onOpenChange(false);
	h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
	h.render({ docId: "paper-a", paperAbsPath: "/vault/papers/a" });
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.view.layoutTranslatePartial.open, false);
	assert.equal(h.observers.length, 0);
	assert.equal(h.runs.length, 0);
});

for (const action of ["stop", "close"] as const) {
	it(`${action} during paper cache preparation prevents a late render or enqueue`, async () => {
		const h = createHarness();
		h.render({ vaultPath: "/vault" });
		h.setTranslateSidecar(
			[0, 1].map((page) => ({
				id: `region-${page}`,
				source: `Source ${page}`,
				translated: `Cached ${page}`,
			})),
		);
		h.deferPrepare();
		h.view.toggleLayoutTranslate();
		await h.flush();
		assert.equal(h.view.layoutTranslateQueued, false);
		if (action === "stop") {
			h.view.toggleLayoutTranslate();
			h.render();
		} else h.unmount();
		const writes = h.stateWrites;
		h.releasePrepare();
		await h.flush();
		assert.equal(h.stateWrites, writes);
		assert.equal(h.observers.length, 0);
		assert.equal(h.cancels.length, 0);
	});
}

it("a page click joins automatic items and never cancels the document", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob(),
		sharedSnapshot(
			[0, 1].map((page) => ({ ...region(page), status: "running" })),
		),
	);
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.observers[0].start, false);
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	assert.equal(h.cancels.length, 0);
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), false);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.observers.at(-1)?.start, true);
	assert.equal(h.runs.length, 0);
	assert.equal(h.cancels.length, 0);
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), true);
});

it("closing a viewer detaches while the shared task continues", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob(),
		sharedSnapshot([{ ...region(0), status: "running" }]),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.unmount();
	assert.equal(h.observers[0].signal.aborted, true);
	assert.equal(h.cancels.length, 0);
	const writes = h.stateWrites;
	h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot([
			{ ...region(0), status: "done", translated: "Background result" },
		]),
	);
	await h.flush();
	assert.equal(h.stateWrites, writes);
});

it("the full-document stop action cancels the shared job", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob(),
		sharedSnapshot([{ ...region(0), status: "running" }]),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.deepEqual(h.cancels, ["bg-1"]);
	assert.equal(h.view.layoutTranslateStatus, "cancelled");
});

it("keeps shared partial recovery available and counts only the pages being completed", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	const partial = [
		{ ...region(0), status: "done", translated: "Cached" },
		{ ...region(1), status: "error" },
	];
	h.setShared(sharedJob("failed"), sharedSnapshot(partial));
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.open, true);
	h.view.layoutTranslatePartial.onOpenChange(false);
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.visible, true);

	h.setShared(
		sharedJob(),
		sharedSnapshot([partial[0], { ...region(1), status: "running" }]),
	);
	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateProgress, 0);
	assert.equal(h.view.layoutTranslatePageCounts?.done, 0);
	assert.equal(h.view.layoutTranslatePageCounts?.total, 1);
	h.publishShared(
		sharedJob("succeeded"),
		sharedSnapshot([
			partial[0],
			{ ...region(1), status: "done", translated: "Completed" },
		]),
	);
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.visible, false);
	assert.equal(h.view.layoutTranslatePageCounts?.done, 1);
	assert.equal(h.view.layoutTranslatePageCounts?.total, 1);
});

for (const allFailed of [false, true]) {
	it(`routes shared document failures through partial recovery (${allFailed ? "all blocks" : "some blocks"})`, async () => {
		const h = createHarness();
		h.render({ vaultPath: "/vault" });
		const message = "Translation service unavailable";
		h.setShared(
			{ ...sharedJob("failed"), error: allFailed ? message : null },
			sharedSnapshot([
				allFailed
					? { ...region(0), status: "error", error: message }
					: { ...region(0), status: "done", translated: "Saved translation" },
				{ ...region(1), status: "error", error: message },
			]),
		);
		h.view.toggleLayoutTranslate();
		await h.flush();
		assert.equal(h.errors.length, 0);
		assert.equal(h.view.layoutTranslatePartial.visible, true);
		assert.equal(h.view.layoutTranslatePartial.open, false);
		assert.equal(
			h.view.layoutTranslatePartial.pendingRequired,
			allFailed ? 2 : 1,
		);
	});
}

it("keeps a shared page failure toast with its translation settings action", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob("succeeded"),
		sharedSnapshot([
			{
				...region(0),
				status: "error",
				error: "Translation service unavailable",
			},
		]),
	);
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0]?.[0], "pdf.layoutTranslate.pageFailed");
	assert.equal(
		(h.errors[0]?.[1] as { action: { label: string } }).action.label,
		"pdf.layoutTranslate.openSettings",
	);
	assert.equal(h.view.layoutTranslatePartial.visible, false);
});

it("reports a shared task failure before any translation snapshot exists", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		{ ...sharedJob("failed"), error: "PDF preparation failed" },
		null,
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.errors.length, 1);
	assert.equal(h.view.layoutTranslatePartial.visible, false);
});

it("reports a shared cache write failure even when translation blocks also failed", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		{ ...sharedJob("failed"), error: "Cache write failed" },
		sharedSnapshot([
			{
				...region(0),
				status: "error",
				error: "Translation service unavailable",
			},
		]),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.errors.length, 1);
	assert.equal(
		(h.errors[0]?.[1] as { description: string }).description,
		"Cache write failed",
	);
	assert.equal(h.view.layoutTranslatePartial.visible, true);
});

it("resets a shared retranslation's progress after the previous run completed", async () => {
	const h = createHarness();
	h.render({ vaultPath: "/vault" });
	h.setShared(
		sharedJob("succeeded"),
		sharedSnapshot([{ ...region(0), status: "done", translated: "Finished" }]),
	);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.view.layoutTranslateProgress, 1);
	h.setShared(
		sharedJob(),
		sharedSnapshot([{ ...region(0), status: "running" }]),
	);
	h.view.layoutTranslatePartial.onRetranslateAll();
	await h.flush();
	assert.equal(h.view.layoutTranslateProgress, 0);
	assert.equal(h.observers.at(-1)?.force, true);
	assert.equal(h.runs.length, 0);
});

it.each([
	false,
	true,
])("filters old reference translations before a remote pane publishes cached blocks (saved layout: %s)", async (savedLayout) => {
	const h = createHarness();
	const reference = {
		...region(1),
		label: "reference",
		score: 1,
		text: "[1] Smith. A reference.",
	};
	h.setTranslateSidecar([
		{ ...region(0), translated: "正文缓存" },
		{ ...reference, translated: "旧参考文献译文" },
	]);
	if (savedLayout) h.setCachedLayout([region(0), reference]);
	h.deferPrepare();
	h.render({
		translationPane: true,
		vaultPath: "remote:server/vault",
		layoutRawRegions: savedLayout ? [] : [region(0), reference],
	});
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), false);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"正文缓存",
	);
	h.releasePrepare();
	await h.flush();
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(h.runs.length, 0);
});

it("waits for layout before publishing an unclassified remote sidecar without engine preparation", async () => {
	const h = createHarness();
	const reference = { ...region(1), label: "reference", score: 1 };
	h.setTranslateSidecar([
		{ ...region(0), translated: "正文缓存" },
		{ ...reference, translated: "旧参考文献译文" },
	]);
	h.render({
		translationPane: true,
		vaultPath: "remote:server/vault",
		layoutRawRegions: [],
	});
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	h.render({ layoutRawRegions: [region(0), reference] });
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), false);
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(h.runs.length, 0);
});

it("hydrates a remote translation pane through the cache path", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "Cached" },
	]);
	h.render({ translationPane: true, vaultPath: "remote:server/vault" });
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.runs.length, 0);
	assert.equal(h.observers.length, 0);
});

for (const action of ["stop", "close"] as const) {
	it(`${action} while enqueueing ${action === "stop" ? "cancels" : "retains"} the eventual shared job`, async () => {
		const h = createHarness();
		h.render({ vaultPath: "/vault" });
		h.setShared(sharedJob(), null);
		h.deferShared();
		h.view.toggleLayoutTranslate();
		await h.flush();
		if (action === "stop") {
			h.view.toggleLayoutTranslate();
			h.render();
		} else h.unmount();
		h.finishShared();
		await h.flush();
		assert.deepEqual(h.cancels, action === "stop" ? ["bg-1"] : []);
	});
}

it("hydrates a complete sidecar as done without a translation request", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
		{ id: "region-1", source: "Source 1", translated: "译文 1" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(h.view.layoutTranslateItemsByPage.size, 2);
});

it("shows the partial entry without opening the dialog after cached pages load", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	// Page generation and missing translations never open the popover.
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.view.layoutTranslatePartial.open, false);
	assert.equal(h.view.layoutTranslatePartial.pendingRequired, 1);
	assert.equal(h.view.layoutTranslatePartial.translatedCount, 1);
	assert.equal(h.view.layoutTranslatePartial.totalCount, 2);
	assert.deepEqual(h.view.layoutTranslatePartial.pageRange, {
		start: 2,
		end: 2,
	});

	h.view.layoutTranslatePartial.onOpenChange(false);
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, false);
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	h.view.layoutTranslatePartial.onOpenChange(true);
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, true);
});

it("keeps a closed partial hint closed during repeated cache hydration", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.setReflowReady(true);
	h.render();
	h.view.layoutTranslatePartial.onOpenChange(true);
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, true);
	h.view.layoutTranslatePartial.onOpenChange(false);
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, false);
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	// A repeated layout notification must not reopen the same gap set.
	h.render({ translationPane: true, layoutRawRegions: [region(0), region(1)] });
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.open, false);
	h.view.layoutTranslatePartial.onOpenChange(true);
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, true);
});

it("offers pending-only completion when a translation pane reopens a partial cache", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.render({ translationPane: true });
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.view.layoutTranslatePartial.open, false);
	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	assert.equal(h.runs.length, 1);
	assert.equal(h.runs[0].items[0].status, "done");
	assert.equal(h.runs[0].items[0].translated, "译文 0");
	assert.equal(h.runs[0].items[1].status, "running");
	h.runs[0].resolve([
		h.runs[0].items[0],
		{ ...h.runs[0].items[1], status: "done", translated: "补全译文" },
	]);
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePartial.visible, false);
});

it("does not let a late translation-pane hydrate erase a completed recovery", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.render({ translationPane: true });
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "partial");

	h.deferPrepare();
	h.render({
		translationPane: true,
		layoutRawRegions: [region(0), region(1)],
	});
	await h.flush();
	assert.equal(h.runs.length, 0);

	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	assert.equal(h.runs.length, 1);
	h.runs[0].resolve(completed(h.runs[0], "补全译文"));
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePendingRequired, 0);

	// The older hydrate started before the recovery and is still preparing.
	h.releasePrepare();
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"补全译文",
	);
	assert.equal(h.runs.length, 1);
});

it("keeps the partial hint closed when a translation pane returns to the document", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.render({ translationPane: true });
	await h.flush();
	h.view.layoutTranslatePartial.onOpenChange(false);
	h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
	await h.flush();
	h.render({ docId: "paper-a", paperAbsPath: "/vault/papers/a" });
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.view.layoutTranslatePartial.open, false);
});

it("completes only pending blocks and rewrites the sidecar", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.setReflowReady(true);
	h.render();
	const writes = h.writes.length;
	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	assert.equal(h.runs.length, 1);
	assert.equal(h.runs[0].items[0].status, "done");
	assert.equal(h.runs[0].items[0].translated, "译文 0");
	assert.equal(h.runs[0].items[1].status, "running");
	assert.equal(h.runs[0].items[1].translated, undefined);
	assert.equal(h.view.layoutTranslateRunning, true);
	h.runs[0].resolve(
		h.runs[0].items.map((item, index) =>
			index === 0
				? { ...item, status: "done", translated: "译文 0" }
				: { ...item, status: "done", translated: "补全译文" },
		),
	);
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"译文 0",
	);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"补全译文",
	);
	assert.equal(h.writes.length, writes + 1);
});

it("keeps the partial entry after a failed completion without reopening", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.setReflowReady(true);
	h.render();
	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	h.runs[0].resolve([
		h.runs[0].items[0],
		{ ...h.runs[0].items[1], status: "error", error: "boom" },
	]);
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslatePendingRequired, 1);
	assert.equal(h.view.layoutTranslatePartial.visible, true);
	assert.equal(h.view.layoutTranslatePartial.open, false);
	assert.equal(h.view.layoutTranslatePartial.completionFailed, true);
	assert.equal(h.errors.length, 0);
});

for (const action of ["initial", "retranslate"] as const) {
	it(`keeps local ${action} document failures in the partial entry`, async () => {
		const h = createHarness();
		h.view.toggleLayoutTranslate();
		await h.flush();
		if (action === "retranslate") {
			h.runs[0].resolve([
				{ ...h.runs[0].items[0], status: "done", translated: "Saved" },
				{
					...h.runs[0].items[1],
					status: "error",
					error: "Service unavailable",
				},
			]);
			await h.flush();
			h.view.layoutTranslatePartial.onRetranslateAll();
			await h.flush();
		}
		const run = h.runs.at(-1);
		assert.ok(run);
		run.resolve(
			run.items.map((item) => ({
				...item,
				status: "error",
				error: "Service unavailable",
			})),
		);
		await h.flush();
		assert.equal(h.errors.length, 0);
		assert.equal(h.view.layoutTranslatePartial.visible, true);
		assert.equal(h.view.layoutTranslatePartial.open, false);
		assert.equal(
			h.view.layoutTranslatePartial.pendingRequired,
			action === "retranslate" ? 1 : 2,
		);
		if (action === "retranslate")
			assert.equal(
				h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
				"Saved",
			);
	});
}

it("opens the partial card when translate is clicked after a failure", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.setReflowReady(true);
	h.render();
	h.view.layoutTranslatePartial.onCompleteMissing();
	await h.flush();
	h.runs[0].resolve([
		h.runs[0].items[0],
		{ ...h.runs[0].items[1], status: "error", error: "boom" },
	]);
	await h.flush();
	assert.equal(h.view.layoutTranslatePartial.open, false);
	// The main button surfaces the warning instead of hiding existing pages.
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, true);
	// Closing the popover preserves its warning and manual recovery entry.
	h.view.layoutTranslatePartial.onOpenChange(false);
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslatePartial.open, true);
});

it("retranslates everything and restores old text for failed blocks", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
		{ id: "region-1", source: "Source 1", translated: "译文 1" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.setReflowReady(true);
	h.render();
	h.view.layoutTranslatePartial.onRetranslateAll();
	await h.flush();
	assert.equal(h.runs.length, 1);
	assert.deepEqual(
		h.runs[0].items.map((item) => item.status),
		["pending", "pending"],
	);
	// Old text stays painted while the confirmed rerun streams.
	assert.equal(h.runs[0].items[0].translated, "译文 0");
	h.runs[0].resolve([
		{ ...h.runs[0].items[0], status: "done", translated: "新译文 0" },
		{ ...h.runs[0].items[1], status: "error", error: "boom" },
	]);
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslatePendingRequired, 0);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"新译文 0",
	);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"译文 1",
	);
	const lastWrite = h.writes.at(-1)?.[2] as Item[] | undefined;
	assert.equal(
		lastWrite?.find((item) => item.id === "region-1")?.translated,
		"译文 1",
	);
});

it("loads the layout when a headless parse writes it without a viewer file event", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.view.toggleLayoutTranslate();
	h.render();
	await h.flush();
	h.setCachedLayout([region(0)], true);
	await h.flush();
	await h.flush();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.runs.length, 1);
});

it("does not load a cached layout after the wait has been cancelled", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.setCachedLayout([region(0)]);
	h.view.toggleLayoutTranslate();
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	await h.flush();
	assert.equal(h.publishedLayouts.length, 0);
	assert.equal(h.runs.length, 0);
});

it("exits preparation and reports an enqueue failure", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.view.toggleLayoutTranslate();
	h.render();
	const request = h.enqueues[0][0] as { onError: (error: unknown) => void };
	request.onError(new Error("enqueue failed"));
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.errors.length, 1);
});

it("ignores a replaced whole-document run's late result", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.view.toggleLayoutTranslate(); // stop
	h.render();
	h.view.toggleLayoutTranslate(); // restart before the old request settles
	await h.flush();
	assert.equal(h.runs.length, 2);
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0], "Old"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.writes.length, writes);
	h.runs[1].resolve(completed(h.runs[1], "New"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"New",
	);
});

it("does not let an old page run cancel a different page run", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(1);
	await h.flush();
	assert.equal(h.runs[0].signal.aborted, true);
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0]));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.view.layoutTranslatePageStateByPage.get(0)?.running, false);
	assert.equal(h.writes.length, writes);
});

it("stops spinners immediately and keeps completed blocks", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.runs[0].onUpdate([
		completed(h.runs[0], "Keep this")[0],
		{ ...h.runs[0].items[1], status: "running" },
	]);
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslatePageStateByPage.get(1)?.running, false);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Keep this",
	);
});

it("retries a stopped page before the old request settles", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(0); // stop
	h.render();
	h.view.togglePageLayoutTranslate(0); // retry
	await h.flush();
	assert.equal(h.runs.length, 2);
	assert.equal(h.view.layoutTranslateRunning, true);
});

it("hides a stopped document instead of resuming translation", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.runs[0].onUpdate([
		completed(h.runs[0], "Keep this")[0],
		{ ...h.runs[0].items[1], status: "running" },
	]);
	h.render();
	h.view.toggleLayoutTranslate(); // stop
	h.render();
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	h.view.toggleLayoutTranslate(); // hide, do not resume
	h.render();
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.show");
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	h.view.toggleLayoutTranslate(); // show retained text
	await h.flush();
	assert.equal(h.runs.length, 1);
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslateStatus, "cancelled");
	assert.equal(h.view.layoutTranslatePendingRequired, 1);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Keep this",
	);
});

it("switches a partial cache without translating again", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "译文 0" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	h.view.toggleLayoutTranslate(); // hide
	h.render();
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.show");
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	h.view.toggleLayoutTranslate(); // show
	await h.flush();
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	assert.equal(h.view.layoutTranslateItemsByPage.size, 2);
	assert.equal(h.runs.length, 0);
});

for (const mode of ["document", "page"]) {
	it(`keeps overlays hidden after a late ${mode} result without losing completed text`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.runs[0].onUpdate(completed(h.runs[0], "Visible progress"));
		h.render();
		if (mode === "document") {
			h.view.toggleLayoutTranslate();
			h.render();
		}
		// A page-only run is hidden from its page tag; the toolbar owns the
		// whole document and would start a document run here.
		if (mode === "document")
			h.view.toggleLayoutTranslate(); // hide
		else h.view.togglePageLayoutTranslate(0); // hide
		h.render();
		const writes = h.writes.length;
		h.runs[0].resolve(completed(h.runs[0], "Late"));
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		if (mode === "document") assert.equal(h.writes.length, writes);
		else assert.ok(h.writes.length > writes);
		if (mode === "document")
			h.view.toggleLayoutTranslate(); // show retained
		else h.view.togglePageLayoutTranslate(0); // show retained
		await h.flush();
		assert.equal(
			h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
			mode === "document" ? "Visible progress" : "Late",
		);
		assert.equal(h.runs.length, 1);
	});

	it(`discards late ${mode} results when switching documents`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
		const writes = h.writes.length;
		h.runs[0].resolve(completed(h.runs[0], "Wrong document"));
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		assert.equal(h.writes.length, writes);
	});

	it(`ignores late ${mode} results after unmount`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.unmount();
		const writes = h.writes.length;
		const stateWrites = h.stateWrites;
		h.runs[0].resolve(completed(h.runs[0]));
		for (let i = 0; i < 12; i++) await Promise.resolve();
		assert.equal(h.stateWrites, stateWrites);
		assert.equal(h.writes.length, writes);
	});
}

it("ignores stale progress and errors after a replacement starts", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(1);
	await h.flush();
	const writes = h.writes.length;
	h.runs[0].onUpdate(completed(h.runs[0], "Stale progress"));
	h.runs[0].reject(new Error("Late failure"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.errors.length, 0);
	assert.equal(h.writes.length, writes);
});

it("persists a successful current page and completes its job", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0], "Current result"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, false);
	// A page-only job never makes the toolbar look like a document translation.
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Current result",
	);
	assert.equal(h.writes.length, writes + 1);
});

it("flushes the sidecar as soon as a run completes", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].resolve(completed(h.runs[0], "刚写完"));
	await h.flush();
	assert.equal(h.flushes.length, 1);
	assert.equal(
		(h.flushes[0]?.[2] as Item[] | undefined)?.[0]?.translated,
		"刚写完",
	);
});

it("reuses finished document blocks when a page restarts before the cache write lands", async () => {
	const h = createHarness();
	// The runtime works on prepared (protected) sources, not the raw region
	// text; simulate that so the post-prepare reuse is what keeps a0 done.
	h.setPrepareTransform((items) =>
		items.map((item) => ({ ...item, source: `prepared:${item.source}` })),
	);
	h.render({
		layoutRawRegions: [
			{ ...region(0), id: "a0", source: "A0" },
			{ ...region(0), id: "a1", source: "A1" },
			{ ...region(1), id: "b0", source: "B0" },
		],
	});
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.runs[0].resolve([
		{ ...h.runs[0].items[0], status: "done", translated: "译文 A0" },
		{ ...h.runs[0].items[1], status: "error", error: "boom" },
		{ ...h.runs[0].items[2], status: "done", translated: "译文 B0" },
	]);
	await h.flush();
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	// Retry page 0 immediately: the sidecar may still be stale, so the finished
	// block must come from the in-memory prepared items.
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	assert.equal(h.runs.length, 2);
	assert.deepEqual(
		h.runs[1].items.map((item) => [
			item.id,
			item.status,
			item.translated ?? null,
		]),
		[
			["a0", "done", "译文 A0"],
			["a1", "pending", null],
		],
	);
});

it("does not abort a document run when a pending page tag is clicked", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.runs[0].onUpdate([
		{ ...h.runs[0].items[0], status: "running" },
		{ ...h.runs[0].items[1], status: "pending" },
	]);
	h.render();
	h.view.togglePageLayoutTranslate(1); // page 1 is still queued in the doc run
	h.render();
	assert.equal(h.runs[0].signal.aborted, false);
	assert.equal(h.runs.length, 1);
	assert.equal(h.view.layoutTranslateRunning, true);
});

it("hydrates a page from the sidecar without a request", async () => {
	const h = createHarness();
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "缓存页面" },
	]);
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	assert.equal(h.runs.length, 0);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"缓存页面",
	);
	// Still a page-scoped job: the toolbar offers the whole document.
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	assert.equal(h.view.layoutTranslatePartial.visible, false);
});

it("reports a page translation failure as a page failure", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].reject(
		new Error("Unexpected Tencent Transmart translation response"),
	);
	await h.flush();
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0]?.[0], "pdf.layoutTranslate.pageFailed");
	assert.equal(h.view.layoutTranslateStatus, "partial");
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	// The document-level partial dialog stays out of a page-only failure.
	assert.equal(h.view.layoutTranslatePartial.visible, false);
});

it("restores a hidden page through its page tag without translating or writing again", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].resolve(completed(h.runs[0], "Saved page"));
	await h.flush();
	const writes = h.writes.length;
	const reflowInput = h.reflowInput;
	h.view.togglePageLayoutTranslate(0); // hide
	h.render();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	assert.equal(h.reflowInput, reflowInput);
	h.view.togglePageLayoutTranslate(0); // show
	await h.flush();
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Saved page",
	);
	assert.equal(h.view.layoutTranslatePageStateByPage.get(0)?.active, true);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	assert.equal(h.runs.length, 1);
	assert.equal(h.writes.length, writes);
	assert.equal(h.reflowInput, reflowInput);
});

it("starts a cache-first document run from the toolbar after a page-only translation", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].resolve(completed(h.runs[0], "Saved page"));
	await h.flush();
	// The auto-translation sidecar is complete for the whole paper.
	h.setTranslateSidecar([
		{ id: "region-0", source: "Source 0", translated: "Saved page" },
		{ id: "region-1", source: "Source 1", translated: "Cached page two" },
	]);
	h.view.toggleLayoutTranslate();
	await h.flush();
	// Cache-first document hydrate: no second request, both pages rendered.
	assert.equal(h.runs.length, 1);
	assert.equal(h.view.layoutTranslateStatus, "done");
	assert.equal(h.view.layoutTranslateItemsByPage.size, 2);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"Cached page two",
	);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	h.view.toggleLayoutTranslate(); // hide the whole document
	h.render();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.show");
});

it("resets hidden pages when switching documents", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].resolve(completed(h.runs[0], "Old page"));
	await h.flush();
	h.view.togglePageLayoutTranslate(0);
	h.render();
	h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[1].resolve(completed(h.runs[1], "New page"));
	await h.flush();
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"New page",
	);
});

it("keeps a hidden page while another page finishes and restores it from its page tag", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.runs[0].resolve(completed(h.runs[0], "First page"));
	await h.flush();
	h.view.togglePageLayoutTranslate(0); // hide
	h.render();
	h.view.togglePageLayoutTranslate(1);
	await h.flush();
	h.runs[1].resolve(completed(h.runs[1], "Second page"));
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.has(0), false);
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), true);
	const writes = h.writes.length;
	h.view.togglePageLayoutTranslate(0); // show the first page
	await h.flush();
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"First page",
	);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"Second page",
	);
	h.view.togglePageLayoutTranslate(1); // hide the second page
	h.render();
	assert.equal(h.view.layoutTranslateItemsByPage.has(1), false);
	assert.equal(h.view.layoutTranslateItemsByPage.has(0), true);
	assert.equal(h.runs.length, 2);
	assert.equal(h.writes.length, writes);
});

it("queues behind layout analysis and auto-starts when regions land", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.tasks.setState({
		tasks: [
			{
				id: "job-1",
				kind: "layoutAnalyze",
				status: "running",
				paperPath: "papers/a",
			},
		],
	});
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, true);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.waiting");
	assert.equal(h.runs.length, 0);
	assert.equal(h.actions.length, 0);
	assert.equal(h.enqueues.length, 1); // explicitly promotes the existing parse
	assert.equal((h.enqueues[0][0] as { focus: boolean }).focus, true);

	h.render({ layoutRawRegions: [region(0)] });
	await h.flush();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.runs.length, 1);
	assert.equal(h.successes.length, 0);
});

it("cancels the queued wait on a second toggle", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.tasks.setState({
		tasks: [
			{
				id: "job-1",
				kind: "layoutAnalyze",
				status: "queued",
				paperPath: "papers/a",
			},
		],
	});
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, true);
	h.view.toggleLayoutTranslate(); // cancel
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.runs.length, 0);
	assert.equal(h.dismissed.length, 1); // queued toast dismissed
	h.render({ layoutRawRegions: [region(0)] });
	await h.flush();
	assert.equal(h.runs.length, 0); // no auto-start after cancel
	assert.equal(h.successes.length, 0);
});

it("cancels the queued wait when the tracked parse job fails", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.tasks.setState({
		tasks: [
			{
				id: "job-1",
				kind: "layoutAnalyze",
				status: "running",
				paperPath: "papers/a",
			},
		],
	});
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, true);
	h.tasks.setState({
		tasks: [
			{
				id: "job-1",
				kind: "layoutAnalyze",
				status: "failed",
				paperPath: "papers/a",
			},
		],
	});
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.warnings.length, 1);
	assert.equal(
		h.warnings[0]?.[0],
		"pdf.layoutTranslate.parseFailedWhileWaiting",
	);
	h.render({ layoutRawRegions: [region(0)] });
	await h.flush();
	assert.equal(h.runs.length, 0);
});

it("enqueues layout analysis when nothing is pending and ignores stale failures", () => {
	const h = createHarness();
	h.tasks.setState({
		tasks: [
			{
				id: "old-job",
				kind: "layoutAnalyze",
				status: "failed",
				paperPath: "papers/a",
			},
		],
	});
	h.render({ layoutRawRegions: [] });
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, true); // stale failure ignored
	assert.equal(h.enqueues.length, 1); // nothing pending → parse enqueued
	assert.equal(h.actions.length, 0);
});

it("keeps the legacy hint for a loose PDF with nothing to enqueue", () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [], paperAbsPath: null, paperRelPath: null });
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, false);
	assert.equal(h.runs.length, 0);
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0]?.[0], "pdf.layoutTranslate.needLayout");
	assert.equal(h.enqueues.length, 0);
});

it("queues a page translate behind an in-viewer layout run", async () => {
	const h = createHarness();
	h.render({ layoutRawRegions: [] });
	h.analysis.setState({
		ui: { stage: "running" },
		activeDocumentId: "paper-a",
	});
	h.render();
	h.view.togglePageLayoutTranslate(0);
	h.render();
	assert.equal(h.view.layoutTranslateWaiting, true);
	assert.equal(h.runs.length, 0);
	h.render({ layoutRawRegions: [region(0), region(1)] });
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.runs.length, 1);
	assert.equal(h.runs[0].items.length, 1); // only the queued page
	assert.equal(h.successes.length, 0);
});
