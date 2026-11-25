import { describe, expect, it } from "vitest";
import {
	collectPaperFoldersFromTree,
	directoryHasPaperMarkers,
	formatAuthorsShort,
	formatPaperTreeLabel,
	isPaperDirectory,
	isPapersRoot,
	isUnderPapers,
	type PaperMetadata,
	paperDeleteDescent,
	paperDirFromPath,
	sortFileTreeNodes,
} from "@/lib/paper";
import type { FileNode } from "@/lib/vault";

describe("paper folder minimal unit", () => {
	it("detects papers root and under-papers", () => {
		expect(isPapersRoot("/vault/papers")).toBe(true);
		expect(isPapersRoot("/vault/papers/")).toBe(true);
		expect(isUnderPapers("/vault/papers/a")).toBe(true);
		expect(isUnderPapers("/vault/papers")).toBe(false);
		expect(isUnderPapers("papers/nlp/x")).toBe(true);
	});

	it("identifies paper folders by markers, not path depth", () => {
		expect(
			directoryHasPaperMarkers([
				{ name: "NOTES.md", kind: "file" },
				{ name: "source", kind: "directory" },
			]),
		).toBe(true);
		expect(
			directoryHasPaperMarkers([{ name: "marks", kind: "directory" }]),
		).toBe(true);
		expect(
			directoryHasPaperMarkers([{ name: "readme.md", kind: "file" }]),
		).toBe(false);
		expect(
			isPaperDirectory("/v/papers/nlp/1706.03762", [
				{ name: "NOTES.md", kind: "file" },
			]),
		).toBe(true);
		expect(
			isPaperDirectory("/v/papers/nlp", [
				{ name: "1706.03762", kind: "directory" },
			]),
		).toBe(false);
		expect(
			directoryHasPaperMarkers([
				{ name: "NOTES.md", kind: "file" },
				{
					name: "1706.03762",
					kind: "directory",
					children: [
						{ name: "NOTES.md", kind: "file" },
						{ name: "metadata.json", kind: "file" },
					],
				},
			]),
		).toBe(false);
		// path-only without children is never enough
		expect(isPaperDirectory("/v/papers/flat-id")).toBe(false);
	});

	it("resolves nested paperDirFromPath from known files", () => {
		expect(
			paperDirFromPath("/vault/papers/nlp/transformers/1706.03762/NOTES.md"),
		).toBe("/vault/papers/nlp/transformers/1706.03762");
		expect(
			paperDirFromPath(
				"/vault/papers/nlp/transformers/1706.03762/source/original.pdf",
			),
		).toBe("/vault/papers/nlp/transformers/1706.03762");
		expect(paperDirFromPath("papers/a/b/marks/hl-1.json")).toBe("papers/a/b");
		expect(paperDirFromPath("papers/a/b/translations/translated.pdf")).toBe(
			"papers/a/b",
		);
		expect(
			paperDirFromPath("/vault/papers/a/b/translations/bilingual.pdf"),
		).toBe("/vault/papers/a/b");
		expect(paperDirFromPath("/vault/notes/idea.md")).toBe(null);
		// Main PDF on the paper root (citation links like …/id.pdf#page=1).
		expect(paperDirFromPath("papers/vla/2504.16054/2504.16054.pdf")).toBe(
			"papers/vla/2504.16054",
		);
		expect(
			paperDirFromPath("/vault/papers/vla/2504.16054/2504.16054.pdf"),
		).toBe("/vault/papers/vla/2504.16054");
	});

	it("uses paperFolders list for longest prefix", () => {
		const folders = ["/v/papers/nlp/1706.03762", "/v/papers/nlp"];
		// Only real paper folders should be passed; longest match wins
		expect(paperDirFromPath("/v/papers/nlp/1706.03762/NOTES.md", folders)).toBe(
			"/v/papers/nlp/1706.03762",
		);
		expect(
			paperDirFromPath("/v/papers/nlp/NOTES.md", ["/v/papers/nlp/1706.03762"]),
		).toBe(null);
	});

	it("collects paper folders from tree at any depth", () => {
		const tree = [
			{
				path: "/v/papers",
				kind: "directory" as const,
				name: "papers",
				children: [
					{
						path: "/v/papers/nlp",
						kind: "directory" as const,
						name: "nlp",
						children: [
							{
								path: "/v/papers/nlp/1706.03762",
								kind: "directory" as const,
								name: "1706.03762",
								children: [
									{
										path: "/v/papers/nlp/1706.03762/NOTES.md",
										kind: "file" as const,
										name: "NOTES.md",
									},
								],
							},
						],
					},
					{
						path: "/v/papers/vaswani2017",
						kind: "directory" as const,
						name: "vaswani2017",
						children: [
							{
								path: "/v/papers/vaswani2017/NOTES.md",
								kind: "file" as const,
								name: "NOTES.md",
							},
						],
					},
				],
			},
		];
		const folders = collectPaperFoldersFromTree(tree);
		expect(folders.sort()).toEqual(
			["/v/papers/nlp/1706.03762", "/v/papers/vaswani2017"].sort(),
		);
	});

	it("keeps an organization index note from masking nested papers", () => {
		const paper = (name: string) => ({
			path: `/v/papers/rubric/${name}`,
			kind: "directory" as const,
			name,
			children: [
				{
					path: `/v/papers/rubric/${name}/NOTES.md`,
					kind: "file" as const,
					name: "NOTES.md",
				},
				{
					path: `/v/papers/rubric/${name}/metadata.json`,
					kind: "file" as const,
					name: "metadata.json",
				},
			],
		});
		const tree = [
			{
				path: "/v/papers",
				kind: "directory" as const,
				name: "papers",
				children: [
					{
						path: "/v/papers/rubric",
						kind: "directory" as const,
						name: "rubric",
						children: [
							{
								path: "/v/papers/rubric/NOTES.md",
								kind: "file" as const,
								name: "NOTES.md",
							},
							paper("2601.04171"),
							paper("2601.15808"),
						],
					},
				],
			},
		];

		expect(collectPaperFoldersFromTree(tree)).toEqual([
			"/v/papers/rubric/2601.04171",
			"/v/papers/rubric/2601.15808",
		]);
	});

	it("splits a delete into paper folders and directories still to walk", () => {
		const paper = "/v/papers/demo";
		expect(
			paperDeleteDescent(paper, [
				{ path: `${paper}/NOTES.md`, name: "NOTES.md", kind: "file" },
				{ path: `${paper}/source`, name: "source", kind: "directory" },
				{ path: `${paper}/paper.pdf`, name: "paper.pdf", kind: "file" },
				{
					path: `${paper}/translations`,
					name: "translations",
					kind: "directory",
				},
			]),
		).toEqual({ papers: [paper], descend: [] });

		const org = "/v/papers/rubric";
		const nested = `${org}/2601.04171`;
		expect(
			paperDeleteDescent(org, [
				{ path: `${org}/NOTES.md`, name: "NOTES.md", kind: "file" },
				{
					path: nested,
					name: "2601.04171",
					kind: "directory",
					children: [
						{ name: "NOTES.md", kind: "file" },
						{ name: "metadata.json", kind: "file" },
					],
				},
				{
					path: `${org}/translations`,
					name: "translations",
					kind: "directory",
				},
			]),
		).toEqual({ papers: [], descend: [nested] });

		expect(
			paperDeleteDescent("/vault", [
				{ path: "/vault/notes", name: "notes", kind: "directory" },
				{ path: "/vault/papers", name: "papers", kind: "directory" },
				{ path: "/vault/readme.md", name: "readme.md", kind: "file" },
			]),
		).toEqual({ papers: [], descend: ["/vault/papers"] });
	});
});

