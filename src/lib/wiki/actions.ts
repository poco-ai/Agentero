/**
 * Wiki-aware rename/move orchestration: heading rename, workspace remapping
 * after a filesystem move, and the external-rename repair flow. These cross
 * vault / workspace / library domains through their stores.
 */

import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isUnderPapers } from "@/lib/paper";
import { refreshLibrary } from "@/lib/paper/library-store";
import { getSettings } from "@/lib/settings/react-store";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault";
import type { VaultFileChangedPayload } from "@/lib/vault/fs-watch";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath, refreshTree } from "@/lib/vault/store";
import {
	applyExternalRenameRepair,
	externalRenameRepairHadZeroWrites,
	externalRenameRepairNeeded,
	previewExternalRenameRepair,
	renameWikiHeading,
	type WikiExternalRenamePreview,
	type WikiRenameHeadingRequest,
	type WikiRenameResult,
	wikiRenameFailure,
} from "@/lib/wiki";
import { notifyWikiEmbedTargets } from "@/lib/wiki/embed-refresh";
import {
	wikiHeadingRenameAffectedPaths,
	wikiHeadingRenameErrorKey,
} from "@/lib/wiki/heading-rename";
import {
	bumpWikiIndexRevision,
	setExternalRenameFailure,
	setExternalRenamePreview,
	setExternalRenameRepairing,
	setExternalRenameVaultPath,
	trackInternalRenamePaths,
} from "@/lib/wiki/store";
import { applyDiskChange, dirtyVaultPaths } from "@/lib/workspace/actions";
import { remapMovedWorkspacePaths } from "@/lib/workspace/navigation";

export async function renameWikiHeadingAction(
	absPath: string,
	request: Omit<WikiRenameHeadingRequest, "path">,
): Promise<void> {
	const root = getVaultPath();
	const path = root ? vaultRelativePath(root, absPath) : null;
	if (!root || !path || isRemoteVaultHandle(root)) {
		const error = new Error(i18n.t("editor:headingRename.errors.localOnly"));
		notifyError(error.message);
		throw error;
	}
	const pendingPaths = [absPath];
	trackInternalRenamePaths(pendingPaths, Number.POSITIVE_INFINITY);
	try {
		const result = await renameWikiHeading(
			root,
			{ path, ...request },
			dirtyVaultPaths(root),
		);
		const affectedRelative = wikiHeadingRenameAffectedPaths(result);
		const affectedAbsolute = affectedRelative.map((source) =>
			joinVaultPath(root, source),
		);
		trackInternalRenamePaths(affectedAbsolute, Date.now() + 2000);
		await Promise.all(affectedAbsolute.map((path) => applyDiskChange(path)));
		bumpWikiIndexRevision();
		notifyWikiEmbedTargets(affectedAbsolute);
		notifySuccess(
			i18n.t("editor:headingRename.success", {
				count: result.updatedSources.length,
			}),
		);
	} catch (error) {
		trackInternalRenamePaths(pendingPaths, Date.now() + 2000);
		const key = wikiHeadingRenameErrorKey(error);
		const failure = wikiRenameFailure(error);
		const blockedPaths =
			failure?.code === "unsavedEdits" ? failure.paths : undefined;
		notifyError(i18n.t(`editor:headingRename.errors.${key}`), {
			description: blockedPaths?.length
				? i18n.t("editor:headingRename.errors.unsavedFiles", {
						paths: blockedPaths.join(" · "),
					})
				: undefined,
		});
		throw error;
	}
}

export function syncMovedPaths(
	root: string,
	fromAbs: string,
	toAbs: string,
	fromRel: string,
	toRel: string,
	linkUpdate: WikiRenameResult,
): void {
	const expiresAt = Date.now() + 2000;
	trackInternalRenamePaths(
		[
			fromAbs,
			toAbs,
			...linkUpdate.updatedSources.map((source) => joinVaultPath(root, source)),
		],
		expiresAt,
	);
	remapMovedWorkspacePaths(fromAbs, toAbs, fromRel, toRel);
	bumpWikiIndexRevision();
	window.setTimeout(() => {
		for (const source of linkUpdate.updatedSources) {
			void applyDiskChange(joinVaultPath(root, source));
		}
	}, 0);
}

