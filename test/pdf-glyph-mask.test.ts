import { afterEach, describe, expect, it, vi } from "vitest";
import { glyphMaskBlob, removeGlyphPaper } from "@/lib/pdf/reading/glyph-mask";

afterEach(() => vi.unstubAllGlobals());

describe("reading glyph masks", () => {
	it.each([
		true,
		false,
	])("releases bitmap and canvas after encoding (success: %s)", async (success) => {
		const close = vi.fn();
		const output = new Blob(["mask"], { type: "image/png" });
		let complete!: (blob: Blob | null) => void;
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({
				drawImage: vi.fn(),
				getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
				putImageData: vi.fn(),
			}),
			toBlob: (callback: typeof complete) => {
				complete = callback;
			},
		};
		vi.stubGlobal("createImageBitmap", async () => ({
			width: 40,
			height: 20,
			close,
		}));
		vi.stubGlobal("document", { createElement: () => canvas });
		const mask = glyphMaskBlob(new Blob(["source"]));
		await Promise.resolve();
		expect([canvas.width, canvas.height]).toEqual([40, 20]);
		expect(close).not.toHaveBeenCalled();
		complete(success ? output : null);
		if (success) await expect(mask).resolves.toBe(output);
		else await expect(mask).rejects.toThrow("encoding failed");
		expect(close).toHaveBeenCalledOnce();
		expect([canvas.width, canvas.height]).toEqual([0, 0]);
	});
	it("removes a painted pastel paper rectangle while preserving antialiased ink", () => {
		const rgba = new Uint8ClampedArray([
			231, 232, 242, 255, 0, 0, 0, 255, 116, 116, 121, 255,
		]);
		removeGlyphPaper(rgba);
		expect(rgba[3]).toBe(0);
		expect(rgba[7]).toBe(255);
		expect(rgba[11]).toBeCloseTo(127, -1);
	});
	it("retains transparent backgrounds and solid dark strokes without inventing holes", () => {
		const rgba = new Uint8ClampedArray([
			0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255,
		]);
		removeGlyphPaper(rgba);
		expect([...rgba].filter((_, i) => i % 4 === 3)).toEqual([0, 128, 255]);
	});
});