describe("formatPaperTreeLabel", () => {
	const meta = {
		title: "Attention Is All You Need",
		authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
		year: 2017,
	};

	it("formats authors compactly", () => {
		expect(formatAuthorsShort(["A"])).toBe("A");
		expect(formatAuthorsShort(["A", "B"])).toBe("A, B");
		expect(formatAuthorsShort(["A", "B", "C"])).toBe("A et al.");
		expect(formatAuthorsShort([])).toBe("");
	});

	it("title-author uses title and short authors", () => {
		expect(formatPaperTreeLabel("title-author", meta, "1706.03762")).toBe(
			"Attention Is All You Need · Ashish Vaswani et al.",
		);
	});

	it("title only", () => {
		expect(formatPaperTreeLabel("title", meta, "1706.03762")).toBe(
			"Attention Is All You Need",
		);
	});

	it("author-year-title", () => {
		expect(formatPaperTreeLabel("author-year-title", meta, "1706.03762")).toBe(
			"Ashish Vaswani et al. (2017) · Attention Is All You Need",
		);
	});

	it("folder mode and missing meta fall back to folder name", () => {
		expect(formatPaperTreeLabel("folder", meta, "1706.03762")).toBe(
			"1706.03762",
		);
		expect(formatPaperTreeLabel("title-author", null, "25.23211")).toBe(
			"25.23211",
		);
		expect(
			formatPaperTreeLabel(
				"title",
				{ title: "", authors: [], year: undefined },
				"25.23211",
			),
		).toBe("25.23211");
	});
});