export async function applyPendingExternalRenameRepair(
	preview: WikiExternalRenamePreview,
	root: string,
): Promise<void> {
	if (getVaultPath() !== root || isRemoteVaultHandle(root)) {
		throw new Error(i18n.t("app:vault.externalRename.vaultChanged"));
	}
	setExternalRenameRepairing(true);
	try {
		const result = await applyExternalRenameRepair(
			root,
			preview.candidateId,
			dirtyVaultPaths(root),
		);
		const fromAbs = joinVaultPath(root, preview.from);
		const toAbs = joinVaultPath(root, preview.to);
		syncMovedPaths(root, fromAbs, toAbs, preview.from, preview.to, result);
		await refreshTree(root);
		await refreshLibrary();
		setExternalRenamePreview(null);
		setExternalRenameVaultPath(null);
		setExternalRenameFailure(null);
		notifySuccess(
			i18n.t("app:vault.externalRename.repaired", {
				count: result.updatedSources.length,
			}),
		);
	} finally {
		setExternalRenameRepairing(false);
	}
}

export async function handleExternalRename(
	rename: NonNullable<VaultFileChangedPayload["rename"]>,
): Promise<void> {
	const root = getVaultPath();
	if (!root || isRemoteVaultHandle(root)) return;
	const fromRel = vaultRelativePath(root, rename.from);
	const toRel = vaultRelativePath(root, rename.to);
	if (!fromRel || !toRel || fromRel === toRel) {
		console.warn(
			"[wiki] unverified external rename; links left unchanged",
			rename,
		);
		return;
	}
	const fromAbs = joinVaultPath(root, fromRel);
	const toAbs = joinVaultPath(root, toRel);

	// Rewrite catalog path prefixes before the UI remap so paper titles and
	// metadata follow the filesystem move. Best-effort: if it fails, the
	// workspace remap below still keeps tabs pointing at the new disk path.
	if (isUnderPapers(fromAbs) && isUnderPapers(toAbs)) {
		try {
			await callApi(() =>
				commands.paperRepath({ vaultPath: root, fromRel, toRel }),
			);
		} catch (error) {
			console.warn("[wiki] paper_repath failed", error);
		}
	}

	const emptyResult: WikiRenameResult = {
		movedPath: toRel,
		updatedSources: [],
		skipped: [],
		rollback: "not-needed",
	};
	try {
		const preview = await previewExternalRenameRepair(
			root,
			fromRel,
			toRel,
			dirtyVaultPaths(root),
		);
		if (!externalRenameRepairNeeded(preview)) {
			// No markdown links need repair, but open tabs / tree selection still
			// must follow the filesystem move.
			syncMovedPaths(root, fromAbs, toAbs, fromRel, toRel, emptyResult);
			await refreshTree(root);
			await refreshLibrary();
			setExternalRenameVaultPath(null);
			setExternalRenamePreview(null);
			setExternalRenameFailure(null);
			return;
		}
		if (getSettings().autoUpdateInternalLinks === "always") {
			// applyPendingExternalRenameRepair remaps tabs and refreshes as part
			// of applying the link repair.
			try {
				await applyPendingExternalRenameRepair(preview, root);
			} catch (error) {
				console.warn("[wiki] automatic external rename repair blocked", error);
				setExternalRenameVaultPath(root);
				setExternalRenamePreview(null);
				const failure = wikiRenameFailure(error);
				setExternalRenameFailure({
					from: preview.from,
					to: preview.to,
					affectedSources: preview.affectedSources.length,
					zeroWrite: externalRenameRepairHadZeroWrites(error),
					rollback: failure?.rollback,
					error:
						error instanceof Error
							? error.message
							: i18n.t("app:vault.externalRename.failed"),
				});
			}
			return;
		}
		// Ask mode: keep the workspace in sync immediately, then present the link
		// repair dialog for the user to confirm.
		syncMovedPaths(root, fromAbs, toAbs, fromRel, toRel, emptyResult);
		await refreshTree(root);
		await refreshLibrary();
		setExternalRenameVaultPath(root);
		setExternalRenameFailure(null);
		setExternalRenamePreview(preview);
	} catch (error) {
		// Even if link-repair preview or apply failed, the move already happened
		// on disk: remap open tabs so they don't point at a stale path.
		console.warn("[wiki] external rename repair unavailable", error);
		syncMovedPaths(root, fromAbs, toAbs, fromRel, toRel, emptyResult);
		await refreshTree(root);
		await refreshLibrary();
		setExternalRenameVaultPath(root);
		setExternalRenamePreview(null);
		setExternalRenameFailure({
			from: fromRel,
			to: toRel,
			affectedSources: null,
			zeroWrite: true,
			error:
				error instanceof Error
					? error.message
					: i18n.t("app:vault.externalRename.failed"),
		});
	}
}
