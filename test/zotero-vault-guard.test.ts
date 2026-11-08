import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { exists } from "@tauri-apps/plugin-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@/lib/core/tauri";
import { isZoteroDataDir } from "@/lib/paper/import/zotero-migrate";

vi.mock("@tauri-apps/api/path", () => ({
	join: async (...parts: string[]) => join(...parts),
	dirname: async (path: string) => dirname(path),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn() }));
vi.mock("@/lib/core/tauri", () => ({ isTauri: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

describe("Zotero onboarding vault guard", () => {
	let root: string;
	let home: string;
	let vault: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentero-zotero-guard-"));
		home = join(root, "home");
		vault = join(home, "Documents", "Agentero Vault");
		mkdirSync(vault, { recursive: true });
		vi.mocked(isTauri).mockReturnValue(true);
		vi.mocked(exists).mockReset();
		// Model $HOME/** using real files, including a scope-denied ancestor.
		vi.mocked(exists).mockImplementation(async (path) => {
			if (!path.startsWith(`${home}${sep}`)) {
				throw `forbidden path: ${path}`;
			}
			return existsSync(path);
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts a new vault when the ancestor search leaves the fs scope", async () => {
		await expect(isZoteroDataDir(vault)).resolves.toBe(false);
		expect(exists).toHaveBeenLastCalledWith(join(root, "zotero.sqlite"));
	});

	it.each([
		"selected directory",
		"parent directory",
	])("rejects Zotero data in the %s", async (location) => {
		const zotero = location === "selected directory" ? vault : dirname(vault);
		writeFileSync(join(zotero, "zotero.sqlite"), "");
		await expect(isZoteroDataDir(vault)).resolves.toBe(true);
	});

	it("handles scope errors represented as Error objects", async () => {
		vi.mocked(exists)
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(
				new Error(`forbidden path: ${join(dirname(vault), "zotero.sqlite")}`),
			);
		await expect(isZoteroDataDir(vault)).resolves.toBe(false);
	});

	it("preserves access failures for the selected directory", async () => {
		const error = `forbidden path: ${join(vault, "zotero.sqlite")}`;
		vi.mocked(exists).mockRejectedValueOnce(error);
		await expect(isZoteroDataDir(vault)).rejects.toBe(error);
	});

	it("preserves other errors while checking ancestors", async () => {
		const error = new Error("permission denied");
		vi.mocked(exists).mockResolvedValueOnce(false).mockRejectedValueOnce(error);
		await expect(isZoteroDataDir(vault)).rejects.toBe(error);
	});

	it("stops at the filesystem root when every ancestor is accessible", async () => {
		vi.mocked(exists).mockResolvedValue(false);
		await expect(isZoteroDataDir(vault)).resolves.toBe(false);
		let filesystemRoot = vault;
		while (dirname(filesystemRoot) !== filesystemRoot) {
			filesystemRoot = dirname(filesystemRoot);
		}
		expect(exists).toHaveBeenLastCalledWith(
			join(filesystemRoot, "zotero.sqlite"),
		);
	});

	it("skips filesystem access outside Tauri", async () => {
		vi.mocked(isTauri).mockReturnValue(false);
		await expect(isZoteroDataDir(vault)).resolves.toBe(false);
		expect(exists).not.toHaveBeenCalled();
	});
});
