import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import {
	PdfAnnotationSubtype,
	type PdfDocumentObject,
	type PdfEngine,
	type PdfHighlightAnnoObject,
	PdfTaskHelper,
	Task,
} from "@embedpdf/models";
import {
	type AnnotationPlugin,
	AnnotationPluginPackage,
} from "@embedpdf/plugin-annotation";
import { InteractionManagerPluginPackage } from "@embedpdf/plugin-interaction-manager";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection";
import { expect, it, vi } from "vitest";
import { isLiveAnnotation } from "@/lib/pdf/highlight/annotation-store";
import { createAnnotationDeleteQueue } from "@/lib/pdf/highlight/delete-queue";
import {
	createAnnotationHistoryReplay,
	type PdfHistoryCapability,
	PdfHistoryPluginPackage,
} from "@/lib/pdf/highlight/history";

const highlight = (id: string, pageIndex = 0): PdfHighlightAnnoObject => ({
	id,
	pageIndex,
	type: PdfAnnotationSubtype.HIGHLIGHT,
	rect: { origin: { x: 10, y: 20 }, size: { width: 60, height: 10 } },
	strokeColor: "#ffff00",
});

async function viewer(engineOverrides: Partial<PdfEngine> = {}) {
	const engine = {
		getAllAnnotations: () => PdfTaskHelper.resolve({}),
		createPageAnnotation: vi.fn(() => PdfTaskHelper.resolve(true)),
		updatePageAnnotation: vi.fn(() => PdfTaskHelper.resolve(true)),
		removePageAnnotation: vi.fn(() => PdfTaskHelper.resolve(true)),
		...engineOverrides,
	} as unknown as PdfEngine;
	const registry = new PluginRegistry(engine);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	registry.registerPlugin(PdfHistoryPluginPackage);
	registry.registerPlugin(AnnotationPluginPackage);
	await registry.initialize();
	for (const id of ["doc", "other"]) {
		registry.getStore().dispatchToCore(startLoadingDocument(id));
		registry.getStore().dispatchToCore(
			setDocumentLoaded(id, {
				id,
				pageCount: 2,
				pages: [0, 1].map((index) => ({
					index,
					size: { width: 600, height: 800 },
				})),
			} as PdfDocumentObject),
		);
	}
	const annotations = registry
		.getPlugin<AnnotationPlugin>("annotation")
		?.provides()
		.forDocument("doc");
	const capability = registry
		.getPlugin("history")
		?.provides() as PdfHistoryCapability;
	if (!annotations || !capability)
		throw new Error("Missing annotation/history capability");
	const history = capability.forDocument("doc");
	const onError = vi.fn();
	const queue = createAnnotationDeleteQueue(
		annotations,
		onError,
		history.withoutRecording,
	);
	const replay = createAnnotationHistoryReplay(annotations, history, onError);
	return {
		annotations,
		history,
		otherHistory: capability.forDocument("other"),
		queue,
		replay,
		onError,
		live: () =>
			annotations
				.getAnnotations()
				.filter(isLiveAnnotation)
				.map((item) => item.object),
		async dispose() {
			replay.dispose();
			queue.dispose();
			await registry.destroy();
		},
	};
}

it("groups a multi-page note into one undo/redo, saves live annotations and isolates documents", async () => {
	const h = await viewer();
	try {
		h.history.batch(() => {
			h.annotations.createAnnotation(0, highlight("first"));
			h.annotations.createAnnotation(1, highlight("second", 1));
			h.annotations.updateAnnotation(0, "first", { contents: "my note" });
		});
		expect(h.live()).toHaveLength(2);
		expect(h.otherHistory.canUndo()).toBe(false);
		await h.replay.replay(false);
		expect(h.live()).toEqual([]);
		expect(h.history.canUndo()).toBe(false);
		expect(await h.annotations.exportAnnotations().toPromise()).toEqual([]);
		await h.replay.replay(true);
		expect(h.live()).toHaveLength(2);
		expect(h.live()[0].contents).toBe("my note");
		expect(h.annotations.getState().pages[0]).toEqual(["first"]);
		h.annotations.updateAnnotation(0, "first", { strokeColor: "#ff0000" });
		await h.replay.replay(false);
		expect(h.live()[0].strokeColor).toBe("#ffff00");
		h.annotations.updateAnnotation(0, "first", { contents: "new edit" });
		expect(h.history.canRedo()).toBe(false);
		h.queue.delete(0, "first");
		await h.replay.replay(false);
		expect(h.live()[1].contents).toBe("new edit");
		expect(h.onError).not.toHaveBeenCalled();
	} finally {
		await h.dispose();
	}
});

it("excludes imports and peer updates, invalidating only conflicting history groups", async () => {
	const h = await viewer();
	try {
		h.history.withoutRecording(() =>
			h.annotations.importAnnotations([{ annotation: highlight("loaded") }]),
		);
		expect(h.history.canUndo()).toBe(false);
		h.annotations.createAnnotation(0, highlight("local"));
		h.annotations.updateAnnotation(0, "loaded", { contents: "local note" });
		h.history.invalidate(["loaded"]);
		h.history.withoutRecording(() =>
			h.annotations.updateAnnotation(0, "loaded", { contents: "peer note" }),
		);
		await h.replay.replay(false);
		expect(h.live().map((item) => item.id)).toEqual(["loaded"]);
		expect(h.live()[0].contents).toBe("peer note");
		expect(h.history.canUndo()).toBe(false);
	} finally {
		await h.dispose();
	}
});

it("waits for in-flight updates and deletion retries before restoring a deleted note", async () => {
	const update = new Task<boolean, never>();
	const deletion = new Task<boolean, never>();
	let deleting = true;
	const h = await viewer({
		updatePageAnnotation: () => update,
		removePageAnnotation: () =>
			deleting ? deletion : PdfTaskHelper.resolve(true),
	});
	try {
		h.annotations.createAnnotation(0, highlight("note"));
		h.annotations.updateAnnotation(0, "note", { contents: "saved text" });
		h.queue.delete(0, "note");
		const undone = h.replay.replay(false);
		await Promise.resolve();
		expect(h.live()).toEqual([]);
		update.resolve(true);
		await Promise.resolve();
		deleting = false;
		deletion.resolve(true);
		await undone;
		expect(h.live()[0].contents).toBe("saved text");
		await h.replay.replay(false);
		expect(h.live()[0].contents).toBeUndefined();
		expect(h.onError).not.toHaveBeenCalled();
	} finally {
		await h.dispose();
	}
});
