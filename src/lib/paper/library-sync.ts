/**
 * Reconcile open workspace state when external tools (CLI, sync clients,
 * Finder) move papers while their tabs are open.
 *
 * macOS FSEvents cannot pair the two sides of a rename, and moving a paper
 * folder often reports only the new path (no rename pair, sometimes no
 * removal). The catalog is the reliable signal: after an external change
 * refreshes the Library list, a paper that kept its id but changed path moved,
 * and an id that vanished left the vault.
 */

import { isTauri } from "@/lib/core/tauri";
import type { PaperLibraryRow } from "@/lib/paper/types";
import { vaultPathExists } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import {
	getVaultPath,
	scheduleTreeRefresh,
	setTreeSelectedPath,
} from "@/lib/vault/store";
import {
	closeTabsUnderPath,
	remapMovedWorkspacePaths,
} from "@/lib/workspace/navigation";

export type PaperPathMove = {
	id: string;
	fromRel: string;
	toRel: string;
};

export type PaperPathRemoval = {
	id: string;
	rel: string;
};

export type PaperPathPlan = {
	moves: PaperPathMove[];
	removals: PaperPathRemoval[];
};

function relKey(path: string | null | undefined): string {
	return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Diff two catalog snapshots by paper id.
 *
 * A paper whose path changed moved; a paper id missing from `next` left the
 * vault (external delete or a cross-vault move). A removal whose path is
 * reoccupied by another row keeps its tabs: the folder still exists.
 */
export function planPaperPathChanges(
	previous: readonly PaperLibraryRow[],
	next: readonly PaperLibraryRow[],
): PaperPathPlan {
	const previousById = new Map<string, string>();
	for (const row of previous) {
		const id = row.id?.trim();
		const rel = relKey(row.path);
		if (!id || !rel || previousById.has(id)) continue;
		previousById.set(id, rel);
	}
	const nextById = new Map<string, string>();
	const occupied = new Set<string>();
	for (const row of next) {
		const rel = relKey(row.path);
		if (rel) occupied.add(rel);
		const id = row.id?.trim();
		if (!id || !rel || nextById.has(id)) continue;
		nextById.set(id, rel);
	}

	const moves: PaperPathMove[] = [];
	for (const [id, toRel] of nextById) {
		const fromRel = previousById.get(id);
		if (!fromRel || fromRel === toRel) continue;
		moves.push({ id, fromRel, toRel });
	}
	const removals: PaperPathRemoval[] = [];
	for (const [id, rel] of previousById) {
		if (nextById.has(id) || occupied.has(rel)) continue;
		removals.push({ id, rel });
	}
	return { moves, removals };
}

function isAtOrUnder(path: string, root: string): boolean {
	const current = relKey(path).toLowerCase();
	const target = relKey(root).toLowerCase();
	return current === target || current.startsWith(`${target}/`);
}

/**
 * Move open tabs to the new paper paths and close tabs whose paper left the
 * vault. Runs after an external Library refresh, before the new rows are
 * published, so `previous` is still the pre-move snapshot.
 */
export async function reconcileExternalLibraryChange(
	vaultPath: string,
	previous: readonly PaperLibraryRow[],
	next: readonly PaperLibraryRow[],
): Promise<void> {
	if (
		previous.length === 0 ||
		!isTauri() ||
		isRemoteVaultHandle(vaultPath) ||
		getVaultPath() !== vaultPath
	) {
		return;
	}
	const { moves, removals } = planPaperPathChanges(previous, next);
	const treePaths: string[] = [];

	for (const move of moves) {
		const fromAbs = joinVaultPath(vaultPath, move.fromRel);
		const toAbs = joinVaultPath(vaultPath, move.toRel);
		// Also carries tree selection and the Library scope; both can point
		// into the moved folder with no tab open.
		remapMovedWorkspacePaths(fromAbs, toAbs, move.fromRel, move.toRel);
		treePaths.push(fromAbs, toAbs);
	}

	for (const removal of removals) {
		const fromAbs = joinVaultPath(vaultPath, removal.rel);
		// Moving a folder out of the watch root reports only its old path; the
		// parent still needs a fresh listing to drop the stale tree node.
		treePaths.push(fromAbs);
		// A catalog row can briefly vanish while a write is in flight; only a
		// folder that is really gone loses its state.
		if (await vaultPathExists(fromAbs)) continue;
		closeTabsUnderPath(fromAbs);
		setTreeSelectedPath((current) =>
			current && isAtOrUnder(current, fromAbs) ? null : current,
		);
	}

	if (treePaths.length > 0) scheduleTreeRefresh(treePaths);
}
