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
