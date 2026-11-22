import i18n from "@/i18n";
import { commands, type OpenReviewPdfIssue } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callResult } from "@/lib/core/ipc";
import { notifyError, notifyReminder } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { basenameOf } from "@/lib/core/path";
import { enqueueTaskSettled, JobFailedError } from "@/lib/core/tasks";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";

const verifying = new Set<string>();

const issues = [
	"verificationRequired",
	"rateLimited",
	"network",
	"unavailable",
	"downloadFailed",
] as const satisfies readonly OpenReviewPdfIssue[];

export function openReviewPdfIssue(
	phase?: string | null,
): OpenReviewPdfIssue | undefined {
	return issues.find((issue) => issue === phase);
}

export function isOpenReviewDownloadFailure(error: unknown): boolean {
	return (
		error instanceof JobFailedError &&
		error.job.kind === "downloadAssets" &&
		openReviewPdfIssue(error.job.phase) !== undefined
	);
}

async function openPaperInBrowser(
	vaultPath: string,
	path: string,
): Promise<void> {
	const meta = await loadPaperMetadata(
		joinVaultPath(vaultPath, path),
		vaultPath,
	);
	for (const value of [
		meta?.source_url,
		meta?.openreview_url,
		meta?.html_url,
		meta?.pdf_url,
	]) {
		if (!value) continue;
		try {
			const url = new URL(value);
			if (url.protocol !== "https:") continue;
			if (url.hostname === "openreview.net") {
				openExternalUrl(url.href);
				return;
			}
			const id = url.searchParams.get("id");
			if (id && url.hostname.endsWith(".openreview.net")) {
				const forum = new URL("https://openreview.net/forum");
				forum.searchParams.set("id", id);
				openExternalUrl(forum.href);
				return;
			}
		} catch {}
	}
	notifyError(i18n.t("app:openreviewDownload.missingBrowserLink"));
}

export function notifyOpenReviewDownloadIssue(
	vaultPath: string,
	path: string,
	issue: OpenReviewPdfIssue,
): void {
	const id = `openreview:${vaultPath}:${path}`;
	const verify = async () => {
		if (getVaultPath() !== vaultPath || verifying.has(id)) return;
		verifying.add(id);
		try {
			const { verified, url } = await callResult(() =>
				commands.paperVerifyOpenreviewPdf(vaultPath, path),
			);
			if (getVaultPath() !== vaultPath) return;
			if (verified) {
				try {
					await enqueueTaskSettled({ kind: "downloadAssets", vaultPath, path });
					return;
				} catch (error) {
					if (!isOpenReviewDownloadFailure(error)) throw error;
					if (
						!(error instanceof JobFailedError) ||
						error.job.phase !== "verificationRequired"
					)
						return;
				}
			}
			notifyReminder(i18n.t("app:openreviewDownload.verificationIncomplete"), {
				id,
				description: i18n.t("app:openreviewDownload.attachDownloadedPdf"),
				actionLabel: i18n.t("app:openreviewDownload.verifyAndDownload"),
				onAction: () => void verify(),
				dismissLabel: i18n.t("app:openreviewDownload.openInBrowser"),
				onDismiss: () => openExternalUrl(url),
			});
		} catch (error) {
			notifyError(errorText(error), { id });
		} finally {
			verifying.delete(id);
		}
	};
	const retry = async () => {
		if (getVaultPath() !== vaultPath || verifying.has(id)) return;
		verifying.add(id);
		try {
			await enqueueTaskSettled({ kind: "downloadAssets", vaultPath, path });
		} catch (error) {
			if (!isOpenReviewDownloadFailure(error))
				notifyError(errorText(error), { id });
		} finally {
			verifying.delete(id);
		}
	};
	const needsVerification = issue === "verificationRequired";
	notifyReminder(i18n.t(`app:openreviewDownload.${issue}`), {
		id,
		description: needsVerification
			? i18n.t("app:openreviewDownload.signInHint", { paper: basenameOf(path) })
			: basenameOf(path),
		actionLabel: needsVerification
			? i18n.t("app:openreviewDownload.verifyAndDownload")
			: i18n.t("common:tryAgain"),
		onAction: () => void (needsVerification ? verify() : retry()),
		dismissLabel: needsVerification
			? i18n.t("app:openreviewDownload.openSettings")
			: i18n.t("app:openreviewDownload.openInBrowser"),
		onDismiss: () => {
			if (needsVerification) openSettingsWindow("general");
			else void openPaperInBrowser(vaultPath, path);
		},
	});
}
