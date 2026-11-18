/**
 * Finished translation results on disk: an identical request is answered from
 * the cache instead of being sent again. One namespace per surface (word
 * lookup, selection translate); entries age out after 30 days and prune to a
 * fixed capacity. A damaged, old or unwritable cache is always a miss.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import {
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename,
	stat,
	writeTextFile,
} from "@tauri-apps/plugin-fs";
import { isTauri } from "@/lib/core/tauri";
import { joinVaultPath } from "@/lib/vault/path";
import { TERMINOLOGY_REVISION } from "./terminology";

export type ResultCacheNamespace = "dictionary" | "selection";

const CAPACITY = 256;
const MAX_RESULT = 48_000;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

type Entry = {
	result: string;
	created: number;
	touched: number;
	persisted: boolean;
};

const memory = new Map<string, Entry>();
let writes = Promise.resolve();

function memoryKey(
	vault: string | null | undefined,
	namespace: ResultCacheNamespace,
	key: string,
): string {
	return JSON.stringify([vault ?? "", namespace, key]);
}

/** Hash the complete request contract; excerpts, settings and credentials never become filenames. */
export async function resultCacheKey(
	namespace: ResultCacheNamespace,
	identity: unknown,
): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify([`${namespace}-v1`, TERMINOLOGY_REVISION, identity]),
	);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function directory(
	vault: string | null | undefined,
	namespace: ResultCacheNamespace,
): Promise<string | null> {
	if (!isTauri()) return null;
	// Remote handles cannot be passed to the local filesystem plugin.
	return vault && !vault.startsWith("remote:")
		? joinVaultPath(vault, `.agentero/cache/${namespace}`)
		: join(await appCacheDir(), namespace);
}

function remember(
	id: string,
	result: string,
	created = Date.now(),
	touched = Date.now(),
	persisted = false,
): void {
	memory.delete(id);
	memory.set(id, { result, created, touched, persisted });
	while (memory.size > CAPACITY)
		memory.delete(memory.keys().next().value as string);
}

export async function readResultCache(
	namespace: ResultCacheNamespace,
	key: string,
	vault?: string | null,
): Promise<string | undefined> {
	const id = memoryKey(vault, namespace, key);
	const hit = memory.get(id);
	if (hit && Date.now() - hit.created < MAX_AGE) {
		// A separate Settings WebView can clear disk while this renderer still has an LRU hit.
		if (hit.persisted) {
			try {
				const dir = await directory(vault, namespace);
				if (dir && !(await exists(await join(dir, `${key}.json`)))) {
					memory.delete(id);
					return undefined;
				}
			} catch {
				/* A transient filesystem failure does not discard a valid memory entry. */
			}
		}
		if (Date.now() - hit.touched > 60_000) {
			hit.touched = Date.now();
			void persist(namespace, key, hit.result, vault, hit.created);
		}
		remember(id, hit.result, hit.created, hit.touched, hit.persisted);
		return hit.result;
	}
	memory.delete(id);
	try {
		const dir = await directory(vault, namespace);
		if (!dir) return undefined;
		const path = await join(dir, `${key}.json`);
		if ((await stat(path)).size > MAX_RESULT * 4 + 1000) return undefined;
		const data = JSON.parse(await readTextFile(path));
		if (
			data.version !== 1 ||
			data.key !== key ||
			typeof data.result !== "string" ||
			!data.result.trim() ||
			data.result.length > MAX_RESULT ||
			typeof data.created !== "number" ||
			!Number.isFinite(data.created) ||
			data.created > Date.now() ||
			Date.now() - data.created >= MAX_AGE
		)
			return undefined;
		remember(id, data.result, data.created, Date.now(), true);
		void persist(namespace, key, data.result, vault, data.created);
		return data.result;
	} catch {
		return undefined;
	}
}

/** Only completed successful results reach this function. Serialize atomic writes and LRU pruning. */
export function writeResultCache(
	namespace: ResultCacheNamespace,
	key: string,
	result: string,
	vault?: string | null,
): Promise<void> {
	if (!result.trim() || result.length > MAX_RESULT) return Promise.resolve();
	const created = Date.now();
	remember(memoryKey(vault, namespace, key), result, created);
	return persist(namespace, key, result, vault, created);
}

function persist(
	namespace: ResultCacheNamespace,
	key: string,
	result: string,
	vault: string | null | undefined,
	created: number,
): Promise<void> {
	writes = writes
		.catch(() => undefined)
		.then(async () => {
			const dir = await directory(vault, namespace);
			if (!dir) return;
			await mkdir(dir, { recursive: true });
			const target = await join(dir, `${key}.json`);
			const temp = await join(dir, `${key}-${crypto.randomUUID()}.tmp`);
			try {
				await writeTextFile(
					temp,
					JSON.stringify({ version: 1, key, result, created }),
				);
				await rename(temp, target);
				const hit = memory.get(memoryKey(vault, namespace, key));
				if (hit?.created === created && hit.result === result)
					hit.persisted = true;
			} finally {
				await remove(temp).catch(() => undefined);
			}
			const names = (await readDir(dir)).filter(
				(entry) => entry.isFile && /^[a-f0-9]{64}\.json$/.test(entry.name),
			);
			if (names.length <= CAPACITY) return;
			const files = await Promise.all(
				names.map(async (entry) => {
					const path = await join(dir, entry.name);
					return { path, time: (await stat(path)).mtime?.getTime() ?? 0 };
				}),
			);
			files.sort(
				(a, b) =>
					b.time - a.time ||
					Number(b.path === target) - Number(a.path === target),
			);
			await Promise.all(files.slice(CAPACITY).map(({ path }) => remove(path)));
		})
		.catch(() => undefined);
	return writes;
}

/** Clear one namespace, preserving other Vault metadata and caches. */
export function clearResultCache(
	namespace: ResultCacheNamespace,
	vault?: string | null,
): Promise<void> {
	const prefix = `${JSON.stringify([vault ?? "", namespace]).slice(0, -1)},`;
	for (const key of memory.keys())
		if (key.startsWith(prefix)) memory.delete(key);
	writes = writes
		.catch(() => undefined)
		.then(async () => {
			const dir = await directory(vault, namespace);
			if (!dir || !(await exists(dir))) return;
			const files = await readDir(dir);
			await Promise.all(
				files
					.filter(
						(file) =>
							file.isFile &&
							/^[a-f0-9]{64}(?:-[a-f0-9-]+)?\.(json|tmp)$/.test(file.name),
					)
					.map(async (file) => remove(await join(dir, file.name))),
			);
		});
	return writes;
}
