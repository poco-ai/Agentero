import { describe, expect, it } from "vitest";
import type { DocTab } from "@/lib/workspace/tabs";
import { isWritingSource } from "@/lib/workspace/writing-focus";

const source = {
	id: "source",
	path: "/vault/thesis/main.tex",
	mode: "text",
	writingRoot: "/vault/thesis/main.tex",
} as DocTab;

describe("isWritingSource", () => {
	it("matches a project source with a writing root", () => {
		expect(isWritingSource(source, "/vault")).toBe(true);
	});

	it("ignores a compiled PDF", () => {
		expect(
			isWritingSource(
				{
					...source,
					path: "/vault/thesis/main.pdf",
					mode: "pdf",
					writingRoot: undefined,
				},
				"/vault",
			),
		).toBe(false);
	});
});