describe("sortFileTreeNodes", () => {
	const paper = (name: string): FileNode => ({
		id: `/v/papers/${name}`,
		name,
		path: `/v/papers/${name}`,
		kind: "directory",
		children: [
			{
				id: `/v/papers/${name}/NOTES.md`,
				name: "NOTES.md",
				path: `/v/papers/${name}/NOTES.md`,
				kind: "file",
			},
		],
	});

	const org = (name: string, children: FileNode[]): FileNode => ({
		id: `/v/papers/${name}`,
		name,
		path: `/v/papers/${name}`,
		kind: "directory",
		children,
	});

	const meta = (
		partial: Partial<PaperMetadata> & Pick<PaperMetadata, "title">,
	): PaperMetadata =>
		({
			id: partial.id ?? "x",
			type: "arxiv",
			title: partial.title,
			authors: partial.authors ?? [],
			tags: [],
			status: "completed",
			added_at: partial.added_at ?? "2020-01-01T00:00:00Z",
			updated_at: partial.updated_at ?? "2020-01-01T00:00:00Z",
			year: partial.year,
			path: partial.path,
		}) as PaperMetadata;

	const siblings: FileNode[] = [
		paper("zeta-paper"),
		paper("alpha-paper"),
		paper("mid-paper"),
		org("beta-org", [paper("nested")]),
	];

	const byRel = new Map<string, PaperMetadata>([
		[
			"papers/zeta-paper",
			meta({
				title: "Zebra Methods",
				authors: ["Zulu"],
				year: 2018,
				added_at: "2024-01-01T00:00:00Z",
			}),
		],
		[
			"papers/alpha-paper",
			meta({
				title: "Attention",
				authors: ["Vaswani"],
				year: 2017,
				added_at: "2023-06-01T00:00:00Z",
			}),
		],
		[
			"papers/mid-paper",
			meta({
				title: "BERT",
				authors: ["Devlin"],
				year: 2019,
				added_at: "2025-01-01T00:00:00Z",
			}),
		],
	]);

	const toRel = (abs: string) => abs.replace(/^\/v\//, "");

	it("folder mode sorts by display label (labelMode) not disk folder name", () => {
		// title-author labels: Attention, BERT, beta-org, Zebra (not disk alpha/mid/zeta)
		// org folders are always surfaced before papers.
		const names = sortFileTreeNodes(
			siblings,
			"folder",
			byRel,
			toRel,
			"title-author",
		).map((n) => n.name);
		expect(names).toEqual([
			"beta-org",
			"alpha-paper", // Attention · Vaswani
			"mid-paper", // BERT · Devlin
			"zeta-paper", // Zebra Methods · Zulu
		]);
	});

	it("folder mode with labelMode folder keeps disk name order", () => {
		const names = sortFileTreeNodes(
			siblings,
			"folder",
			byRel,
			toRel,
			"folder",
		).map((n) => n.name);
		expect(names).toEqual([
			"beta-org",
			"alpha-paper",
			"mid-paper",
			"zeta-paper",
		]);
	});

	it("folder mode sorts numeric prefixes naturally", () => {
		const names = sortFileTreeNodes(
			[
				paper("10-topic"),
				paper("9-topic"),
				org("10-org", [paper("nested-a")]),
				org("9-org", [paper("nested-b")]),
			],
			"folder",
			null,
			undefined,
			"folder",
		).map((n) => n.name);

		expect(names).toEqual(["9-org", "10-org", "9-topic", "10-topic"]);
	});

	it("title mode: org folders first, then papers by title", () => {
		const names = sortFileTreeNodes(siblings, "title", byRel, toRel).map(
			(n) => n.name,
		);
		expect(names).toEqual([
			"beta-org",
			"alpha-paper", // Attention
			"mid-paper", // BERT
			"zeta-paper", // Zebra Methods
		]);
	});

	it("year-desc: newest year first; org first", () => {
		const names = sortFileTreeNodes(siblings, "year-desc", byRel, toRel).map(
			(n) => n.name,
		);
		expect(names).toEqual([
			"beta-org",
			"mid-paper", // 2019
			"zeta-paper", // 2018
			"alpha-paper", // 2017
		]);
	});

	it("year-asc: oldest first", () => {
		const names = sortFileTreeNodes(siblings, "year-asc", byRel, toRel).map(
			(n) => n.name,
		);
		expect(names).toEqual([
			"beta-org",
			"alpha-paper",
			"zeta-paper",
			"mid-paper",
		]);
	});

	it("author mode by first author", () => {
		const names = sortFileTreeNodes(siblings, "author", byRel, toRel).map(
			(n) => n.name,
		);
		expect(names).toEqual([
			"beta-org",
			"mid-paper", // Devlin
			"alpha-paper", // Vaswani
			"zeta-paper", // Zulu
		]);
	});

	it("added-desc by catalog added_at", () => {
		const names = sortFileTreeNodes(siblings, "added-desc", byRel, toRel).map(
			(n) => n.name,
		);
		expect(names).toEqual([
			"beta-org",
			"mid-paper", // 2025
			"zeta-paper", // 2024
			"alpha-paper", // 2023
		]);
	});

	it("directories before files; does not mutate input", () => {
		const input: FileNode[] = [
			{
				id: "/v/a.md",
				name: "a.md",
				path: "/v/a.md",
				kind: "file",
			},
			{
				id: "/v/z-dir",
				name: "z-dir",
				path: "/v/z-dir",
				kind: "directory",
				children: [],
			},
		];
		const before = input.map((n) => n.name);
		const names = sortFileTreeNodes(input, "folder").map((n) => n.name);
		expect(names).toEqual(["z-dir", "a.md"]);
		expect(input.map((n) => n.name)).toEqual(before);
	});
});
