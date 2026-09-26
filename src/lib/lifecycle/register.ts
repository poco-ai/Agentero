/**
 * Central lifecycle handler registration. The bus runs handlers serially in
 * registration order, so cross-handler ordering lives in this file.
 */

import i18n from "@/i18n";
import { clearAgentVaultState } from "@/lib/agent/agent-session-store";
import { commands } from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";
import {
	clearLibraryVaultState,
	refreshLibrary,
	runLibraryRefresh,
	scheduleLibraryRefresh,
} from "@/lib/paper/library-store";
import { clearAnnotationsVaultState } from "@/lib/pdf/annotations-store";
import { clearLayoutVaultState } from "@/lib/pdf/layout/store";
import { recommendArxiv } from "@/lib/recommend";
import { isFeatureViewType } from "@/lib/shell/feature-window";
import {
	clearUiVaultState,
	setFeaturePoppedOut,
	setSettingsOpenState,
} from "@/lib/shell/ui-store";
import { seedVaultSkills } from "@/lib/vault/actions";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import {
	getVaultPath,
	refreshTree,
	scheduleTreeRefresh,
} from "@/lib/vault/store";
import { remapMovedWorkspacePaths } from "@/lib/wiki/actions";
import {
	bumpWikiIndexRevision,
	clearWikiVaultState,
	rebuildWikiAndNotify,
	trackInternalRenamePaths,
} from "@/lib/wiki/store";
import { syncRenamedPaperTabs } from "@/lib/workspace/actions";

/** Batch imports emit one `paper:imported` per paper; merge the rebuilds. */
let importWikiTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleImportWikiRebuild(vault: string): void {
	if (importWikiTimer) clearTimeout(importWikiTimer);
	importWikiTimer = setTimeout(() => {
		importWikiTimer = null;
		if (isRemoteVaultHandle(vault) || getVaultPath() !== vault) return;
		void rebuildWikiAndNotify(vault);
	}, 300);
}

export function registerLifecycleHandlers(): () => void {
	const offs = [
		lifecycle.on("window:closed", ({ kind, view }) => {
			if (kind === "settings") {
				setSettingsOpenState(false);
				return;
			}
			if (kind === "feature" && isFeatureViewType(view)) {
				setFeaturePoppedOut(view, false);
			}
		}),
		lifecycle.on("vault:opened", ({ vaultId }) => {
			void refreshTree(vaultId);
			void refreshLibrary();
			seedVaultSkills(vaultId);
			if (isTauri()) {
				// T2 reconcile: backfill PAPER.md for catalog papers missing it. Fire
				// & forget; jobs are idempotent and throttled (ParseBody cap = 1).
				void callApiResult(
					() => commands.jobReconcileVault({ vaultPath: vaultId }),
					{ fallback: "vault reconcile failed" },
				).catch(() => undefined);
			}
			if (isTauri() && !isRemoteVaultHandle(vaultId)) {
				// Auto-ingest: adopt bare papers/ folders created while the app
				// was closed; the FS watcher only covers the live session.
				void callApiResult(
					() => commands.paperIngestReconcile({ vaultPath: vaultId }),
					{ fallback: "paper ingest reconcile failed" },
				).catch(() => undefined);
			}
			if (isTauri() && !isRemoteVaultHandle(vaultId)) {
				// Warm today's arXiv ranking so the Plaza panel opens instantly. The
				// Host returns its stored same-day run untouched and exits early when
				// no embedding endpoint is configured, so this is usually free.
				void recommendArxiv({ vaultPath: vaultId }).catch(() => undefined);
			}
			// `vaultId` is captured at setup, so this names the vault being closed.
			// `activateVault` keeps its own synchronous clears: those stop the first
			// painted frame of the new vault from showing the old one, which is a
			// different concern from releasing resources.
			return () => {
				clearLibraryVaultState();
				clearWikiVaultState();
				clearAgentVaultState();
				clearAnnotationsVaultState();
				clearLayoutVaultState();
				clearUiVaultState();
				if (isTauri() && !isRemoteVaultHandle(vaultId)) {
					void callApi(() => commands.vaultRelease(vaultId), {
						fallback: "vault release failed",
					}).catch(() => undefined);
				}
			};
		}),
		lifecycle.on("paper:imported", ({ vaultId, paperId }) => {
			// `app.emit` broadcasts to every window; only react to the active vault.
			if (vaultId !== getVaultPath()) return;
			// `paperId` is the folder basename, so point the targeted refresh at
			// `papers/` (re-listed eagerly by the Host, org subfolders included)
			// instead of rebuilding the whole tree, which would re-mark lazily
			// expanded folders as pending and cascade extra listings.
			scheduleTreeRefresh(
				paperId ? [joinVaultPath(vaultId, `papers/${paperId}`)] : undefined,
			);
			scheduleImportWikiRebuild(vaultId);
			scheduleLibraryRefresh();
		}),
		lifecycle.on("paper:renamed", (event) => {
			const { vaultId, oldPath, newPath, outcome } = event;
			if (vaultId !== getVaultPath()) return;
			const fromAbs = joinVaultPath(vaultId, oldPath);
			const toAbs = joinVaultPath(vaultId, newPath);
			// The Host performed this rename itself: suppress the watcher's
			// external-rename repair for its echoes (same window the UI move
			// flow uses, see `syncMovedPaths`).
			trackInternalRenamePaths([fromAbs, toAbs], Date.now() + 2000);
			if (outcome === "renamed") {
				remapMovedWorkspacePaths(fromAbs, toAbs, oldPath, newPath);
				bumpWikiIndexRevision();
				scheduleImportWikiRebuild(vaultId);
				void syncRenamedPaperTabs(vaultId, toAbs);
				void runLibraryRefresh();
				void refreshTree(vaultId, { quiet: true });
			}
			scheduleTreeRefresh([fromAbs, toAbs]);
			scheduleLibraryRefresh();
			if (outcome === "merged") {
				notifySuccess(
					i18n.t("sidebar:papersLibrary.recognizeMerged", {
						id: event.newPaperId,
					}),
				);
			}
		}),
	];
	return () => {
		if (importWikiTimer) {
			clearTimeout(importWikiTimer);
			importWikiTimer = null;
		}
		for (const off of offs) off();
	};
}
