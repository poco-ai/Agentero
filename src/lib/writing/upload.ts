/**
 * Push one writing project to its GitHub repository. The toolbar, the upload
 * tab, and the automatic schedule share this runner.
 */

import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import type { WritingGitHubLink } from "@/lib/writing/github";
import { syncWritingProject } from "@/lib/writing/sync";

let autoSyncPaused = false;

/** A failed automatic upload waits for a manual upload before resuming. */
export function resumeWritingAutoSync(): void {
	autoSyncPaused = false;
}

export function isWritingAutoSyncPaused(): boolean {
	return autoSyncPaused;
}

/**
 * `project` is the vault-relative project folder (`thesis/<name>`), which is
 * also the repository root.
 */
export async function uploadWritingProject(
	project: string,
	link: WritingGitHubLink,
	quiet = false,
): Promise<void> {
	if (quiet && autoSyncPaused) return;
	const vault = getVaultPath();
	const projectDir = vault ? joinVaultPath(vault, project) : "";
	if (!projectDir) {
		if (!quiet) notifyError(i18n.t("sidebar:writing.syncMissing"));
		return;
	}
	try {
		const report = await syncWritingProject(
			projectDir,
			link.remote,
			link.branch,
		);
		const stop = () => {
			if (quiet) autoSyncPaused = true;
		};
		if (report.code === "git_missing") {
			stop();
			notifyError(i18n.t("sidebar:writing.syncNoGit"));
			return;
		}
		if (report.code === "auth") {
			stop();
			notifyError(i18n.t("sidebar:writing.syncAuth"), {
				description: report.detail || undefined,
			});
			return;
		}
		if (report.code === "conflict") {
			stop();
			notifyError(i18n.t("sidebar:writing.syncConflict"), {
				description: report.detail || undefined,
			});
			return;
		}
		if (report.code === "missing") {
			stop();
			if (!quiet) notifyError(i18n.t("sidebar:writing.syncMissing"));
			return;
		}
		if (report.code === "clean") {
			if (!quiet) notifySuccess(i18n.t("sidebar:writing.syncClean"));
			return;
		}
		if (report.code === "pulled") {
			notifySuccess(i18n.t("sidebar:writing.syncPulled"));
			return;
		}
		if (report.code === "pushed") {
			if (!quiet) {
				notifySuccess(i18n.t("sidebar:writing.syncPushed"), {
					description: link.label,
				});
			}
			return;
		}
		stop();
		notifyError(i18n.t("sidebar:writing.syncFailed"), {
			description: report.detail || undefined,
		});
	} catch (error) {
		if (quiet) autoSyncPaused = true;
		notifyError(errorText(error) || i18n.t("sidebar:writing.syncFailed"));
	}
}
