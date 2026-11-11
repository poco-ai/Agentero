import { PluginRegistry, startLoadingDocument } from "@embedpdf/core";
import {
	PdfAnnotationSubtype,
	type PdfEngine,
	type PdfHighlightAnnoObject,
	type PdfLinkAnnoObject,
} from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation";
import {
	AnnotationPlugin,
	AnnotationPluginPackage,
} from "@embedpdf/plugin-annotation";
import { InteractionManagerPluginPackage } from "@embedpdf/plugin-interaction-manager";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection";
import { describe, expect, it } from "vitest";
import {
	dedupeAnnotationItems,
	planAnnotationItemImport,
} from "@/lib/pdf/highlight/annotation-items";

function link(id: string, pageIndex = 0): AnnotationTransferItem {
	return {
		annotation: {
			id,
			pageIndex,
			type: PdfAnnotationSubtype.LINK,
			rect: { origin: { x: 10, y: 20 }, size: { width: 30, height: 10 } },
			target: { type: "destination", destination: { pageIndex: 2, view: [] } },
			contents: "",
		} as PdfLinkAnnoObject,
	};
}

function highlight(
	id: string,
	overrides: Partial<PdfHighlightAnnoObject> = {},
): AnnotationTransferItem {
	return {
		annotation: {
			id,
			pageIndex: 0,
			type: PdfAnnotationSubtype.HIGHLIGHT,
			rect: { origin: { x: 10, y: 20 }, size: { width: 30, height: 10 } },
			strokeColor: "#fcd34d",
			color: "#fcd34d",
			opacity: 0.4,
			contents: "",
			...overrides,
		} as PdfHighlightAnnoObject,
	};
}

