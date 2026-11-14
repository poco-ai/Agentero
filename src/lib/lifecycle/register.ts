import { loadCustomProperties } from "@/lib/paper/custom-properties-store";
/**
 * Central lifecycle handler registration. The bus runs handlers serially in
 * registration order, so cross-handler ordering lives in this file.
 */

import i18n from "@/i18n";
import { clearAgentVaultState } from "@/lib/agent/agent-session-store";
import { closeZenWorkspace } from "@/lib/agent/zen-store";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifySuccess } from "@/lib/core/notify";
import { perfActive, perfFollow } from "@/lib/core/perf";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";
import { jobTerminalCue } from "@/lib/lifecycle/job-cues";
import {
	noteCommittedLibraryList,
	noteCommittedPaths,
	noteCommittedRename,
	registerExternalLibraryReconciler,
} from "@/lib/lifecycle/refresh-wave";
import { registerSuggestionLifecycle } from "@/lib/navigator/suggestion-lifecycle";
import {
	dismissPaperBackfill,
	maybeShowPaperBackfill,
} from "@/lib/paper/backfill";
import {
	clearLibraryVaultState,
	refreshLibrary,
} from "@/lib/paper/library-store";
import { reconcileExternalLibraryChange } from "@/lib/paper/library-sync";
import { clearAnnotationsVaultState } from "@/lib/pdf/annotations-store";
import { clearLayoutVaultState } from "@/lib/pdf/layout/store";
import { recommendArxiv } from "@/lib/recommend";
import { isFeatureViewType } from "@/lib/shell/feature-window";
import {
	clearUiVaultState,
	setFeaturePoppedOut,
	setSettingsOpenState,
} from "@/lib/shell/ui-store";
import { playCue } from "@/lib/ui/sound";
import { seedVaultSkills } from "@/lib/vault/actions";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import {
	getVaultPath,
	refreshTree,
	scheduleTreeRefresh,
} from "@/lib/vault/store";
import {
	clearWikiVaultState,
	trackInternalRenamePaths,
} from "@/lib/wiki/store";
import {
	remapMovedWorkspacePaths,
	syncRenamedPaperTabs,
} from "@/lib/workspace/actions";

/**
 * Every webview receives the same broadcast job events. Audio belongs to the
 * main window only, otherwise two Web Audio contexts play the cue twice.
 * Resolved once at startup; jobs finish long after this settles.
 */
let jobAudioOwner = !isTauri();
if (isTauri()) {
	void import("@tauri-apps/api/window")
		.then(({ getCurrentWindow }) => {
			jobAudioOwner = getCurrentWindow().label === "main";
		})
		.catch(() => undefined);
}
function ownsJobAudioCues(): boolean {
	return jobAudioOwner;
}

export function registerLifecycleHandlers(): () => void {
	registerExternalLibraryReconciler(reconcileExternalLibraryChange);
	const unregisterSuggestions = registerSuggestionLifecycle();
	const offs = [
		// Full-document layout translation runs for minutes with the user
		// elsewhere, so its terminal state gets an audio cue. Other job kinds
		// stay visual: they are frequent and usually already on screen.
		lifecycle.on("job:completed", ({ kind }) => {
			const cue = jobTerminalCue("completed", kind);
			if (cue && ownsJobAudioCues()) playCue(cue);
		}),
		lifecycle.on("job:failed", ({ kind }) => {
			const cue = jobTerminalCue("failed", kind);
			if (cue && ownsJobAudioCues()) playCue(cue);
		}),
		lifecycle.on("window:closed", ({ kind, view }) => {
			if (kind === "settings") {
				setSettingsOpenState(false);
				return;
			}
			if (kind === "feature" && isFeatureViewType(view)) {
				setFeaturePoppedOut(view, false);
			}
		}),
		lifecycle.on("vault:opened", async ({ vaultId }) => {
			const opened = Promise.all([
				refreshTree(vaultId),
				refreshLibrary(),
				loadCustomProperties(vaultId),
			]);
			perfFollow(opened);
			if (!perfActive()) seedVaultSkills(vaultId);
			if (isTauri() && !isRemoteVaultHandle(vaultId)) {
				// Establish the Host scope before later handlers activate plugins.
				await callApi(() => commands.vaultHold(vaultId), {
					fallback: "vault hold failed",
				}).catch((e: unknown) => {
					logger.warn("vault hold failed", { error: errorText(e) });
				});
			}
			if (isTauri() && !perfActive() && !isRemoteVaultHandle(vaultId)) {
				void maybeShowPaperBackfill(vaultId);
			}
			if (isTauri() && !perfActive() && !isRemoteVaultHandle(vaultId)) {
				// Auto-ingest: adopt bare papers/ folders created while the app
				// was closed; the FS watcher only covers the live session.
				void callApiResult(
					() => commands.paperIngestReconcile({ vaultPath: vaultId }),
					{ fallback: "paper ingest reconcile failed" },
				).catch(() => undefined);
			}
			if (isTauri() && !perfActive() && !isRemoteVaultHandle(vaultId)) {
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
				dismissPaperBackfill(vaultId);
				clearLibraryVaultState();
				clearWikiVaultState();
				clearAgentVaultState();
				closeZenWorkspace();
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
		lifecycle.on("paper:imported", ({ vaultId, paperId, path }) => {
			// `app.emit` broadcasts to every window; only react to the active vault.
			if (vaultId !== getVaultPath()) return;
			// The catalog row is already committed. Hold the list refresh and a
			// path-scoped wiki update until this import wave, including
			// recognition renames, goes idle. `path` is the real folder
			// (`papers/nlp/<id>`), not `papers/` plus the basename.
			const rel = path?.trim();
			const folder = rel ? rel : paperId ? `papers/${paperId}` : "";
			if (folder) {
				const abs = joinVaultPath(vaultId, folder);
				noteCommittedPaths([abs]);
				void syncRenamedPaperTabs(vaultId, abs);
			} else {
				noteCommittedLibraryList();
				scheduleTreeRefresh();
			}
		}),
		lifecycle.on("paper:assets-ready", ({ vaultId, paperId, path }) => {
			if (vaultId !== getVaultPath()) return;
			const folder = path?.trim() || (paperId ? `papers/${paperId}` : "");
			// Re-list the parent so the paper row's hasTex/needsSource flags
			// are replaced too; refreshing only source/ leaves them stale.
			scheduleTreeRefresh(
				folder ? [joinVaultPath(vaultId, folder)] : undefined,
			);
			noteCommittedLibraryList();
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
				void syncRenamedPaperTabs(vaultId, toAbs);
			}
			noteCommittedRename(fromAbs, toAbs);
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
		unregisterSuggestions();
		for (const off of offs) off();
		registerExternalLibraryReconciler(null);
	};
}
