import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";

import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";
import {
	type CreateVaultResult,
	type FileNode,
	isEagerTreeRel,
	joinPath,
	shouldIgnoreTreeName,
	sortNodes,
} from "@/lib/vault/types";

/**
 * Build directory children on the local filesystem.
 *
 * - `shallowOnly=false` (initial open): eager roots recurse fully; other dirs
 *   are listed **once** (one level of files + subdir shells with `childrenPending`).
 * - `shallowOnly=true` (inside a non-eager tree, or expand): files only; subdirs
 *   become pending shells (no further list until expand).
 *
 * `rel` is vault-relative (`""` at root). Local uses absolute `dirPath`.
 */
export async function buildTreeLocal(
	dirPath: string,
	rel: string,
	depth = 0,
	shallowOnly = false,
): Promise<FileNode[]> {
	if (depth > 12) return [];

	const entries = await readDir(dirPath);
	const nodes: FileNode[] = [];

	for (const entry of entries) {
		if (!entry.name || shouldIgnoreTreeName(entry.name)) continue;

		const path = joinPath(dirPath, entry.name);
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory) {
			const node = await buildDirNodeLocal(
				path,
				entry.name,
				childRel,
				depth,
				shallowOnly,
			);
			nodes.push(node);
		} else if (entry.isFile) {
			nodes.push({
				id: path,
				name: entry.name,
				path,
				kind: "file",
			});
		}
	}

	return sortNodes(nodes);
}

async function buildDirNodeLocal(
	path: string,
	name: string,
	childRel: string,
	depth: number,
	shallowOnly: boolean,
): Promise<FileNode> {
	// Already one level into a non-eager tree (or expand): do not list further.
	if (shallowOnly) {
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children: [],
			childrenPending: true,
		};
	}
	if (isEagerTreeRel(childRel)) {
		const children = await buildTreeLocal(path, childRel, depth + 1, false);
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children,
		};
	}
	// Non-product dir: list exactly one level; nested dirs stay pending.
	const children = await buildTreeLocal(path, childRel, depth + 1, true);
	return {
		id: path,
		name,
		path,
		kind: "directory",
		children,
		childrenPending: false,
	};
}

export async function pickVaultDirectory(): Promise<string | null> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.openDesktopOnly"));
	}

	const selected = await open({
		directory: true,
		multiple: false,
		title: i18n.t("app:vault.dialogTitle"),
	});

	if (selected === null) return null;
	const path = Array.isArray(selected) ? selected[0] : selected;
	return path ?? null;
}

/** Pick a directory that will be scaffolded as a new Agentero vault. */
export async function pickCreateVaultDirectory(): Promise<string | null> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const selected = await open({
		directory: true,
		multiple: false,
		title: i18n.t("app:vault.createDialogTitle"),
	});

	if (selected === null) return null;
	const path = Array.isArray(selected) ? selected[0] : selected;
	return path ?? null;
}

/**
 * Scaffold a Agentero vault at `path` (Host: vault_create).
 * Creates papers/notes/plans/.agentero, AGENTS.md, catalog.sqlite.
 * Does not create PAPERS.md / library.bib. Does not overwrite existing files.
 */
export async function createVault(path: string): Promise<CreateVaultResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const { logOp } = await import("@/lib/logger");
	return logOp("createVault", { path }, () =>
		ipc<CreateVaultResult>("vault_create", { path }),
	);
}
