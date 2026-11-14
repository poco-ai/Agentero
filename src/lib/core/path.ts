/** Convert backslashes to forward slashes. */
export function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** User-facing local path; keep extended paths unchanged for filesystem IO. */
export function displayPath(path: string): string {
	return path
		.replace(/^\\\\\?\\UNC\\/i, "\\\\")
		.replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
}

/** Forward slashes, no trailing slashes. */
export function normalizePath(path: string): string {
	return normalizeSlashes(path).replace(/\/+$/, "");
}

/** Forward slashes, no leading `./` or `/`, no trailing slashes. */
export function normalizeRelPath(path: string): string {
	return normalizePath(path).replace(/^\.?\//, "");
}

/**
 * Vault-relative paper path comparison key: forward slashes, no leading or
 * trailing slash runs. Unlike {@link normalizeRelPath} a `./` prefix is kept
 * and every leading slash is stripped; used to match background-task paper
 * rows against the currently open paper.
 */
export function normalizeRelPaperPath(path: string): string {
	return normalizeSlashes(path).replace(/^\/+|\/+$/g, "");
}

/** Whether two vault-relative paper paths refer to the same paper folder. */
export function sameRelPaperPath(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return false;
	return normalizeRelPaperPath(a) === normalizeRelPaperPath(b);
}

/** Last path segment, or the original string for a single segment. */
export function basenameOf(path: string): string {
	return normalizeSlashes(path).replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Parent directory (forward slashes); empty when there is no parent. */
export function dirnameOf(path: string): string {
	const normalized = normalizeSlashes(path).replace(/\/+$/, "");
	const idx = normalized.lastIndexOf("/");
	return idx <= 0 ? "" : normalized.slice(0, idx);
}

/**
 * Join a parent path with a child segment (or multi-segment rel path).
 *
 * Uses the parent's separator style so Windows vault roots keep backslashes.
 * Child segments may use either `/` or `\`; they are rewritten to match the
 * parent. This avoids mixed paths like `C:\\vault/notes/a.md`, which break
 * under Windows `\\?\` extended paths (CreateFile ERROR_INVALID_NAME / 123).
 */
export function joinPath(parent: string, name: string): string {
	if (!parent) return name;
	// Prefer backslash when the parent already looks Windows-native.
	const useBackslash = parent.includes("\\");
	const sep = useBackslash ? "\\" : "/";
	const root = parent.replace(/[\\/]+$/, "");
	// Normalize child to `/` first, then re-emit in the parent style.
	const segment = name.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
	if (!segment) return root;
	const tail = useBackslash ? segment.replace(/\//g, "\\") : segment;
	return `${root}${sep}${tail}`;
}

/** Strip vault root prefix when path is absolute. */
export function relativePathWithin(
	rootPath: string,
	path: string,
): string | null {
	// Only normalize for comparison. Preserve verbatim paths at filesystem calls.
	const comparable = (value: string) =>
		normalizePath(value)
			.replace(/^\/\/\?\/UNC\//i, "//")
			.replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
	const root = comparable(rootPath),
		child = comparable(path);
	const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
	const rootKey = windows ? root.toLowerCase() : root;
	const childKey = windows ? child.toLowerCase() : child;
	if (childKey === rootKey) return "";
	return childKey.startsWith(`${rootKey}/`)
		? child.slice(root.length + 1)
		: null;
}

/** Strip the vault root even when Windows spelling or verbatim prefixes differ. */
export function toVaultRelative(
	vaultPath: string | null,
	path: string,
): string {
	const n = normalizeRelPath(path);
	if (!vaultPath) {
		return n;
	}
	return relativePathWithin(vaultPath, path) ?? n;
}

/** Case-insensitive file/directory moves, applied in order without chaining. */
export function createPathRemapper(
	moves: readonly { from: string; to: string }[],
): (path: string) => string {
	return (path: string): string => {
		const current = normalizePath(path);
		const currentKey = current.toLowerCase();
		for (const move of moves) {
			const from = normalizePath(move.from);
			const to = normalizePath(move.to);
			const fromKey = from.toLowerCase();
			if (currentKey === fromKey) return to;
			if (currentKey.startsWith(`${fromKey}/`)) {
				return `${to}${current.slice(from.length)}`;
			}
		}
		return path;
	};
}
