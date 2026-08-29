import type { FileUIPart } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import {
	dataUrlToPromptImage,
	fileUiPartsToPromptImages,
	imagePathsFromDataTransfer,
	isImageFile,
} from "@/lib/agent/prompt-image";
import { isPhysicalPointInRect } from "@/lib/agent/tauri-file-drop";
import {
	dataTransferLooksLikeImages,
	dataTransferLooksLikePdfs,
	dataTransferLooksLikeVaultMove,
	fileMatchesAccept,
	filesFromDataTransfer,
	isImageMimeOrUti,
	isPdfMimeOrUti,
} from "@/lib/core/file-accept";
import {
	beginVaultFileDrag,
	endVaultFileDrag,
	VAULT_FILE_DRAG_TYPE,
} from "@/lib/core/vault-file-drag";

function fakeFile(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("dataUrlToPromptImage", () => {
	it("parses a PNG data URL into raw base64 + mime", () => {
		const img = dataUrlToPromptImage("data:image/png;base64,YWJj");
		expect(img).toEqual({ data: "YWJj", mimeType: "image/png" });
	});

	it("rejects non-image mime types", () => {
		expect(dataUrlToPromptImage("data:text/plain;base64,YWJj")).toBeNull();
	});

	it("rejects bare base64 without data: prefix", () => {
		expect(dataUrlToPromptImage("YWJj")).toBeNull();
	});

	it("prefers the data URL mime over a hint", () => {
		const img = dataUrlToPromptImage(
			"data:image/webp;base64,YWJj",
			"image/jpeg",
		);
		expect(img).toEqual({ data: "YWJj", mimeType: "image/webp" });
	});
});

describe("fileUiPartsToPromptImages", () => {
	it("converts image FileUIParts and skips non-images", () => {
		const files: FileUIPart[] = [
			{
				type: "file",
				mediaType: "image/png",
				filename: "a.png",
				url: "data:image/png;base64,YWJj",
			},
			{
				type: "file",
				mediaType: "application/pdf",
				filename: "b.pdf",
				url: "data:application/pdf;base64,eHl6",
			},
			{
				type: "file",
				mediaType: "image/jpeg",
				filename: "c.jpg",
				url: "data:image/jpeg;base64,ZGVm",
			},
		];
		expect(fileUiPartsToPromptImages(files)).toEqual([
			{ data: "YWJj", mimeType: "image/png" },
			{ data: "ZGVm", mimeType: "image/jpeg" },
		]);
	});

	it("returns empty for missing or empty input", () => {
		expect(fileUiPartsToPromptImages(undefined)).toEqual([]);
		expect(fileUiPartsToPromptImages([])).toEqual([]);
	});
});

describe("isImageFile / fileMatchesAccept", () => {
	const accept = "image/*,image/png,image/jpeg,.png,.jpg,.jpeg,.webp,.gif,.bmp";

	it("accepts image MIME types", () => {
		expect(isImageFile(fakeFile("a.png", "image/png"))).toBe(true);
		expect(fileMatchesAccept(fakeFile("a.png", "image/png"), accept)).toBe(
			true,
		);
	});

	it("rejects PDF and other non-images", () => {
		const pdf = fakeFile("paper.pdf", "application/pdf");
		expect(isImageFile(pdf)).toBe(false);
		expect(fileMatchesAccept(pdf, accept)).toBe(false);
	});

	it("accepts known image extensions when MIME is empty", () => {
		const bare = fakeFile("shot.WEBP", "");
		expect(isImageFile(bare)).toBe(true);
		expect(fileMatchesAccept(bare, accept)).toBe(true);
	});

	it("accepts macOS image UTIs when MIME is not image/*", () => {
		expect(isImageMimeOrUti("public.png")).toBe(true);
		expect(isImageMimeOrUti("public.image")).toBe(true);
		expect(isImageMimeOrUti("application/pdf")).toBe(false);
		expect(fileMatchesAccept(fakeFile("shot", "public.png"), accept)).toBe(
			true,
		);
	});

	it("rejects non-image extensions even with empty MIME", () => {
		const bare = fakeFile("notes.pdf", "");
		expect(isImageFile(bare)).toBe(false);
		expect(fileMatchesAccept(bare, accept)).toBe(false);
	});
});

describe("dataTransferLooksLikeImages", () => {
	function fakeDt(opts: {
		items?: Array<{ kind: string; type: string }>;
		files?: Array<{ name: string; type?: string }>;
		uriList?: string;
	}): DataTransfer {
		const files = (opts.files ?? []).map(
			(f) =>
				({
					name: f.name,
					type: f.type ?? "",
				}) as File,
		);
		return {
			types: opts.uriList ? ["Files", "text/uri-list"] : ["Files"],
			items: (opts.items ?? []) as unknown as DataTransferItemList,
			files: files as unknown as FileList,
			getData: (type: string) =>
				type === "text/uri-list" ? (opts.uriList ?? "") : "",
		} as DataTransfer;
	}

	it("returns false without Files type", () => {
		const dt = { types: ["text/plain"], items: [] } as unknown as DataTransfer;
		expect(dataTransferLooksLikeImages(dt)).toBe(false);
	});

	it("returns true when MIME/names are unknown (macOS dragover has no File metadata)", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({ items: [{ kind: "file", type: "" }] }),
			),
		).toBe(true);
	});

	it("returns true for macOS image UTIs", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({ items: [{ kind: "file", type: "public.png" }] }),
			),
		).toBe(true);
	});

	it("returns true for image MIME items", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({ items: [{ kind: "file", type: "image/png" }] }),
			),
		).toBe(true);
	});

	it("returns false when only non-image MIME is present", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({ items: [{ kind: "file", type: "application/pdf" }] }),
			),
		).toBe(false);
	});

	it("returns false for README.md via file name", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({
					items: [{ kind: "file", type: "" }],
					files: [{ name: "README.en.md" }],
				}),
			),
		).toBe(false);
	});

	it("returns false for path in text/uri-list with non-image extension", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({
					uriList: "file:///Users/me/docs/README.en.md",
				}),
			),
		).toBe(false);
	});

	it("returns true for png via file name when MIME empty", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({
					items: [{ kind: "file", type: "" }],
					files: [{ name: "shot.png" }],
				}),
			),
		).toBe(true);
	});

	it("returns true for mixed image + non-image", () => {
		expect(
			dataTransferLooksLikeImages(
				fakeDt({
					items: [
						{ kind: "file", type: "image/png" },
						{ kind: "file", type: "application/pdf" },
					],
				}),
			),
		).toBe(true);
	});

	it("returns true for text/uri-list without a Files type", () => {
		const dt = {
			types: ["text/uri-list"],
			items: [] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
			getData: (type: string) =>
				type === "text/uri-list" ? "file:///Users/me/Desktop/shot.png" : "",
		} as DataTransfer;
		expect(dataTransferLooksLikeImages(dt)).toBe(true);
	});

	it("returns true for an image path in text/plain (Finder drop)", () => {
		const dt = {
			types: ["Files", "text/plain"],
			items: [{ kind: "file", type: "" }] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
			getData: (type: string) =>
				type === "text/plain" ? "/Users/me/Desktop/shot.png" : "",
		} as DataTransfer;
		expect(dataTransferLooksLikeImages(dt)).toBe(true);
	});
});

