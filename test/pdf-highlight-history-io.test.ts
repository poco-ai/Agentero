// @vitest-environment happy-dom

import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import {
	PdfAnnotationSubtype,
	type PdfDocumentObject,
	type PdfEngine,
	PdfTaskHelper,
} from "@embedpdf/models";
import {
	type AnnotationPlugin,
	AnnotationPluginPackage,
} from "@embedpdf/plugin-annotation";
import { InteractionManagerPluginPackage } from "@embedpdf/plugin-interaction-manager";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
	type PdfHighlights,
	usePdfHighlights,
} from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { loadAnnotationItems } from "@/lib/pdf/highlight/annotation-store";
import {
	type PdfHistoryCapability,
	PdfHistoryPluginPackage,
} from "@/lib/pdf/highlight/history";

const caps = vi.hoisted(() => ({
	history: null as PdfHistoryCapability | null,
}));
vi.mock("@embedpdf/core/react", () => ({
	useCapability: () => ({ provides: caps.history }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/vault/file-change-gate", () => ({
	listenVaultFileChangedGated: () => () => {},
}));

it("persists undone notes on unmount, mirrors undo/redo to peers and reloads without history", async () => {
	const registry = new PluginRegistry({
		// PDFium returns an entry for every page, including pages without annotations.
		getAllAnnotations: () => PdfTaskHelper.resolve({ 0: [] }),
		createPageAnnotation: () => PdfTaskHelper.resolve(true),
		updatePageAnnotation: () => PdfTaskHelper.resolve(true),
		removePageAnnotation: () => PdfTaskHelper.resolve(true),
	} as unknown as PdfEngine);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	registry.registerPlugin(PdfHistoryPluginPackage);
	registry.registerPlugin(AnnotationPluginPackage);
	await registry.initialize();
	caps.history = registry
		.getPlugin("history")
		?.provides() as PdfHistoryCapability;
	const annotationCap = registry
		.getPlugin<AnnotationPlugin>("annotation")
		?.provides();
	if (!annotationCap) throw new Error("Missing annotations");
	const documents = new Map<string, PdfDocumentObject>();
	for (const id of ["main", "embed", "reopened"]) {
		const doc = {
			id,
			pageCount: 1,
			pages: [{ index: 0, size: { width: 600, height: 800 } }],
		} as PdfDocumentObject;
		documents.set(id, doc);
		registry.getStore().dispatchToCore(startLoadingDocument(id));
		registry.getStore().dispatchToCore(setDocumentLoaded(id, doc));
	}
	const paperAbsPath = "/test-vault/papers/history-io";
	const docCap = {
		getDocument: (id: string) => documents.get(id),
	} as Parameters<typeof usePdfHighlights>[0]["docCap"];
	const onHighlightsChangeRef = { current: vi.fn() };
	const hooks = new Map<string, PdfHighlights>();
	function Viewer({ id }: { id: string }) {
		hooks.set(
			id,
			usePdfHighlights({
				annotationCap,
				docCap,
				docId: id,
				paperAbsPath,
				paperKey: "papers/history-io",
				totalPages: 1,
				onHighlightsChangeRef,
			}),
		);
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const mount = async (ids: string[]) => {
		await act(async () =>
			root.render(
				createElement(
					"div",
					null,
					...ids.map((id) => createElement(Viewer, { key: id, id })),
				),
			),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	};
	const replay = async (redo: boolean) => {
		await act(async () => {
			hooks.get("main")?.replayAnnotationHistory(redo);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	try {
		await mount(["main", "embed"]);
		await act(async () => {
			hooks.get("main")?.runAnnotationBatch(() => {
				annotationCap.forDocument("main").createAnnotation(0, {
					id: "note",
					pageIndex: 0,
					type: PdfAnnotationSubtype.HIGHLIGHT,
					rect: { origin: { x: 10, y: 20 }, size: { width: 50, height: 10 } },
					custom: { quote: "quote" },
				});
				hooks.get("main")?.updateHighlightComment(0, "note", "my note");
			});
		});
		expect(hooks.get("embed")?.highlights[0].comment).toBe("my note");
		expect(caps.history.forDocument("embed").canUndo()).toBe(false);
		await replay(false);
		expect(hooks.get("main")?.highlights).toEqual([]);
		expect(hooks.get("embed")?.highlights).toEqual([]);
		await replay(true);
		expect(hooks.get("embed")?.highlights[0].comment).toBe("my note");
		// The main instance's pending save flushes its current (undone) snapshot.
		await replay(false);
		await mount([]);
		expect(await loadAnnotationItems(paperAbsPath)).toEqual([]);
		await mount(["reopened"]);
		expect(hooks.get("reopened")?.highlights).toEqual([]);
		expect(caps.history.forDocument("reopened").canUndo()).toBe(false);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		await registry.destroy();
		caps.history = null;
	}
});
