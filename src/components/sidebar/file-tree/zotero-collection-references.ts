import { dirnameOf } from "@/lib/core/path";
import type { PaperLibraryRow } from "@/lib/paper";
import { zoteroCollectionPaths, zoteroCollectionRoot } from "@/lib/paper/tags";
import type { FileNode } from "@/lib/vault";
import { joinVaultPath, normalizePathKey } from "@/lib/vault/path";

const ZOTERO_REFERENCE_PREFIX = "agentero:zotero-reference/";

export type ZoteroCollectionReference = {
	/** Virtual row path; never passed to filesystem operations. */
	path: string;
	paper: PaperLibraryRow;
};

/** Stable virtual row path for a reference rendered inside a real folder. */
export function zoteroCollectionReferencePath(
	folderPath: string,
	paperPath: string,
): string {
	return `${ZOTERO_REFERENCE_PREFIX}${encodeURIComponent(folderPath)}/${encodeURIComponent(paperPath)}`;
}

/** Resolve the real vault-relative paper path from a virtual reference row. */
export function zoteroCollectionReferenceRelPath(path: string): string | null {
	if (!path.startsWith(ZOTERO_REFERENCE_PREFIX)) return null;
	const encoded = path.slice(ZOTERO_REFERENCE_PREFIX.length).split("/")[1];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded) || null;
	} catch {
		return null;
	}
}

export function isZoteroCollectionReferencePath(path: string): boolean {
	return path.startsWith(ZOTERO_REFERENCE_PREFIX);
}

function normalizedRel(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Older migrations lack the explicit collection root. Recover it from the
 * paper's real location and whichever saved membership matches its parent.
 */
function inferCollectionRoot(
	paperPath: string,
	collections: readonly string[],
): string | null {
	const parent = normalizedRel(dirnameOf(paperPath));
	for (const collection of [...collections].sort(
		(a, b) => b.length - a.length,
	)) {
		const suffix = normalizedRel(collection);
		if (parent === suffix) return "";
		if (parent.endsWith(`/${suffix}`)) {
			return parent.slice(0, -(suffix.length + 1));
		}
	}
	return null;
}

/**
 * References grouped by existing physical collection folder. Canonical papers
 * are deliberately omitted: only the other Zotero memberships become virtual
 * rows, so each folder reads like its Zotero counterpart without disk copies.
 */
export function buildZoteroCollectionReferences({
	papers,
	vaultPath,
	byPathKey,
}: {
	papers: readonly PaperLibraryRow[];
	vaultPath: string | null;
	byPathKey: ReadonlyMap<string, FileNode>;
}): ReadonlyMap<string, ZoteroCollectionReference[]> {
	const out = new Map<string, ZoteroCollectionReference[]>();
	if (!vaultPath) return out;

	for (const paper of papers) {
		if (!paper.path) continue;
		const collections = zoteroCollectionPaths(paper.tags);
		const root =
			zoteroCollectionRoot(paper.tags) ??
			inferCollectionRoot(paper.path, collections);
		if (root === null) continue;
		const canonicalParent = joinVaultPath(vaultPath, dirnameOf(paper.path));
		for (const collection of collections) {
			const folder = joinVaultPath(vaultPath, `${root}/${collection}`);
			const physicalFolder = byPathKey.get(normalizePathKey(folder));
			if (physicalFolder?.kind !== "directory") continue;
			if (
				normalizePathKey(physicalFolder.path) ===
				normalizePathKey(canonicalParent)
			) {
				continue;
			}
			const refs = out.get(physicalFolder.path) ?? [];
			if (!refs.some((reference) => reference.paper.path === paper.path)) {
				refs.push({
					path: zoteroCollectionReferencePath(physicalFolder.path, paper.path),
					paper,
				});
			}
			out.set(physicalFolder.path, refs);
		}
	}

	for (const references of out.values()) {
		references.sort((a, b) =>
			(a.paper.title || a.paper.id).localeCompare(b.paper.title || b.paper.id),
		);
	}
	return out;
}