describe("dataTransferLooksLikePdfs", () => {
	function fakeDt(opts: {
		items?: Array<{ kind: string; type: string }>;
		files?: Array<{ name: string; type?: string }>;
		uriList?: string;
	}): DataTransfer {
		const files = (opts.files ?? []).map(
			(f) =>
				({
					name: f.name,
					type: f.type ?? "",
				}) as File,
		);
		return {
			types: opts.uriList ? ["Files", "text/uri-list"] : ["Files"],
			items: (opts.items ?? []) as unknown as DataTransferItemList,
			files: files as unknown as FileList,
			getData: (type: string) =>
				type === "text/uri-list" ? (opts.uriList ?? "") : "",
		} as DataTransfer;
	}

	it("returns false without Files type", () => {
		const dt = { types: ["text/plain"], items: [] } as unknown as DataTransfer;
		expect(dataTransferLooksLikePdfs(dt)).toBe(false);
	});

	it("returns false when MIME/names are unknown (do not flash over images)", () => {
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({ items: [{ kind: "file", type: "" }] }),
			),
		).toBe(false);
	});

	it("returns true for application/pdf and macOS PDF UTIs", () => {
		expect(isPdfMimeOrUti("application/pdf")).toBe(true);
		expect(isPdfMimeOrUti("com.adobe.pdf")).toBe(true);
		expect(isPdfMimeOrUti("public.pdf")).toBe(true);
		expect(isPdfMimeOrUti("image/png")).toBe(false);
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({ items: [{ kind: "file", type: "application/pdf" }] }),
			),
		).toBe(true);
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({ items: [{ kind: "file", type: "com.adobe.pdf" }] }),
			),
		).toBe(true);
	});

	it("returns true for .pdf via file name when MIME empty", () => {
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({
					items: [{ kind: "file", type: "" }],
					files: [{ name: "paper.PDF" }],
				}),
			),
		).toBe(true);
	});

	it("returns false for images and markdown", () => {
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({ items: [{ kind: "file", type: "image/png" }] }),
			),
		).toBe(false);
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({
					items: [{ kind: "file", type: "" }],
					files: [{ name: "shot.png" }],
				}),
			),
		).toBe(false);
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({
					uriList: "file:///Users/me/docs/README.en.md",
				}),
			),
		).toBe(false);
	});

	it("returns true for mixed PDF + non-PDF", () => {
		expect(
			dataTransferLooksLikePdfs(
				fakeDt({
					items: [
						{ kind: "file", type: "application/pdf" },
						{ kind: "file", type: "image/png" },
					],
				}),
			),
		).toBe(true);
	});
});

