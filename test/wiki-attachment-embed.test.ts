import { describe, expect, it, vi } from "vitest";
import {
	createWikiImageObjectUrlLease,
	parseWikiImageEmbedDimensions,
} from "@/components/editor/embeds/wiki-attachment-embed";
import type { WikiEmbedResponse } from "@/lib/wiki";
import { wikiEmbedResponseKind } from "@/lib/wiki-embed";

function attachmentResponse(contentKind: "image" | "pdf"): WikiEmbedResponse {
	return {
		contentKind,
		link: {
			status: "resolved",
			targetPath: `assets/example.${contentKind === "image" ? "png" : "pdf"}`,
			occurrence: {
				source: "notes/source.md",
				targetRaw: "example",
				syntax: "wikilink",
				embed: true,
				sourceRange: { start: 0, end: 0 },
				line: 1,
			},
		},
	};
}

describe("parseWikiImageEmbedDimensions", () => {
	it("accepts Obsidian width and width-by-height aliases", () => {
		expect(parseWikiImageEmbedDimensions("100")).toEqual({ width: 100 });
		expect(parseWikiImageEmbedDimensions("640x480")).toEqual({
			width: 640,
			height: 480,
		});
	});

	it("does not treat ordinary display aliases as image dimensions", () => {
		expect(parseWikiImageEmbedDimensions("Figure 1")).toBeNull();
		expect(parseWikiImageEmbedDimensions("0")).toBeNull();
		expect(parseWikiImageEmbedDimensions("100x")).toBeNull();
	});
});

describe("createWikiImageObjectUrlLease", () => {
	it("creates a fresh URL after a StrictMode-style cleanup and releases each once", () => {
		const createObjectURL = vi
			.fn()
			.mockReturnValueOnce("blob:first")
			.mockReturnValueOnce("blob:second");
		const revokeObjectURL = vi.fn();
		const urlApi = { createObjectURL, revokeObjectURL };
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

		const first = createWikiImageObjectUrlLease(
			bytes,
			"assets/example.jpg",
			urlApi,
		);
		first.release();
		first.release();
		const second = createWikiImageObjectUrlLease(
			bytes,
			"assets/example.jpg",
			urlApi,
		);

		expect(first.source).toBe("blob:first");
		expect(second.source).toBe("blob:second");
		expect(createObjectURL).toHaveBeenCalledTimes(2);
		expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
		expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe(
			"image/jpeg",
		);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

		second.release();
		expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:second");
	});
});

describe("wikiEmbedResponseKind", () => {
	it("treats resolved image and PDF attachments as renderable", () => {
		expect(wikiEmbedResponseKind(attachmentResponse("image"))).toBe("ready");
		expect(wikiEmbedResponseKind(attachmentResponse("pdf"))).toBe("ready");
	});
});
