import { describe, expect, it } from "vitest";
import { fileTreeDisplayName } from "@/components/sidebar/file-tree/tree-helpers";

describe("fileTreeDisplayName", () => {
	it("hides markdown and research-table suffixes", () => {
		expect(fileTreeDisplayName("注意力消融.md")).toBe("注意力消融");
		expect(fileTreeDisplayName("注意力消融.table.json")).toBe("注意力消融");
		expect(fileTreeDisplayName("README.MDX")).toBe("README");
	});

	it("keeps other filenames intact", () => {
		expect(fileTreeDisplayName("notes")).toBe("notes");
		expect(fileTreeDisplayName("catalog.json")).toBe("catalog.json");
		expect(fileTreeDisplayName("paper.pdf")).toBe("paper.pdf");
	});
});
