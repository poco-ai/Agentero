import { describe, expect, it } from "vitest";
import {
	convertPropertyKind,
	countFrontmatterProperties,
	createEmptyProperty,
	frontmatterInterior,
	inferScalarKind,
	joinFrontmatter,
	parseFrontmatterProperties,
	serializeFrontmatterProperties,
	splitFrontmatter,
	wrapFrontmatter,
} from "@/lib/markdown/frontmatter";

describe("frontmatter helpers", () => {
	it("extracts the YAML interior without fences", () => {
		expect(
			frontmatterInterior("---\naliases:\n  - Full Title\n  - Short\n---\n"),
		).toBe("aliases:\n  - Full Title\n  - Short");
		expect(frontmatterInterior("")).toBe("");
		expect(frontmatterInterior("---\n---\n")).toBe("");
	});

	it("wraps interior into a disk-ready block or clears empty input", () => {
		expect(wrapFrontmatter("aliases:\n  - A\n  - B")).toBe(
			"---\naliases:\n  - A\n  - B\n---\n",
		);
		expect(wrapFrontmatter("  \n  ")).toBe("");
		expect(wrapFrontmatter("")).toBe("");
	});

	it("round-trips through split/join with the panel interior", () => {
		const original =
			"---\naliases:\n  - Attention Is All You Need\n  - AIAYN\ntags:\n  - transformers\n---\n# Body\n";
		const { frontmatter, body } = splitFrontmatter(original);
		const interior = frontmatterInterior(frontmatter);
		expect(countFrontmatterProperties(interior)).toBe(2);
		const next = joinFrontmatter(wrapFrontmatter(interior), body);
		expect(next).toBe(original);
	});

	it("counts only top-level property keys", () => {
		expect(
			countFrontmatterProperties(
				"aliases:\n  - one\n  - two\ntitle: Note\n# comment\n",
			),
		).toBe(2);
		expect(countFrontmatterProperties("")).toBe(0);
	});

	it("parses scalars, lists, checkboxes, and dates", () => {
		const parsed = parseFrontmatterProperties(
			[
				"title: Hello World",
				"aliases:",
				"  - Attention Is All You Need",
				"  - AIAYN",
				"tags: [a, b]",
				"done: true",
				"published: 2024-08-01",
				"status: reading",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.properties).toEqual([
			{ key: "title", kind: "scalar", value: "Hello World", items: [] },
			{
				key: "aliases",
				kind: "list",
				value: "",
				items: ["Attention Is All You Need", "AIAYN"],
			},
			{ key: "tags", kind: "list", value: "", items: ["a", "b"] },
			{ key: "done", kind: "checkbox", value: "true", items: [] },
			{ key: "published", kind: "date", value: "2024-08-01", items: [] },
			{ key: "status", kind: "scalar", value: "reading", items: [] },
		]);
	});

	it("serializes checkbox and date without quoting", () => {
		expect(
			serializeFrontmatterProperties([
				{ key: "done", kind: "checkbox", value: "true", items: [] },
				{ key: "published", kind: "date", value: "2024-08-01", items: [] },
				{
					key: "aliases",
					kind: "list",
					value: "",
					items: ["AIAYN"],
				},
			]),
		).toBe(
			["done: true", "published: 2024-08-01", "aliases:", "  - AIAYN"].join(
				"\n",
			),
		);
	});

	it("round-trips typed properties through serialize/parse", () => {
		const interior = [
			"done: false",
			"published: 2026-01-15",
			"aliases:",
			"  - Short",
			"title: Note",
		].join("\n");
		const parsed = parseFrontmatterProperties(interior);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const again = parseFrontmatterProperties(
			serializeFrontmatterProperties(parsed.properties),
		);
		expect(again).toEqual(parsed);
	});

	it("rejects nested maps and multi-line scalars for form mode", () => {
		expect(parseFrontmatterProperties("meta:\n  nested: 1").ok).toBe(false);
		expect(parseFrontmatterProperties("body: |\n  line").ok).toBe(false);
	});

	it("creates list-shaped aliases rows by default", () => {
		expect(createEmptyProperty("aliases")).toEqual({
			key: "aliases",
			kind: "list",
			value: "",
			items: [],
		});
		expect(createEmptyProperty("", "checkbox")).toEqual({
			key: "",
			kind: "checkbox",
			value: "false",
			items: [],
		});
	});

	it("infers scalar kinds and converts between kinds", () => {
		expect(inferScalarKind("true")).toBe("checkbox");
		expect(inferScalarKind("2024-01-02")).toBe("date");
		expect(inferScalarKind("hello")).toBe("scalar");

		const fromText = convertPropertyKind(
			{ key: "x", kind: "scalar", value: "true", items: [] },
			"checkbox",
		);
		expect(fromText).toEqual({
			key: "x",
			kind: "checkbox",
			value: "true",
			items: [],
		});

		const toList = convertPropertyKind(
			{ key: "x", kind: "checkbox", value: "false", items: [] },
			"list",
		);
		expect(toList.kind).toBe("list");
		expect(toList.items).toEqual(["false"]);
	});
});
