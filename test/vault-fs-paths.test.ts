import {
	exists,
	mkdir,
	readFile,
	readTextFile,
	writeFile,
	writeTextFile,
} from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	readVaultBytes,
	readVaultFile,
	vaultPathExists,
	writeVaultBytes,
	writeVaultFile,
} from "@/lib/vault/fs";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-fs", () => ({
	readTextFile: vi.fn().mockResolvedValue("# notes"),
	readFile: vi.fn().mockResolvedValue(new Uint8Array()),
	writeTextFile: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	exists: vi.fn().mockResolvedValue(true),
}));

describe("Vault plugin-fs boundary", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		String.raw`\\?\D:\新建文件夹 (2)\papers\风电齿轮/NOTES.md`,
		"//?/D:/新建文件夹 (2)/papers/风电齿轮/NOTES.md",
	])("normalizes old mixed notes paths for reading and autosaving: %s", async (path) => {
		const expected = String.raw`\\?\D:\新建文件夹 (2)\papers\风电齿轮\NOTES.md`;
		expect(await readVaultFile(path)).toBe("# notes");
		await writeVaultFile(path, "edited notes");
		expect(readTextFile).toHaveBeenCalledWith(expected);
		expect(mkdir).toHaveBeenCalledWith(
			String.raw`\\?\D:\新建文件夹 (2)\papers\风电齿轮`,
			{ recursive: true },
		);
		expect(writeTextFile).toHaveBeenCalledWith(expected, "edited notes");
		const bytes = new Uint8Array([1, 2]);
		await readVaultBytes(path);
		await writeVaultBytes(path, bytes);
		await vaultPathExists(path);
		expect(readFile).toHaveBeenCalledWith(expected);
		expect(writeFile).toHaveBeenCalledWith(expected, bytes);
		expect(exists).toHaveBeenCalledWith(expected);
	});
});