describe("in-app vault file drag", () => {
	afterEach(() => {
		endVaultFileDrag();
	});

	it("treats the custom MIME as a vault move, not an image", () => {
		const dt = {
			types: ["Files", VAULT_FILE_DRAG_TYPE, "text/plain"],
			items: [{ kind: "file", type: "" }] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
			getData: (type: string) =>
				type === "text/plain" ? "/vault/notes/a.md" : "",
		} as DataTransfer;
		expect(dataTransferLooksLikeVaultMove(dt)).toBe(true);
		expect(dataTransferLooksLikeImages(dt)).toBe(false);
		expect(dataTransferLooksLikePdfs(dt)).toBe(false);
	});

	it("treats an active tree-drag session as a vault move even without MIME", () => {
		beginVaultFileDrag();
		const dt = {
			types: ["Files"],
			items: [{ kind: "file", type: "" }] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
			getData: () => "",
		} as DataTransfer;
		expect(dataTransferLooksLikeVaultMove(dt)).toBe(true);
		expect(dataTransferLooksLikeImages(dt)).toBe(false);
	});
});

describe("filesFromDataTransfer", () => {
	it("reads File objects from items when FileList is empty", () => {
		const file = fakeFile("shot.png", "image/png");
		const dt = {
			types: ["Files"],
			items: [
				{ kind: "file", type: "image/png", getAsFile: () => file },
			] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
		} as DataTransfer;
		expect(filesFromDataTransfer(dt)).toEqual([file]);
	});
});

describe("imagePathsFromDataTransfer", () => {
	it("keeps absolute image paths and drops non-images", () => {
		const dt = {
			types: ["Files", "text/plain"],
			items: [] as unknown as DataTransferItemList,
			files: [] as unknown as FileList,
			getData: (type: string) =>
				type === "text/plain"
					? "/Users/me/Desktop/shot.png\n/Users/me/Desktop/notes.md"
					: "",
		} as DataTransfer;
		expect(imagePathsFromDataTransfer(dt)).toEqual([
			"/Users/me/Desktop/shot.png",
		]);
	});
});

describe("isPhysicalPointInRect", () => {
	const rect = {
		left: 900,
		right: 1200,
		top: 600,
		bottom: 850,
	} as DOMRect;

	it("accepts CSS-pixel positions as-is", () => {
		expect(isPhysicalPointInRect({ x: 1000, y: 700 }, rect)).toBe(true);
		expect(isPhysicalPointInRect({ x: 10, y: 10 }, rect)).toBe(false);
	});
});
