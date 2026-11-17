import { describe, expect, it } from "vitest";
import {
	imageMimeFromPath,
	isExcalidrawPath,
	isHtmlPath,
	isImagePath,
	isImageViewerSource,
	isPdfPath,
	isPlainPdfPath,
	paperBodyMode,
	preferredModeForPath,
	textLanguageIdForPath,
} from "@/lib/workspace/viewer";

describe("viewer path helpers", () => {
	it("detects pdf / html / image extensions", () => {
		expect(isPdfPath("/vault/a.PDF")).toBe(true);
		expect(isHtmlPath("/vault/page.htm")).toBe(true);
		expect(isImagePath("/vault/fig.png")).toBe(true);
		expect(isImagePath("/vault/fig.JPEG")).toBe(true);
		expect(isImagePath("/vault/logo.svg")).toBe(true);
		expect(isImagePath("/vault/notes.md")).toBe(false);
	});

	it("maps image mime from extension", () => {
		expect(imageMimeFromPath("x.png")).toBe("image/png");
		expect(imageMimeFromPath("x.jpg")).toBe("image/jpeg");
		expect(imageMimeFromPath("x.svg")).toBe("image/svg+xml");
		expect(imageMimeFromPath("x.webp")).toBe("image/webp");
	});

	it("preferredModeForPath prefers media over markdown", () => {
		expect(preferredModeForPath("/a/b.pdf")).toBe("pdf");
		expect(preferredModeForPath("/a/b.html")).toBe("html");
		expect(preferredModeForPath("/a/b.png")).toBe("image");
		expect(preferredModeForPath("/a/b.excalidraw")).toBe("excalidraw");
		expect(preferredModeForPath("/a/b.md")).toBe("markdown");
		expect(preferredModeForPath(null)).toBe("markdown");
	});

	it("falls back to the text editor only outside papers/", () => {
		expect(preferredModeForPath("/vault/notes/config.toml")).toBe("text");
		expect(preferredModeForPath("/vault/README")).toBe("text");
		expect(preferredModeForPath("/vault/notes/data.json")).toBe("text");
		// Inside papers/ the legacy behavior stands: markdown, never text.
		expect(preferredModeForPath("/vault/papers/2401.0001/notes/org.md")).toBe(
			"markdown",
		);
		expect(preferredModeForPath("/vault/papers/2401.0001/data/misc.dat")).toBe(
			"markdown",
		);
		// Dedicated viewers still win under papers/.
		expect(preferredModeForPath("/vault/papers/2401.0001/main.pdf")).toBe(
			"pdf",
		);
	});

	it("maps text editor languages from extensions", () => {
		expect(textLanguageIdForPath("/a/config.json")).toBe("json");
		expect(textLanguageIdForPath("/a/ci.YML")).toBe("yaml");
		expect(textLanguageIdForPath("/a/main.py")).toBe("python");
		expect(textLanguageIdForPath("/a/main.tex")).toBe("tex");
		expect(textLanguageIdForPath("/a/ref.bib")).toBe("bib");
		expect(textLanguageIdForPath("/a/notes.txt")).toBe(null);
		expect(textLanguageIdForPath("/a/README")).toBe(null);
	});

	it("detects excalidraw extensions", () => {
		expect(isExcalidrawPath("/vault/drawing.excalidraw")).toBe(true);
		expect(isExcalidrawPath("/vault/drawing.EXCALIDRAW")).toBe(true);
		expect(isExcalidrawPath("/vault/drawing.json")).toBe(false);
	});

	it("accepts blob and data URLs as image sources", () => {
		expect(isImageViewerSource("blob:http://localhost/1")).toBe(true);
		expect(isImageViewerSource("https://example.com/a.png")).toBe(true);
		expect(isImageViewerSource("data:image/png;base64,aa")).toBe(true);
		expect(isImageViewerSource("asset://localhost/a.png")).toBe(false);
		expect(isImageViewerSource(null)).toBe(false);
	});
});

describe("paperBodyMode", () => {
	it("renders local or remote pdf assets as pdf", () => {
		expect(paperBodyMode(true, null)).toBe("pdf");
		expect(paperBodyMode(true, "https://arxiv.org/html/2608.13524")).toBe(
			"pdf",
		);
	});

	it("falls back to remote html when no pdf resolved", () => {
		expect(paperBodyMode(false, "https://arxiv.org/html/2608.13524")).toBe(
			"html",
		);
	});

	it("never falls back to a markdown editor — pdf empty state instead", () => {
		expect(paperBodyMode(false, null)).toBe("pdf");
	});
});

describe("isPlainPdfPath", () => {
	it("marks loose vault PDFs as plain", () => {
		expect(isPlainPdfPath("plans/a.pdf")).toBe(true);
		expect(isPlainPdfPath("a.pdf")).toBe(true);
		expect(isPlainPdfPath("/Users/x/vault/plans/a.pdf")).toBe(true);
	});

	it("keeps the full viewer for anything under papers/", () => {
		expect(isPlainPdfPath("papers/2601.00001/paper.pdf")).toBe(false);
		expect(isPlainPdfPath("papers/2601.00001/attachments/fig.pdf")).toBe(false);
		expect(isPlainPdfPath("/Users/x/vault/papers/2601.00001/paper.pdf")).toBe(
			false,
		);
	});

	it("keeps remote arXiv papers on their own behavior", () => {
		expect(isPlainPdfPath("agentero:arxiv:2601.00001")).toBe(false);
	});

	it("null paths are never plain", () => {
		expect(isPlainPdfPath(null)).toBe(false);
	});
});
