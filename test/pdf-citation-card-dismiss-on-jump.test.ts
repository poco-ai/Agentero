// @vitest-environment happy-dom

import { type PdfLinkAnnoObject, PdfZoomMode } from "@embedpdf/models";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EPHEMERAL_PREVIEW_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import {
	type UsePdfCitationsOptions,
	usePdfCitations,
} from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { mountHook } from "./helpers/mount";
import { useFakeTimers } from "./helpers/timers";

// Real hook + real sticky-hover state machine (#528): after an in-text citation
// link jumps within the PDF, the scroll strands a stationary pointer, so no
// pointerleave fires and the activate callback must dismiss the card itself.
const io = vi.hoisted(() => ({
	openedUrls: [] as string[],
	jumps: [] as unknown[],
	outcome: { outcome: "navigated" } as { outcome: string; uri?: string },
}));

vi.mock("@/components/viewer/pdf/coords", () => ({
	pageElByIndex: () => document.createElement("div"),
	rectBottomCenterScreen: () => ({ x: 120, y: 240 }),
}));
vi.mock("@/hooks/use-app-stores", () => ({
	useVaultStore: (selector: (s: { tree: unknown }) => unknown) =>
		selector({ tree: null }),
}));
vi.mock("@/hooks/use-citation-import", () => ({
	useCitationImport: () => ({
		folders: [],
		lastImportParentDir: "papers",
		importingId: null,
		importCitation: () => {},
	}),
}));
vi.mock("@/hooks/use-paper-refs-sidecar", () => ({
	usePaperRefsSidecar: () => ({
		sidecar: { citations: [{ id: "c1", rawKey: "cite.evans2021" }] },
		setSidecar: () => {},
	}),
}));
vi.mock("@/hooks/use-papers-org-folders", () => ({
	usePapersOrgFolders: () => [],
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: () => {} }));
vi.mock("@/lib/core/open-external", () => ({
	openExternalUrl: (url: string) => io.openedUrls.push(url),
}));
vi.mock("@/lib/paper/import-actions", () => ({ lookupSubmit: async () => {} }));
vi.mock("@/lib/pdf/citation-dest-map", async () => {
	const { citationDestKey } = await import("@/lib/pdf/citation-dest-keys");
	return {
		schedulePdfDestMapsBuild: ({
			onMaps,
		}: {
			onMaps: (maps: unknown) => void;
		}) => {
			onMaps({
				cites: new Map([[citationDestKey(9, 500), "cite.evans2021"]]),
				citationLinks: [],
				pageOrigins: [],
			});
			return () => {};
		},
	};
});

// biome-ignore lint/correctness/useHookAtTopLevel: vitest timer helper, not a React hook.
useFakeTimers();

const mounted: { unmount: () => Promise<void> }[] = [];
beforeEach(() => {
	io.openedUrls.length = 0;
	io.jumps.length = 0;
	io.outcome = { outcome: "navigated" };
});
afterEach(async () => {
	for (const hook of mounted.splice(0)) await hook.unmount();
});

function citationLink(): PdfLinkAnnoObject {
	return {
		pageIndex: 3,
		rect: { origin: { x: 100, y: 600 }, size: { width: 20, height: 10 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 9,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 72, y: 500 } },
				view: [72, 500, 1],
			},
		},
	} as unknown as PdfLinkAnnoObject;
}

async function mountWithCard() {
	const hook = mountHook(usePdfCitations, {
		docId: "paper-a",
		annotationCap: {
			navigateTarget: () => ({ toPromise: () => Promise.resolve(io.outcome) }),
		},
		hostRef: { current: null },
		zoomRef: { current: 1 },
		vaultPath: "/vault",
		paperPath: "papers/a",
		paperAbsPath: "/vault/papers/a",
		onBeforeInternalJump: () => {},
		onInternalJump: (target: unknown) => io.jumps.push(target),
	} as unknown as UsePdfCitationsOptions);
	mounted.push(hook);
	await hook.render();
	const link = citationLink();
	await act(async () => hook.result.current.handleCitationLinkHover(link));
	expect(hook.result.current.citationPreview?.matched[0]?.id).toBe("c1");
	return { hook, link };
}

it("dismisses the reference card when the citation link jumps (#528)", async () => {
	const { hook, link } = await mountWithCard();
	await act(async () => hook.result.current.handleCitationLinkActivate(link));
	expect(hook.result.current.citationPreview).toBeNull();
	expect(io.jumps).toHaveLength(1);
});

it("keeps the card for a uri link (external open does not move the page)", async () => {
	io.outcome = { outcome: "uri", uri: "https://example.org" };
	const { hook, link } = await mountWithCard();
	await act(async () => hook.result.current.handleCitationLinkActivate(link));
	expect(io.openedUrls).toEqual(["https://example.org"]);
	expect(hook.result.current.citationPreview).not.toBeNull();
	expect(io.jumps).toHaveLength(0);
});

it("hides the card through the real sticky-hover timer after the pointer leaves", async () => {
	const { hook, link } = await mountWithCard();
	await act(async () => hook.result.current.handleCitationLinkHover(null));
	await act(async () => vi.advanceTimersByTime(EPHEMERAL_PREVIEW_HIDE_MS - 1));
	expect(hook.result.current.citationPreview).not.toBeNull();
	// Re-entering the link cancels the pending hide.
	await act(async () => {
		hook.result.current.handleCitationLinkHover(link);
		vi.advanceTimersByTime(EPHEMERAL_PREVIEW_HIDE_MS);
	});
	expect(hook.result.current.citationPreview).not.toBeNull();
	await act(async () => {
		hook.result.current.handleCitationLinkHover(null);
		vi.advanceTimersByTime(EPHEMERAL_PREVIEW_HIDE_MS);
	});
	expect(hook.result.current.citationPreview).toBeNull();
});
