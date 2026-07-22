/**
 * One-click Zotero migration: read a local Zotero data directory (zotero.sqlite
 * + storage/) via the Host and write papers into the catalog. Fully local.
 */
import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

export type ZoteroCollectionInfo = {
	id: number;
	path: string;
	itemCount: number;
};

export type ZoteroItemInfo = {
	id: number;
	title: string;
	year: number | null;
	hasPdf: boolean;
	notes: number;
	collections: number[];
};

export type ZoteroScan = {
	valid: boolean;
	itemCount: number;
	withPdfCount: number;
	noteCount: number;
	collections: ZoteroCollectionInfo[];
	items: ZoteroItemInfo[];
	warning?: string;
};

export type ZoteroMigrateResult = {
	imported: number;
	skipped: number;
	copiedPdfs: number;
	notesAdded: number;
	pruned: number;
	paths: string[];
	errors: string[];
};

/** Folder picker for the Zotero data directory. Returns null when cancelled. */
export async function pickZoteroDir(): Promise<string | null> {
	const selected = await open({ directory: true, multiple: false });
	if (!selected) return null;
	return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

/** Read-only preview: how many references, and how many have a local PDF. */
export async function scanZotero(zoteroDir: string): Promise<ZoteroScan> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:zoteroMigrate.desktopOnly"));
	}
	return ipc<ZoteroScan>("zotero_scan", { args: { zoteroDir } });
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
	onProgress?: (current: number, total: number) => void;
}): Promise<ZoteroMigrateResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:zoteroMigrate.desktopOnly"));
	}
	const onProgress = new Channel<{ current: number; total: number }>();
	if (opts.onProgress) {
		const cb = opts.onProgress;
		onProgress.onmessage = (m) => cb(m.current, m.total);
	}
	return ipc<ZoteroMigrateResult>("zotero_migrate", {
		args: {
			vaultPath: opts.vaultPath,
			zoteroDir: opts.zoteroDir,
			parentDir: opts.parentDir ?? "papers",
			copyPdfs: opts.copyPdfs,
			preserveCollections: opts.preserveCollections,
			migrateNotes: opts.migrateNotes,
			migrateAnnotations: opts.migrateAnnotations,
			includeCollections: opts.includeCollections ?? null,
			includeItems: opts.includeItems ?? null,
		},
		onProgress,
	});
}
