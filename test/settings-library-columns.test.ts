import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { applyExternalSettings, loadSettings } from "@/lib/settings/store";
import type { AppSettings, LibraryColumnPref } from "@/lib/settings/types";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

function normalize(columns: unknown): LibraryColumnPref[] {
	applyExternalSettings({
		...DEFAULT_SETTINGS,
		libraryColumns: columns,
	} as AppSettings);
	return loadSettings().libraryColumns;
}

describe("library column settings migration", () => {
	it("adds the date-added column hidden without changing existing order/visibility", () => {
		const existing = DEFAULT_SETTINGS.libraryColumns.filter(
			(c) => c.key !== "addedAt",
		);
		expect(normalize(existing)).toEqual([
			...existing,
			{ key: "addedAt", visible: false },
		]);
		const customized = [...existing]
			.reverse()
			.map((c) => ({ ...c, visible: c.key === "title" }));
		expect(normalize(customized)).toEqual([
			...customized,
			{ key: "addedAt", visible: false },
		]);
	});

	it("preserves the legacy year migration and the saved added-date choice", () => {
		const legacy = ["title", "authors", "year", "tags", "id"].map((key) => ({
			key,
			visible: true,
		}));
		const migrated = normalize(legacy);
		expect(migrated.map((c) => c.key)).toEqual([
			"title",
			"authors",
			"date",
			"publication",
			"tags",
			"id",
			"citations",
			"addedAt",
		]);
		expect(migrated.at(-1)).toEqual({ key: "addedAt", visible: false });
		migrated[migrated.length - 1].visible = true;
		expect(normalize(migrated)).toEqual(migrated);
	});
});

it("preserves valid saved widths and sanitizes invalid widths", () => {
	const columns = normalize([
		{ key: "title", visible: true, widthRem: 25.5 },
		{ key: "authors", visible: true, widthRem: -2 },
		{ key: "date", visible: true, widthRem: Number.NaN },
		{ key: "tags", visible: true, widthRem: 999 },
		{ key: "id", visible: true, widthRem: 1 },
	]);
	expect(columns.find((c) => c.key === "title")?.widthRem).toBe(25.5);
	expect(columns.find((c) => c.key === "authors")?.widthRem).toBeUndefined();
	expect(columns.find((c) => c.key === "date")?.widthRem).toBeUndefined();
	expect(columns.find((c) => c.key === "tags")?.widthRem).toBe(120);
	expect(columns.find((c) => c.key === "id")?.widthRem).toBe(5);
});
