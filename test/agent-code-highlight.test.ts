import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightCode, loadHighlighter } from "@/lib/ui/highlighter";

describe("agent code highlighting", () => {
	it("continues a multiline grammar across streamed chunks", async () => {
		const highlighter = await loadHighlighter("js");
		expect(highlighter).not.toBeNull();
		if (!highlighter) return;
		const first = highlighter.highlight("/* opening comment");
		const continuation = highlighter.highlight(
			"closing */\nconst value = 1",
			first.state,
		);
		const complete = highlighter.highlight(
			"/* opening comment\nclosing */\nconst value = 1",
		);
		expect(renderToStaticMarkup(continuation.lines)).toBe(
			renderToStaticMarkup(complete.lines.slice(1)),
		);
	});

	it("loads research languages and falls back for unknown languages", async () => {
		expect(await highlightCode("\\alpha", "latex")).not.toBeNull();
		expect(await highlightCode("fn main() {}", "rust")).not.toBeNull();
		expect(await highlightCode("raw code", "unknown-language")).toBeNull();
	});
});
