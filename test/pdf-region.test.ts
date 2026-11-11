import { describe, expect, it, vi } from "vitest";

import {
	renderPdfRegionImageBlob,
	renderPdfRegionPromptImage,
} from "@/components/viewer/pdf/region-crop";
import {
	expandNormalizedRegion,
	normalizedRegionFromPoints,
	normalizedRegionToPdfRect,
	unionNormalizedRegions,
} from "@/lib/pdf/region";

describe("PDF visual regions", () => {
	it("preserves dark formula ink by compositing on paper before making the glyph mask", async () => {
		// Some Wiley/IET glyphs disappear on a transparent PDFium surface.
		// Model that renderer result here and
		// exercise the real crop -> glyphMaskBlob -> removeGlyphPaper pipeline.
		let painted = false;
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({
				drawImage: (bitmap: { painted: boolean }) => {
					painted = bitmap.painted;
				},
				getImageData: () => ({
					data: new Uint8ClampedArray([
						0,
						0,
						0,
						painted ? 255 : 0,
						255,
						255,
						255,
						255,
					]),
				}),
				putImageData: (image: { data: Uint8ClampedArray }) => {
					painted = image.data[3] === 255 && image.data[7] === 0;
				},
			}),
			toBlob: (complete: (blob: Blob) => void) =>
				complete(new Blob([painted ? "ink" : "missing"])),
		};
		vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
			width: 2,
			height: 1,
			painted: (await blob.text()) === "opaque",
			close: () => undefined,
		}));
		vi.stubGlobal("document", { createElement: () => canvas });
		try {
			const engine = {
				renderPageRect: (
					_doc: unknown,
					_page: unknown,
					_rect: unknown,
					options: { transparentBackground?: boolean },
				) => ({
					toPromise: async () =>
						new Blob([
							options.transparentBackground ? "transparent" : "opaque",
						]),
				}),
			};
			const mask = await renderPdfRegionImageBlob({
				engine: engine as never,
				document: { pages: [{ size: { width: 600, height: 800 } }] } as never,
				pageIndex: 0,
				region: { x: 0.8, y: 0.6, w: 0.05, h: 0.01 },
				transparentBackground: true,
			});
			expect(await mask.text()).toBe("ink");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("normalizes a drag in either direction", () => {
		const region = normalizedRegionFromPoints(
			{ x: 0.8, y: 0.7 },
			{ x: 0.2, y: 0.1 },
		);
		expect(region?.x).toBeCloseTo(0.2);
		expect(region?.y).toBeCloseTo(0.1);
		expect(region?.w).toBeCloseTo(0.6);
		expect(region?.h).toBeCloseTo(0.6);
	});

	it("ignores click-sized regions", () => {
		expect(
			normalizedRegionFromPoints({ x: 0.4, y: 0.4 }, { x: 0.401, y: 0.401 }),
		).toBeNull();
	});

	it("unions multi-line formula selections", () => {
		const region = unionNormalizedRegions([
			{ x: 0.2, y: 0.3, w: 0.25, h: 0.04 },
			{ x: 0.18, y: 0.36, w: 0.42, h: 0.04 },
		]);
		expect(region?.x).toBeCloseTo(0.18);
		expect(region?.y).toBeCloseTo(0.3);
		expect(region?.w).toBeCloseTo(0.42);
		expect(region?.h).toBeCloseTo(0.1);
	});

	it("pads and clamps a crop at page edges", () => {
		const region = expandNormalizedRegion(
			{ x: 0.98, y: 0.01, w: 0.05, h: 0.08 },
			0.02,
		);
		expect(region.x).toBeCloseTo(0.96);
		expect(region.y).toBe(0);
		expect(region.w).toBeCloseTo(0.04);
		expect(region.h).toBeCloseTo(0.11);
	});

	it("maps normalized coordinates into PDF points", () => {
		const rect = normalizedRegionToPdfRect(
			{ x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
			{ width: 600, height: 800 },
		);
		expect(rect?.origin.x).toBeCloseTo(150);
		expect(rect?.origin.y).toBeCloseTo(80);
		expect(rect?.size.width).toBeCloseTo(300);
		expect(rect?.size.height).toBeCloseTo(160);
	});

	it("renders crops from the exact framed region", async () => {
		let capturedRect: NonNullable<
			ReturnType<typeof normalizedRegionToPdfRect>
		> | null = null;
		const page = {
			index: 0,
			size: { width: 600, height: 800 },
			rotation: 0,
			objectNumber: 1,
		};
		const engine = {
			renderPageRect: (
				_document: unknown,
				_page: unknown,
				rect: typeof capturedRect,
			) => {
				capturedRect = rect;
				return {
					toPromise: async () =>
						new Blob([new Uint8Array([1])], { type: "image/png" }),
				};
			},
		};

		await renderPdfRegionPromptImage({
			engine: engine as never,
			document: {
				id: "doc",
				pageCount: 1,
				pages: [page],
				isEncrypted: false,
				isOwnerUnlocked: true,
				permissions: 0,
				normalizedRotation: true,
			},
			pageIndex: 0,
			region: { x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
		});

		expect(capturedRect?.origin.x).toBeCloseTo(150);
		expect(capturedRect?.origin.y).toBeCloseTo(80);
		expect(capturedRect?.size.width).toBeCloseTo(300);
		expect(capturedRect?.size.height).toBeCloseTo(160);
	});

	it("uses explicit scaleFactor when supplied, capped by maxEdgePx", async () => {
		let capturedOptions: { scaleFactor?: number } | undefined;
		const page = {
			index: 0,
			size: { width: 600, height: 800 },
			rotation: 0,
			objectNumber: 1,
		};
		const engine = {
			renderPageRect: (
				_doc: unknown,
				_pg: unknown,
				_rect: unknown,
				options?: { scaleFactor?: number },
			) => {
				capturedOptions = options;
				return {
					toPromise: async () =>
						new Blob([new Uint8Array([1])], { type: "image/png" }),
				};
			},
		};

		await renderPdfRegionPromptImage({
			engine: engine as never,
			document: {
				id: "doc",
				pageCount: 1,
				pages: [page],
				isEncrypted: false,
				isOwnerUnlocked: true,
				permissions: 0,
				normalizedRotation: true,
			},
			pageIndex: 0,
			region: { x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
			scaleFactor: 3.5,
		});

		expect(capturedOptions?.scaleFactor).toBe(3.5);

		// Still capped by maxEdgePx: 300 pt longest edge × 4 > 600 px.
		await renderPdfRegionPromptImage({
			engine: engine as never,
			document: {
				id: "doc",
				pageCount: 1,
				pages: [page],
				isEncrypted: false,
				isOwnerUnlocked: true,
				permissions: 0,
				normalizedRotation: true,
			},
			pageIndex: 0,
			region: { x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
			scaleFactor: 4,
			maxEdgePx: 600,
		});
		expect(capturedOptions?.scaleFactor).toBe(2);
	});
});
