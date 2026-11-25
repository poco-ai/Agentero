/**
 * Usage stats and batch cleanup for the reflow caches (IR pages + final
 * builds) shown in Settings → About. Best-effort like the caches themselves:
 * a failed walk reports nothing instead of blocking the settings pane, and
 * `pdf-fonts/` is deliberately out of scope — fonts are content-pinned assets,
 * not per-paper state.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/core/tauri";
import { reflowIrCacheDirectory } from "@/lib/pdf/reflow/cache";

const IR_DIR = "reflow-ir";
const BUILD_DIR = "reflow-build";

export type ReflowCacheUsage = { papers: number; bytes: number };

async function walkFiles(
	dir: string,
): Promise<{ path: string; size: number }[]> {
	const entries = await readDir(dir);
	const files: { path: string; size: number }[] = [];
	for (const entry of entries) {
		const path = await join(dir, entry.name);
		if (entry.isDirectory) files.push(...(await walkFiles(path)));
		else if (entry.isFile) {
			try {
				const info = await stat(path);
				files.push({ path, size: info.size });
			} catch {
				// A file vanishing between readDir and stat is fine.
			}
		}
	}
	return files;
}

/**
 * Aggregate usage across `reflow-ir/` and `reflow-build/`. Paper count comes
 * from the IR subdirectories (every translated paper has IR; the build cache
 * keys by PDF hash, which cannot be mapped back to a paper folder).
 * Returns null outside Tauri or when the walk fails.
 */
export async function reflowCacheUsage(): Promise<ReflowCacheUsage | null> {
	if (!isTauri()) return null;
	try {
		const cacheRoot = await appCacheDir();
		const irRoot = await join(cacheRoot, IR_DIR);
		const buildRoot = await join(cacheRoot, BUILD_DIR);
		let papers = 0;
		let bytes = 0;
		try {
			const irEntries = await readDir(irRoot);
			papers = irEntries.filter((entry) => entry.isDirectory).length;
		} catch {
			// No IR cache yet.
		}
		for (const root of [irRoot, buildRoot]) {
			try {
				for (const file of await walkFiles(root)) bytes += file.size;
			} catch {
				// Missing directory contributes nothing.
			}
		}
		return { papers, bytes };
	} catch {
		return null;
	}
}

/**
 * Reveal the app cache folder that holds both reflow cache roots. Creates the
 * roots first so the folder exists even before the first translation.
 */
export async function openReflowCacheFolder(): Promise<void> {
	if (!isTauri()) return;
	const cacheRoot = await appCacheDir();
	await Promise.all([
		mkdir(await join(cacheRoot, IR_DIR), { recursive: true }),
		mkdir(await join(cacheRoot, BUILD_DIR), { recursive: true }),
	]);
	await openPath(cacheRoot);
}

/**
 * Delete every cached file under both cache roots (the roots themselves stay;
 * writers recreate content on demand). Returns the bytes freed, computed
 * before removal. Every removal is attempted even if one fails.
 */
export async function clearReflowCaches(): Promise<number> {
	if (!isTauri()) return 0;
	const cacheRoot = await appCacheDir();
	const irRoot = await join(cacheRoot, IR_DIR);
	const buildRoot = await join(cacheRoot, BUILD_DIR);
	let freed = 0;
	let firstError: unknown;
	for (const root of [irRoot, buildRoot]) {
		let files: { path: string; size: number }[] = [];
		try {
			files = await walkFiles(root);
		} catch {
			continue;
		}
		freed += files.reduce((sum, file) => sum + file.size, 0);
		await Promise.all(
			files.map(async (file) => {
				try {
					await remove(file.path, { recursive: true });
				} catch (error) {
					firstError ??= error;
				}
			}),
		);
	}
	if (firstError) throw firstError;
	return freed;
}

/**
 * Drop one paper's IR directory and any build-cache PDFs whose content hash
 * matches a PDF that lived in that paper. Unmapped hash files stay until
 * "clear all". Failures are ignored so a trash can still finish.
 */
export async function forgetPaperReflowCache(
	paperKeys: readonly string[],
	pdfSha256s: readonly string[],
): Promise<void> {
	if (!isTauri()) return;
	const cacheRoot = await appCacheDir();
	const keys = [...new Set(paperKeys.map((key) => key.trim()).filter(Boolean))];
	await Promise.all(
		keys.map(async (key) => {
			const dir = await reflowIrCacheDirectory(key);
			if (!dir) return;
			await remove(dir, { recursive: true }).catch(() => {});
		}),
	);
	const prefixes = [
		...new Set(
			pdfSha256s
				.map((hash) => hash.trim().toLowerCase().slice(0, 16))
				.filter((prefix) => /^[0-9a-f]{16}$/.test(prefix)),
		),
	];
	if (prefixes.length === 0) return;
	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(await join(cacheRoot, BUILD_DIR));
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isFile) return;
			if (!prefixes.some((prefix) => entry.name.startsWith(`${prefix}-`)))
				return;
			await remove(await join(cacheRoot, BUILD_DIR, entry.name)).catch(
				() => {},
			);
		}),
	);
}