describe("annotation transfer deduplication", () => {
	it("collapses repeated native links with fresh ids and different key order", () => {
		const original = link("first");
		const { target, ...rest } = link("second").annotation;
		const reordered = { annotation: { target, ...rest } };
		const input = [original, reordered, link("third")];
		expect(dedupeAnnotationItems(input)).toEqual([original]);
		expect(input).toHaveLength(3);
	});

	it("preserves different targets, positions, styles and metadata", () => {
		const items = [link("original"), link("page", 1)];
		for (const patch of [
			{
				target: {
					type: "destination",
					destination: { pageIndex: 3, view: [] },
				},
			},
			{ rect: { origin: { x: 11, y: 20 }, size: { width: 30, height: 10 } } },
			{ strokeColor: "#ff0000" },
			{ contents: "different note" },
			{ custom: { id: "target-reference" } },
		]) {
			const item = link(`different-${items.length}`);
			items.push({
				annotation: { ...item.annotation, ...patch },
			} as AnnotationTransferItem);
		}
		expect(dedupeAnnotationItems(items)).toEqual(items);
	});

	it("preserves transfer contexts without comparing binary data as JSON", () => {
		const items = [link("context-a"), link("context-b")].map((item, i) => ({
			...item,
			ctx: { data: new Uint8Array([i]).buffer, mimeType: "image/png" as const },
		}));
		expect(dedupeAnnotationItems(items)).toEqual(items);
	});

	it("does not collapse separate user highlights at the same position", () => {
		const items = [link("note-one"), link("note-two")].map((item) => ({
			annotation: { ...item.annotation, type: PdfAnnotationSubtype.HIGHLIGHT },
		})) as AnnotationTransferItem[];
		expect(dedupeAnnotationItems(items)).toEqual(items);
		expect(dedupeAnnotationItems([items[0], items[0]])).toEqual([items[0]]);
	});

	it("skips native links already loaded in the current document", () => {
		const native = link("pdfium-id").annotation;
		const imported = link("persisted-id");
		expect(dedupeAnnotationItems([imported], [native])).toEqual([]);
	});

	it("matches nullable native fields against omitted fields after sidecar serialization", () => {
		const native = {
			...link("pdfium-id").annotation,
			strokeDashArray: null,
			author: null,
			modified: null,
			created: null,
			custom: null,
		} as unknown as PdfLinkAnnoObject;
		const saved = link("sidecar-id");
		const oldCopy = {
			annotation: native,
			ctx: null,
		} as unknown as AnnotationTransferItem;
		expect(
			planAnnotationItemImport([saved, oldCopy], [native]).imports,
		).toEqual([]);
		expect(dedupeAnnotationItems([saved, oldCopy])).toEqual([saved]);
		expect(native).toHaveProperty("custom", null);
	});

	it("preserves meaningful nested null metadata and populated optional fields", () => {
		const items = [
			link("empty"),
			...[
				{ custom: { reference: null } },
				{ custom: {} },
				{ author: "Researcher" },
				{ created: new Date("2026-01-01T00:00:00Z") },
				{ strokeDashArray: [3, 2] },
			].map((patch, index) => ({
				annotation: { ...link(`optional-${index}`).annotation, ...patch },
			})),
		];
		expect(dedupeAnnotationItems(items)).toEqual(items);
	});

	it("stays bounded across export and reopen instead of accumulating native copies", () => {
		let saved = Array.from({ length: 100 }, (_, index) => link(`old-${index}`));
		for (let open = 0; open < 3; open++) {
			const native = link(`native-${open}`);
			const incoming = dedupeAnnotationItems(saved, [native.annotation]);
			expect(incoming).toHaveLength(0);
			saved = dedupeAnnotationItems([native, ...saved]);
			expect(saved).toHaveLength(1);
		}
	});

	it("restores saved highlight overrides instead of re-importing the same native id", () => {
		const native = highlight("stable-highlight", {
			contents: "",
			strokeColor: "#ffff00",
			color: "#ffff00",
			custom: { paletteKey: "yellow", quote: "selection" },
		}).annotation;
		const saved = highlight("stable-highlight", {
			contents: "saved note",
			strokeColor: "#ef4444",
			color: "#ef4444",
			custom: { paletteKey: "red", quote: "selection" },
		});

		const plan = planAnnotationItemImport([saved], [native]);

		expect(plan.imports).toEqual([]);
		expect(plan.highlightOverrides).toHaveLength(1);
		expect(plan.highlightOverrides[0]).toMatchObject({
			pageIndex: 0,
			id: "stable-highlight",
			patch: {
				contents: "saved note",
				strokeColor: "#ef4444",
				color: "#ef4444",
				custom: { paletteKey: "red", quote: "selection" },
			},
		});
	});

	it("does not update an identical native highlight or append a second page id", () => {
		const native = highlight("stable-highlight", {
			custom: { paletteKey: "yellow", quote: "selection" },
		}).annotation;
		const saved = highlight("stable-highlight", {
			custom: { quote: "selection", paletteKey: "yellow" },
		});

		const plan = planAnnotationItemImport([saved], [native]);

		expect(plan.imports).toEqual([]);
		expect(plan.highlightOverrides).toEqual([]);
	});

	it("still imports a new highlight while suppressing redundant native links", () => {
		const native = link("native-link").annotation;
		const savedLink = link("saved-link");
		const savedHighlight = highlight("new-highlight");

		const plan = planAnnotationItemImport(
			[savedLink, savedHighlight],
			[native],
		);

		expect(plan.imports).toEqual([savedHighlight]);
		expect(plan.highlightOverrides).toEqual([]);
	});

	it("updates the real plugin store without appending a duplicate page id", async () => {
		const registry = new PluginRegistry({} as PdfEngine);
		registry.registerPlugin(InteractionManagerPluginPackage);
		registry.registerPlugin(SelectionPluginPackage);
		registry.registerPlugin(AnnotationPluginPackage, { autoCommit: false });
		try {
			await registry.initialize();
			const docId = "stable-highlight";
			registry.getStore().dispatchToCore(startLoadingDocument(docId));
			registry.getStore().dispatchToPlugin(AnnotationPlugin.id, {
				type: "ANNOTATION/SET_ANNOTATIONS",
				payload: {
					documentId: docId,
					annotations: {
						0: [highlight("native-highlight").annotation],
					},
				},
			});

			const plugin = registry.getPlugin<AnnotationPlugin>(AnnotationPlugin.id);
			if (!plugin) throw new Error("Annotation plugin did not initialize");
			const scope = plugin.provides().forDocument(docId);
			const saved = highlight("native-highlight", {
				contents: "saved note",
				strokeColor: "#ef4444",
				color: "#ef4444",
			});
			const plan = planAnnotationItemImport(
				[saved],
				scope.getAnnotations().map(({ object }) => object),
			);

			scope.updateAnnotations(plan.highlightOverrides);

			const annotations = scope.getAnnotations();
			expect(annotations).toHaveLength(1);
			expect(annotations[0]?.object).toMatchObject({
				id: "native-highlight",
				contents: "saved note",
				strokeColor: "#ef4444",
			});
		} finally {
			await registry.destroy();
		}
	});
});
