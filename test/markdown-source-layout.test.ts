import { describe, expect, it } from "vitest";
import {
	markdownSourceLineNumberStyle,
	markdownSourceSurfaceStyle,
} from "@/components/editor/markdown-source-layout";

describe("Markdown source layout", () => {
	it("caps the source surface, gutter included, at markdownMaxWidth", () => {
		expect(markdownSourceSurfaceStyle(960)).toEqual({ maxWidth: 960 });
		expect(markdownSourceSurfaceStyle(0)).toEqual({});
	});

	it("renders line numbers in a smaller monospace face", () => {
		expect(markdownSourceLineNumberStyle.fontFamily).toBe("var(--font-mono)");
		expect(markdownSourceLineNumberStyle.fontSize).toBe("0.8em");
	});
});
