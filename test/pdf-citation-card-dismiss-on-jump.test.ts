import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { it } from "vitest";

// Drive the real usePdfCitations hook (#528): after clicking an in-text
// citation link jumps within the PDF, the hover reference card must dismiss —
// the scroll strands a stationary pointer, so no pointerleave ever fires.
const hookCode = ts.transpileModule(
	readFileSync(
		new URL(
			"../src/components/viewer/pdf/hooks/use-pdf-citations.ts",
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

import { type PdfLinkAnnoObject, PdfZoomMode } from "@embedpdf/models";
import { getLinkDestination } from "@/components/viewer/pdf/layers/citation-links";
import * as citationDestKeys from "@/lib/pdf/citation-dest-keys";

const { citationDestKey } = citationDestKeys;

type Link = Pick<PdfLinkAnnoObject, "pageIndex" | "rect" | "target">;

type View = {
	citationPreview: { matched: { id: string }[] } | null;
	handleCitationLinkHover: (link: Link | null) => void;
	handleCitationLinkActivate: (link: Link) => void;
};

type EffectSlot = {
	deps: readonly unknown[];
	cleanup: (() => void) | undefined;
	effect: true;
};

function citationLink(destPdfY: number): Link {
	return {
		pageIndex: 3,
		rect: { origin: { x: 100, y: 600 }, size: { width: 20, height: 10 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 9,
				zoom: {
					mode: PdfZoomMode.XYZ,
					params: { x: 72, y: destPdfY },
				} as never,
				view: [72, destPdfY, 1],
			},
		},
	} as Link;
}

function createHarness(navigateOutcome: { outcome: string; uri?: string }) {
	const slots: unknown[] = [];
	const openedUrls: string[] = [];
	const jumps: unknown[] = [];
	const sidecarBox: {
		current: { citations: { id: string; rawKey: string }[] } | null;
	} = { current: null };
	const mapsBox: {
		current: { cites: Map<string, string>; citationLinks: [] } | null;
	} = { current: null };
	let cursor = 0;
	let dirty = true;
	let effects: (() => void)[] = [];
	let view: View;
	const react = {
		useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
			const index = cursor++;
			if (!(index in slots)) slots[index] = initial;
			return [
				slots[index] as T,
				(next) => {
					slots[index] =
						typeof next === "function"
							? (next as (prev: T) => T)(slots[index] as T)
							: next;
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
	const isFloatingDialogActive = () => false;
	const loadPdfDestMaps = async () => mapsBox.current;
	const modules: Record<string, unknown> = {
		react,
		"@/components/viewer/pdf/coords": {
			pageElByIndex: () => ({}),
			rectBottomCenterScreen: () => ({ x: 120, y: 240 }),
		},
		"@/components/viewer/pdf/floating-hover": {
			EPHEMERAL_PREVIEW_HIDE_MS: 400,
			isFloatingDialogActive,
		},
		// Mirrors the real useStickyHoverHide machine on the harness's mock
		// React primitives, so the extracted hook keeps its semantics here.
		"@/components/viewer/pdf/hooks/use-sticky-hover-hide": {
			useStickyHoverHide: ({
				delayMs,
				hide,
				hold,
			}: {
				delayMs: number;
				hide: () => void;
				hold?: () => boolean;
			}) => {
				const hideTimerRef = react.useRef<number | null>(null);
				const hoverSurfaceRef = react.useRef(false);
				const cancelHide = react.useCallback(() => {
					if (hideTimerRef.current == null) return;
					clearTimeout(hideTimerRef.current);
					hideTimerRef.current = null;
				});
				const markHoverEnter = react.useCallback(() => {
					hoverSurfaceRef.current = true;
					cancelHide();
				});
				const scheduleHide = react.useCallback(() => {
					hoverSurfaceRef.current = false;
					cancelHide();
					hideTimerRef.current = setTimeout(() => {
						hideTimerRef.current = null;
						if (hoverSurfaceRef.current) return;
						if (isFloatingDialogActive()) {
							hoverSurfaceRef.current = true;
							return;
						}
						if (hold?.()) return;
						hide();
					}, delayMs);
				});
				return { hoverSurfaceRef, cancelHide, markHoverEnter, scheduleHide };
			},
		},
		"@/components/viewer/pdf/layers/citation-links": {
			getLinkDestination,
		},
		"@/hooks/use-app-stores": {
			useVaultStore: (selector: (s: { tree: unknown }) => unknown) =>
				selector({ tree: null }),
		},
		"@/hooks/use-citation-import": {
			useCitationImport: () => ({
				folders: [],
				lastImportParentDir: "papers",
				importingId: null,
				importCitation: () => {},
			}),
		},
		"@/hooks/use-paper-refs-sidecar": {
			usePaperRefsSidecar: () => ({
				get sidecar() {
					return sidecarBox.current;
				},
				setSidecar: (next: unknown) => {
					sidecarBox.current = next as typeof sidecarBox.current;
				},
			}),
		},
		"@/hooks/use-papers-org-folders": { usePapersOrgFolders: () => [] },
		"@/lib/core/error": { errorText: String },
		"@/lib/core/logger": { logger: { warn: () => {} } },
		"@/lib/core/notify": { notifyError: () => {} },
		"@/lib/core/open-external": {
			openExternalUrl: (url: string) => openedUrls.push(url),
		},
		"@/lib/paper/import-actions": { lookupSubmit: async () => {} },
		// Real pure helpers so dest-key building and matching are exercised.
		"@/lib/pdf/citation-dest-keys": citationDestKeys,
		"@/lib/pdf/citation-dest-map": {
			loadPdfDestMaps,
			// Mirrors the real helper: idle-deferred (this harness runs idle
			// callbacks synchronously), cancellable, non-fatal on rejection.
			schedulePdfDestMapsBuild: ({
				paperAbsPath,
				documentId,
				viewerBytes,
				onMaps,
			}: {
				paperAbsPath: string | null;
				documentId?: string | null;
				viewerBytes: () => ArrayBuffer | null;
				warnLabel: string;
				onMaps: (maps: unknown) => void;
			}) => {
				let cancelled = false;
				void (async () => {
					const maps = await loadPdfDestMaps({
						paperAbsPath,
						viewerBytes: viewerBytes(),
						documentId,
					});
					if (cancelled || !maps) return;
					onMaps(maps);
				})().catch(() => {});
				return () => {
					cancelled = true;
				};
			},
		},
	};
	const exported = {} as { usePdfCitations: (options: unknown) => View };
	runInNewContext(hookCode, {
		exports: exported,
		requestIdleCallback: (fn: () => void) => {
			fn();
			return 0;
		},
		cancelIdleCallback: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		require(name: string) {
			assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
			return modules[name];
		},
	});
	const options = {
		docId: "paper-a",
		annotationCap: {
			navigateTarget: () => ({
				toPromise: () => Promise.resolve(navigateOutcome),
			}),
		},
		hostRef: { current: null },
		zoomRef: { current: 1 },
		vaultPath: "/vault",
		paperPath: "papers/a",
		paperAbsPath: "/vault/papers/a",
		onBeforeInternalJump: () => {},
		onInternalJump: (target: unknown) => jumps.push(target),
	};
	function render(): View {
		for (let pass = 0; pass < 10; pass++) {
			cursor = 0;
			dirty = false;
			// biome-ignore lint/correctness/useHookAtTopLevel: Test driver uses mocked hook slots, not React.
			view = exported.usePdfCitations(options);
			const pendingEffects = effects;
			effects = [];
			for (const effect of pendingEffects) effect();
			if (!dirty) return view;
		}
		throw new Error("Hook did not settle");
	}
	// Seed before the first render: the dest-map effect loads once per deps,
	// so a later assignment would never be picked up.
	sidecarBox.current = {
		citations: [{ id: "c1", rawKey: "cite.evans2021" }],
	};
	mapsBox.current = {
		cites: new Map([[citationDestKey(9, 500), "cite.evans2021"]]),
		citationLinks: [],
	};
	render();
	async function flush(): Promise<View> {
		for (let i = 0; i < 12; i++) await Promise.resolve();
		return render();
	}
	return {
		sidecarBox,
		mapsBox,
		openedUrls,
		jumps,
		render,
		flush,
		get view() {
			return view;
		},
	};
}

async function showCard(h: ReturnType<typeof createHarness>) {
	await h.flush();
	const link = citationLink(500);
	h.view.handleCitationLinkHover(link);
	h.render();
	assert.equal(
		h.view.citationPreview?.matched?.[0]?.id,
		"c1",
		"card must be showing before the jump",
	);
	return link;
}

it("dismisses the reference card when the citation link jumps (#528)", async () => {
	const h = createHarness({ outcome: "navigated" });
	const link = await showCard(h);
	h.view.handleCitationLinkActivate(link);
	await h.flush();
	assert.equal(h.view.citationPreview, null);
	assert.equal(h.jumps.length, 1, "jump-back pairing still commits");
});

it("keeps the card for a uri link (external open does not move the page)", async () => {
	const h = createHarness({ outcome: "uri", uri: "https://example.org" });
	const link = await showCard(h);
	h.view.handleCitationLinkActivate(link);
	await h.flush();
	assert.equal(h.openedUrls[0], "https://example.org");
	assert.notEqual(h.view.citationPreview, null);
	assert.equal(h.jumps.length, 0);
});
