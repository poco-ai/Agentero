import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { it } from "vitest";
import {
	layoutSidecarNeedsTextLayer,
	type PdfLayoutSidecar,
} from "@/lib/pdf/layout/io";
import * as translateProgress from "@/lib/pdf/layout/layout-translate-progress";

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
	readingOrder: number;
	source: string;
	status?: string;
	translated?: string;
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
	docId: string;
	paperAbsPath: string | null;
	paperRelPath?: string | null;
	layoutRawRegions: Item[];
};

type View = {
	layoutTranslateItemsByPage: ReadonlyMap<number, readonly Item[]>;
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
	layoutTranslateRunning: boolean;
	layoutTranslateWaiting: boolean;
	layoutTranslateLabel: string;
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
		useCallback: <T>(callback: T) => callback,
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
		listTranslatableLayoutRegions: (regions: Item[]) => regions,
		toLayoutTranslateItems: (regions: Item[]) =>
			regions.map((item) => ({ ...item, status: "pending" })),
		currentLayoutTranslateCacheKey: () => ({
			providerId: "test",
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "test",
		}),
		readLayoutTranslateSidecar: async () => null,
		applyLayoutTranslateSidecar: (items: Item[]) => items,
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
	const prepareReflow = async (items: Item[]) => items;
	const modules: Record<string, unknown> = {
		"./use-pdf-reflow": {
			usePdfReflow: (_context: unknown, _regions: unknown, items: Item[]) => {
				reflowInput = items;
				return {
					reflowItems: items,
					prepare: prepareReflow,
					reflowBusy: false,
					reflowReady: false,
					exportTranslatedPdf: async () => {},
				};
			},
		},
		react,
		"react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
		sonner: {
			toast: { dismiss: (...args: unknown[]) => dismissed.push(args) },
		},
		zustand: {
			useStore: <T, S>(store: FakeStore<T>, selector: (state: T) => S): S =>
				selector(store.getState()),
		},
		"@/lib/core/background-tasks": { backgroundTasksStore: backgroundTasks },
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
		publishedLayouts,
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

it("resumes a stopped document and reuses its completed blocks", async () => {
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
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.start");
	h.view.toggleLayoutTranslate(); // resume
	await h.flush();
	assert.equal(h.runs.length, 2);
	assert.equal(h.runs[1].items[0].translated, "Keep this");
	assert.equal(h.runs[1].items[0].status, "done");
	assert.equal(h.view.layoutTranslateRunning, true);
});

for (const mode of ["document", "page"]) {
	it(`keeps overlays hidden after a late ${mode} result without losing completed text`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.runs[0].onUpdate(completed(h.runs[0], "Visible progress"));
		h.render();
		h.view.toggleLayoutTranslate(); // stop
		h.render();
		h.view.toggleLayoutTranslate(); // hide
		h.render();
		const writes = h.writes.length;
		h.runs[0].resolve(completed(h.runs[0], "Late"));
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		assert.equal(h.writes.length, writes);
		h.view.toggleLayoutTranslate(); // show retained progress
		await h.flush();
		assert.equal(
			h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
			"Visible progress",
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
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Current result",
	);
	assert.equal(h.writes.length, writes + 1);
});

for (const entry of ["toolbar", "page"]) {
	it(`restores a hidden page through the ${entry} without translating or writing again`, async () => {
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
		assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.show");
		assert.equal(h.reflowInput, reflowInput);
		if (entry === "toolbar") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		assert.equal(
			h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
			"Saved page",
		);
		assert.equal(h.view.layoutTranslatePageStateByPage.get(0)?.active, true);
		assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.hide");
		assert.equal(h.runs.length, 1);
		assert.equal(h.writes.length, writes);
		assert.equal(h.reflowInput, reflowInput);
	});
}

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

it("keeps a hidden page while another page finishes and shows both from the toolbar", async () => {
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
	h.view.toggleLayoutTranslate(); // show the first page, preserving the second
	await h.flush();
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"First page",
	);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(1)?.[0]?.translated,
		"Second page",
	);
	h.view.toggleLayoutTranslate(); // hide both
	h.render();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
	h.view.toggleLayoutTranslate(); // show both
	await h.flush();
	assert.equal(h.view.layoutTranslateItemsByPage.size, 2);
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
