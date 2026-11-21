import { describe, expect, it } from "vitest";
import { displayPath, joinPath, normalizeLocalPath } from "@/lib/core/path";
import { notesPathForPaper } from "@/lib/paper/paths";
import { joinVaultPath, planVaultRename } from "@/lib/vault";

describe("displayPath", () => {
	it.each([
		[
			String.raw`\\?\D:\Documents\Zotero\papers\2-Areas`,
			String.raw`D:\Documents\Zotero\papers\2-Areas`,
		],
		[
			String.raw`\\?\d:\中文 Vault & 资料\笔记.md`,
			String.raw`d:\中文 Vault & 资料\笔记.md`,
		],
		["\\\\?\\D:\\", "D:\\"],
		[String.raw`\\?\UNC\server\share\notes`, String.raw`\\server\share\notes`],
		[String.raw`\\?\unc\server\share`, String.raw`\\server\share`],
		[String.raw`D:\Documents\Zotero`, String.raw`D:\Documents\Zotero`],
		[String.raw`\\server\share`, String.raw`\\server\share`],
		[String.raw`\\?\Volume{abc}\notes`, String.raw`\\?\Volume{abc}\notes`],
		[String.raw`\\.\C:\notes`, String.raw`\\.\C:\notes`],
		["/home/me/vault", "/home/me/vault"],
		["remote:session/notes", "remote:session/notes"],
		["", ""],
	])("formats %s for display and copying", (path, expected) => {
		expect(displayPath(path)).toBe(expected);
	});
});

describe("joinPath", () => {
	it("joins POSIX roots with forward slashes", () => {
		expect(joinPath("/Users/me/vault", "notes/a.md")).toBe(
			"/Users/me/vault/notes/a.md",
		);
		expect(joinPath("/Users/me/vault/", "notes/a.md")).toBe(
			"/Users/me/vault/notes/a.md",
		);
	});

	it("keeps Windows roots on backslashes for multi-segment rel paths", () => {
		// Regression for #181: mixed C:\\vault/notes/x.md breaks under \\\\?\\ opens.
		expect(
			joinPath(
				"C:\\Users\\hiclary\\Desktop\\wenxian",
				"notes/zh-CN/02 Agent 与 Skill.md",
			),
		).toBe(
			"C:\\Users\\hiclary\\Desktop\\wenxian\\notes\\zh-CN\\02 Agent 与 Skill.md",
		);
		expect(
			joinPath("C:\\Users\\hiclary\\Desktop\\wenxian\\", "notes/a.md"),
		).toBe("C:\\Users\\hiclary\\Desktop\\wenxian\\notes\\a.md");
	});

	it("rewrites child backslashes when the parent is POSIX", () => {
		expect(joinPath("/vault", "notes\\a.md")).toBe("/vault/notes/a.md");
	});

	it("returns the parent when the child is empty", () => {
		expect(joinPath("C:\\vault", "")).toBe("C:\\vault");
		expect(joinPath("C:\\vault\\", "/")).toBe("C:\\vault");
	});
});

describe("planVaultRename", () => {
	it("turns a file renamed without an extension into a folder (#759)", () => {
		expect(
			planVaultRename({
				parentRel: "notes",
				currentName: "foo.md",
				nextName: "bar",
				kind: "file",
			}),
		).toEqual({
			toRel: "notes/bar/bar.md",
			folderize: true,
			folderRel: "notes/bar",
		});
	});

	it("keeps every original suffix inside the new folder", () => {
		expect(
			planVaultRename({
				parentRel: "",
				currentName: "archive.tar.gz",
				nextName: "backup",
				kind: "file",
			}).toRel,
		).toBe("backup/backup.tar.gz");
	});

	it("keeps a normal rename when the new name has an extension", () => {
		expect(
			planVaultRename({
				parentRel: "notes",
				currentName: "foo.md",
				nextName: "bar.md",
				kind: "file",
			}),
		).toEqual({ toRel: "notes/bar.md", folderize: false });
	});

	it("never folderizes directories", () => {
		expect(
			planVaultRename({
				parentRel: "notes",
				currentName: "foo",
				nextName: "bar",
				kind: "directory",
			}),
		).toEqual({ toRel: "notes/bar", folderize: false });
	});
});

describe("joinVaultPath", () => {
	it("preserves extended Windows paths for filesystem IO", () => {
		const path = joinVaultPath(
			String.raw`\\?\D:\Documents\Zotero`,
			"notes/资料.md",
		);
		expect(path).toBe(String.raw`\\?\D:\Documents\Zotero\notes\资料.md`);
		expect(displayPath(path)).toBe(
			String.raw`D:\Documents\Zotero\notes\资料.md`,
		);
	});

	it("matches joinPath for wiki open targets", () => {
		expect(
			joinVaultPath("C:\\Users\\me\\vault", "notes/zh-CN/02 Agent 与 Skill.md"),
		).toBe("C:\\Users\\me\\vault\\notes\\zh-CN\\02 Agent 与 Skill.md");
	});
});

describe("Windows paper notes paths", () => {
	it.each([
		[
			String.raw`\\?\D:\新建文件夹 (2)\papers\风电齿轮`,
			String.raw`\\?\D:\新建文件夹 (2)\papers\风电齿轮\NOTES.md`,
		],
		[
			String.raw`\\?\D:\vault/papers/a/`,
			String.raw`\\?\D:\vault\papers\a\NOTES.md`,
		],
		["//?/D:/vault/papers/a", String.raw`\\?\D:\vault\papers\a\NOTES.md`],
		[
			String.raw`\\?\UNC\server\share\papers\a` + "\\",
			String.raw`\\?\UNC\server\share\papers\a\NOTES.md`,
		],
		["D:/vault/papers/a", String.raw`D:\vault\papers\a\NOTES.md`],
		["/vault/papers/a/", "/vault/papers/a/NOTES.md"],
		["remote:session/papers/a", "remote:session/papers/a/NOTES.md"],
	])("joins notes under %s", (parent, expected) => {
		expect(notesPathForPaper(parent)).toBe(expected);
	});

	it("repairs persisted mixed extended paths without stripping the prefix", () => {
		expect(normalizeLocalPath(String.raw`\\?\D:\vault\papers\a/NOTES.md`)).toBe(
			String.raw`\\?\D:\vault\papers\a\NOTES.md`,
		);
		expect(normalizeLocalPath("remote:session/notes/a.md")).toBe(
			"remote:session/notes/a.md",
		);
		expect(normalizeLocalPath("/vault/notes/a.md")).toBe("/vault/notes/a.md");
	});
});
