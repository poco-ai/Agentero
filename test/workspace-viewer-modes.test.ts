import { describe, expect, it } from "vitest";
import { isUnderPapers } from "@/lib/paper/paths";
import {
	type CenterViewMode,
	isCenterViewMode,
	isViewerPath,
	preferredModeForPath,
	VIEWER_MODE_TABLE,
	viewerModeSpec,
} from "@/lib/workspace/viewer";

/**
 * Registry completeness + anti-drift pins. Every behavior that used to be a
 * hand-maintained mode list (path inference, persist whitelist, renderer,
 * keep-alive pool, props domain, resource strategy, restore override) must
 * follow VIEWER_MODE_TABLE; these tests fail when a new mode skips a field
 * or an existing pin silently changes.
 */
describe("viewer mode registry", () => {
	it("covers every mode exactly once with a complete spec", () => {
		const modes = VIEWER_MODE_TABLE.map((entry) => entry.mode);
		expect(new Set(modes).size).toBe(modes.length);
		for (const entry of VIEWER_MODE_TABLE) {
			expect(isCenterViewMode(entry.mode)).toBe(true);
			expect(viewerModeSpec(entry.mode)).toBe(entry);
			expect(["always", "onlyWhenVisible"]).toContain(entry.renderer);
			expect(["pdf", "editor", null]).toContain(entry.keepAlive);
			expect(["editor", "excalidraw", "text", "pdf", "none"]).toContain(
				entry.props,
			);
			expect([
				"pdf",
				"markdown",
				"html",
				"image",
				"excalidraw",
				"text",
			]).toContain(entry.resource);
		}
		// Persist whitelist is exactly the registry mode set.
		for (const mode of [
			"markdown",
			"pdf",
			"html",
			"image",
			"translation",
			"excalidraw",
			"text",
		] as const) {
			expect(isCenterViewMode(mode)).toBe(true);
			expect(modes).toContain(mode);
		}
		expect(isCenterViewMode("genie")).toBe(false);
		expect(isCenterViewMode(7)).toBe(false);
		expect(isCenterViewMode(null)).toBe(false);
	});

	it("only translation and text are unreachable by path (no matcher)", () => {
		const withoutMatcher = VIEWER_MODE_TABLE.filter(
			(entry) => entry.matchesPath === null,
		).map((entry) => entry.mode);
		expect(withoutMatcher).toEqual(["translation", "text"]);
	});

	it("pins renderer and keep-alive pool per mode", () => {
		expect(viewerModeSpec("pdf")).toMatchObject({
			renderer: "always",
			keepAlive: "pdf",
		});
		expect(viewerModeSpec("translation")).toMatchObject({
			renderer: "always",
			keepAlive: null,
		});
		expect(viewerModeSpec("markdown")).toMatchObject({
			renderer: "always",
			keepAlive: "editor",
		});
		expect(viewerModeSpec("text")).toMatchObject({
			renderer: "always",
			keepAlive: "editor",
		});
		expect(viewerModeSpec("excalidraw")).toMatchObject({
			renderer: "always",
			keepAlive: null,
		});
		expect(viewerModeSpec("html")).toMatchObject({
			renderer: "onlyWhenVisible",
			keepAlive: null,
		});
		expect(viewerModeSpec("image")).toMatchObject({
			renderer: "onlyWhenVisible",
			keepAlive: null,
		});
	});

	it("pins the resource strategy, including the pdf/translation pair", () => {
		expect(viewerModeSpec("pdf").resource).toBe("pdf");
		expect(viewerModeSpec("translation").resource).toBe("pdf");
		expect(viewerModeSpec("markdown").resource).toBe("markdown");
		expect(viewerModeSpec("text").resource).toBe("text");
		expect(viewerModeSpec("html").resource).toBe("html");
		expect(viewerModeSpec("image").resource).toBe("image");
		expect(viewerModeSpec("excalidraw").resource).toBe("excalidraw");
	});

	it("pins DocView props domain per mode", () => {
		expect(viewerModeSpec("pdf").props).toBe("pdf");
		expect(viewerModeSpec("translation").props).toBe("pdf");
		expect(viewerModeSpec("markdown").props).toBe("editor");
		expect(viewerModeSpec("text").props).toBe("text");
		expect(viewerModeSpec("excalidraw").props).toBe("excalidraw");
		expect(viewerModeSpec("html").props).toBe("none");
		expect(viewerModeSpec("image").props).toBe("none");
	});

	it("restores translation panes as loaded paper tabs; other modes as placeholders", () => {
		expect(viewerModeSpec("translation").restore).toEqual({
			kind: "paper",
			fallbackTitle: "Translation",
			loaded: true,
		});
		for (const entry of VIEWER_MODE_TABLE) {
			if (entry.mode !== "translation") {
				expect(viewerModeSpec(entry.mode).restore).toBeUndefined();
			}
		}
	});

	it("preferredModeForPath follows the table matchers, then the documented fallbacks", () => {
		const cases: Array<[string, CenterViewMode]> = [
			["/v/data/results.table.json", "research-table"],
			["/v/paper.pdf", "pdf"],
			["/v/page.html", "html"],
			["/v/page.htm", "html"],
			["/v/figure.PNG", "image"],
			["/v/graph.svg", "image"],
			["/v/board.excalidraw", "excalidraw"],
			["/v/note.md", "markdown"],
			["/v/note.mdx", "markdown"],
			// papers/ domain keeps Markdown even for the text catch-all extension.
			["/v/papers/x/data.txt", "markdown"],
			["/v/papers/x/script.py", "markdown"],
			// Outside papers/ the CodeMirror text editor is the catch-all.
			["/v/notes/data.txt", "text"],
			["/v/notes/script.py", "text"],
		];
		for (const [path, expected] of cases) {
			// Result must equal the first registry matcher hit, else the
			// documented fallback (papers/ → markdown, otherwise → text).
			const firstMatch = VIEWER_MODE_TABLE.find(
				(entry) => entry.matchesPath?.(path) === true,
			);
			const fallback: CenterViewMode = isUnderPapers(path)
				? "markdown"
				: "text";
			expect(preferredModeForPath(path)).toBe(firstMatch?.mode ?? fallback);
			expect(preferredModeForPath(path)).toBe(expected);
		}
		expect(preferredModeForPath(null)).toBe("markdown");
	});

	it("isViewerPath only claims dedicated viewer extensions (never the papers fallback)", () => {
		expect(isViewerPath("/v/paper.pdf")).toBe(true);
		expect(isViewerPath("/v/note.md")).toBe(true);
		expect(isViewerPath("/v/board.excalidraw")).toBe(true);
		expect(isViewerPath("/v/notes/data.txt")).toBe(false);
		// Extension-less paths under papers/ are file-tree directories, not files.
		expect(isViewerPath("/v/papers/x/org-folder")).toBe(false);
	});
});
