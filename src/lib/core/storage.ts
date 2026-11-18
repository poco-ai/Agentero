/**
 * Best-effort JSON helpers for Web Storage (localStorage / sessionStorage /
 * injected Storage-like objects used in tests).
 */

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
	try {
		if (typeof localStorage === "undefined") return null;
		return localStorage;
	} catch {
		return null;
	}
}

/** Read and JSON-parse a key; return `fallback` on missing / corrupt / unavailable. */
export function readJsonStorage<T>(
	key: string,
	fallback: T,
	storage: StorageLike | null | undefined = defaultStorage(),
): T {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(key);
		if (raw == null || raw === "") return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** JSON-stringify and write; returns false when storage is unavailable or throws. */
export function writeJsonStorage(
	key: string,
	value: unknown,
	storage: StorageLike | null | undefined = defaultStorage(),
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

/** Remove a key; swallows quota / private-mode failures. */
export function removeStorageKey(
	key: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): void {
	if (!storage) return;
	try {
		storage.removeItem(key);
	} catch {
		// ignore
	}
}

type StorageRawRead =
	| { status: "unavailable" }
	| { status: "missing" }
	| { status: "present"; raw: string };

/**
 * Read a key's stored text. An empty string is missing.
 * Does not JSON-parse; parse failures stay with the caller.
 */
export function readStorageRaw(
	key: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): StorageRawRead {
	if (!storage) return { status: "unavailable" };
	try {
		const raw = storage.getItem(key);
		if (raw == null || raw === "") return { status: "missing" };
		return { status: "present", raw };
	} catch {
		return { status: "unavailable" };
	}
}

/** Write raw text unchanged. Returns false when storage is unavailable or throws. */
export function writeStorageRaw(
	key: string,
	raw: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(key, raw);
		return true;
	} catch {
		return false;
	}
}
