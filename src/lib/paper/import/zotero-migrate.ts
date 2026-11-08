/**
 * One-click Zotero migration: read a local Zotero data directory (zotero.sqlite
 * + storage/) via the Host and write papers into the catalog. Fully local.
 */
import { Channel } from "@tauri-apps/api/core";
import {
	appDataDir,
	configDir,
	dataDir,
	dirname,
	homeDir,
	join,
} from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import {
	commands,
	type MigrateProgress,
	type ZoteroMigrateResult,
	type ZoteroScan_Serialize,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type { ZoteroMigrateResult };

export type ZoteroScan = Omit<ZoteroScan_Serialize, "warning"> & {
	warning?: string;
};

export type ZoteroMigratePhase = "migrate" | "parse";

/** Folder picker for the Zotero data directory. Returns null when cancelled. */
export async function pickZoteroDir(): Promise<string | null> {
	const selected = await open({ directory: true, multiple: false });
	if (!selected) return null;
	return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

/** Return existing platform-default Zotero data directories in preference order. */
export async function discoverZoteroDirs(): Promise<string[]> {
	if (!isTauri()) return [];
	const [home, appData, config, data] = await Promise.all([
		homeDir(),
		appDataDir(),
		configDir(),
		dataDir(),
	]);
	const candidates = [
		await join(home, "Library", "Zotero"),
		await join(home, "Zotero"),
		await join(appData, "Zotero"),
		await join(config, "zotero"),
		await join(data, "zotero"),
		await join(home, ".zotero", "zotero"),
		await join(home, ".local", "share", "zotero"),
	];
	const found: string[] = [];
	for (const candidate of [...new Set(candidates)]) {
		if (await exists(await join(candidate, "zotero.sqlite"))) {
			found.push(candidate);
		}
	}
	return found;
}

/** Guard the onboarding vault picker against placing a vault inside Zotero data. */
export async function isZoteroDataDir(path: string): Promise<boolean> {
	if (!isTauri()) return false;
	let current = path;
	for (let depth = 0; depth < 32; depth++) {
		const sqlitePath = await join(current, "zotero.sqlite");
		try {
			if (await exists(sqlitePath)) return true;
		} catch (error) {
			// The picker grants the selected directory, not all of its ancestors.
			if (depth > 0 && errorText(error).startsWith("forbidden path:")) break;
			throw error;
		}
		const parent = await dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

/** Backend scan error when the picked folder holds no zotero.sqlite. */
export function isSqliteMissingError(e: unknown): boolean {
	return e instanceof Error && e.message.includes("zotero.sqlite not found");
}

/** If `picked` holds no zotero.sqlite but its parent does, return the parent. */
export async function suggestZoteroParentDir(
	picked: string,
): Promise<string | null> {
	if (!isTauri()) return null;
	try {
		const { dirname, join } = await import("@tauri-apps/api/path");
		const { exists } = await import("@tauri-apps/plugin-fs");
		const parent = await dirname(picked);
		if (parent === picked) return null;
		return (await exists(await join(parent, "zotero.sqlite"))) ? parent : null;
	} catch {
		return null;
	}
}

/** Read-only preview: how many references, and how many have a local PDF. */
export async function scanZotero(zoteroDir: string): Promise<ZoteroScan> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:zoteroMigrate.desktopOnly"));
	}
	const scan = await callApi(() => commands.zoteroScan({ zoteroDir }), {
		fallback: "zotero_scan failed",
	});
	return { ...scan, warning: scan.warning ?? undefined };
}

/** Migrate the Zotero library into `parentDir` + catalog; optionally copy PDFs. */
export async function migrateZotero(opts: {
	vaultPath: string;
	zoteroDir: string;
	parentDir?: string;
	copyPdfs: boolean;
	preserveCollections: boolean;
	migrateNotes: boolean;
	migrateAnnotations: boolean;
	includeCollections?: number[];
	includeItems?: number[];
	/** Selected collection: placement prefers this subtree for multi-folder items. */
	preferCollection?: number;
	onProgress?: (
		current: number,
		total: number,
		phase: ZoteroMigratePhase,
	) => void;
}): Promise<ZoteroMigrateResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:zoteroMigrate.desktopOnly"));
	}
	const onProgress = new Channel<MigrateProgress>();
	if (opts.onProgress) {
		const cb = opts.onProgress;
		onProgress.onmessage = (m) =>
			cb(m.current, m.total, m.phase as ZoteroMigratePhase);
	}
	return callApi(
		() =>
			commands.zoteroMigrate(
				{
					vaultPath: opts.vaultPath,
					zoteroDir: opts.zoteroDir,
					parentDir: opts.parentDir ?? "papers",
					copyPdfs: opts.copyPdfs,
					preserveCollections: opts.preserveCollections,
					migrateNotes: opts.migrateNotes,
					migrateAnnotations: opts.migrateAnnotations,
					includeCollections: opts.includeCollections ?? null,
					includeItems: opts.includeItems ?? null,
					preferCollection: opts.preferCollection ?? null,
				},
				onProgress,
			),
		{ fallback: "zotero_migrate failed" },
	);
}
