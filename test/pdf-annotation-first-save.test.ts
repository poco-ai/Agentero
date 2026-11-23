/**
 * Regression: the first highlight/annotation saved on Windows must not be
 * blocked by the read that precedes the write. The FS plugin forwards Rust's
 * localized io error text (`...(os error 2)` / `...(os error 3)`), which used
 * to miss `isPathMissingError` and abort the save before the file existed.
 */
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	readVaultFile: vi.fn(),
	writeVaultFile: vi.fn(),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/ipc", () => ({
	callApi: async (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/core/bindings", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/core/bindings")>();
	return {
		...original,
		commands: { ...original.commands, pdfSaveAnnotations: mocks.save },
	};
});
vi.mock("@/lib/vault", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/vault")>();
	return {
		...original,
		readVaultFile: mocks.readVaultFile,
		writeVaultFile: mocks.writeVaultFile,
	};
});

import {
	loadAnnotationItems,
	mergeAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";

const item = (id: string) => ({
	annotation: {
		id,
		pageIndex: 0,
		type: 8,
		rect: { origin: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
		segmentRects: [],
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.save.mockResolvedValue(true);
});

it("creates the first annotations file when Windows reports a missing path", async () => {
	mocks.readVaultFile.mockRejectedValue(
		new Error("The system cannot find the path specified. (os error 3)"),
	);

	const result = await mergeAnnotationItems(
		"/vault/papers/p",
		(current) => {
			const items = [...current, item("a") as never];
			return { items, result: items.length };
		},
		"/vault",
	);

	expect(result).toBe(1);
	expect(mocks.save).toHaveBeenCalledTimes(1);
	const [vault, relative, expected, data] = mocks.save.mock.calls[0];
	expect(vault).toBe("/vault");
	expect(relative).toBe("papers/p");
	expect(expected).toBeNull();
	expect(JSON.parse(data as string)).toHaveLength(1);
});

it("migrates a legacy annotations file past a localized missing error", async () => {
	const legacy = JSON.stringify([item("legacy")]);
	mocks.readVaultFile.mockImplementation(async (path: string) => {
		if (path.endsWith("/marks/annotations.json")) {
			throw new Error("系统找不到指定的文件。 (os error 2)");
		}
		if (path.endsWith("/annotations.json")) return legacy;
		throw new Error(`unexpected read: ${path}`);
	});

	const items = await loadAnnotationItems("/vault/papers/p", "/vault");

	expect(items.map((entry) => entry.annotation.id)).toEqual(["legacy"]);
	expect(mocks.save).toHaveBeenCalledTimes(1);
	const [, relative, expected] = mocks.save.mock.calls[0];
	expect(relative).toBe("papers/p");
	expect(expected).toBe(legacy);
});
