import { describe, expect, it } from "vitest";
import { buildEasyScholarTags, mergeEasyScholarTags } from "@/lib/easyscholar";
import { withPaperTagColor } from "@/lib/paper/tags";

describe("paper tag colors", () => {
	it("edits an existing tag without losing hidden provenance, names, or other colors", () => {
		const tags = [
			{ name: "@zotero:source" },
			{ name: "@arxiv:cs.AI" },
			{ name: "Topic", color: "blue" },
			{ name: "Other", color: "green" },
		];
		const changed = withPaperTagColor(tags, "topic", "red");
		expect(changed).toEqual([
			tags[0],
			tags[1],
			{ name: "Topic", color: "red" },
			tags[3],
		]);
		expect(withPaperTagColor(changed, "Topic", null)[2]).toEqual({
			name: "Topic",
		});
		expect(tags[2].color).toBe("blue");
	});
	it("refreshes ranks preserving same-name colors including no color and all non-provider tags", () => {
		const generated = buildEasyScholarTags("Journal", {
			sciif: "9.5",
			sci: "Q1",
			ccf: "A",
		});
		const result = mergeEasyScholarTags(
			[
				{ name: "@zotero:source" },
				{ name: "User", color: "purple" },
				{ name: "#easyscholar:if=9.5", color: "orange" },
				{ name: "#easyscholar:rank=SCI=Q1" },
				{ name: "#easyscholar:rank=CCF=B", color: "red" },
			],
			generated,
		);
		expect(result).toContainEqual({ name: "@zotero:source" });
		expect(result).toContainEqual({ name: "User", color: "purple" });
		expect(result).toContainEqual({
			name: "#easyscholar:if=9.5",
			color: "orange",
		});
		expect(
			result.find((tag) => tag.name === "#easyscholar:rank=SCI=Q1")?.color,
		).toBeUndefined();
		expect(result).toContainEqual({
			name: "#easyscholar:rank=CCF=A",
			color: "blue",
		});
		expect(result.some((tag) => tag.name === "#easyscholar:rank=CCF=B")).toBe(
			false,
		);
		expect(
			mergeEasyScholarTags(
				result,
				buildEasyScholarTags("Journal", { sciif: "10" }),
			),
		).toContainEqual({ name: "#easyscholar:if=10", color: "green" });
	});
});
