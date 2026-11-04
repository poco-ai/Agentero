import { createElement } from "react";
import { toast } from "sonner";
import { BackfillPrompt } from "@/components/paper/backfill-prompt";
import i18n from "@/i18n";
import { type BackfillPreview, commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";

const deferred = new Set<string>();
const generations = new Map<string, number>();
let promptSequence = 0;
const toastId = (vaultPath: string) => `paper-backfill:${vaultPath}`;

export function checkPaperBackfill(
	vaultPath: string,
): Promise<BackfillPreview> {
	return callApiResult(() => commands.jobBackfillPreview({ vaultPath }));
}

export function dismissPaperBackfill(vaultPath: string): void {
	generations.set(vaultPath, (generations.get(vaultPath) ?? 0) + 1);
	toast.dismiss(toastId(vaultPath));
}

function showPaperBackfill(vaultPath: string, preview: BackfillPreview): void {
	if (!preview.downloadSource && !preview.parseBody) return;
	const key = ++promptSequence;
	toast.custom(
		() =>
			createElement(BackfillPrompt, {
				key,
				preview,
				onLater: () => {
					deferred.add(vaultPath);
					toast.dismiss(toastId(vaultPath));
				},
				onStart: async (paths) => {
					await enqueuePaperBackfill(vaultPath, paths);
					toast.dismiss(toastId(vaultPath));
				},
			}),
		{
			id: toastId(vaultPath),
			duration: Number.POSITIVE_INFINITY,
			dismissible: false,
			style: { width: "min(26rem, calc(100vw - 1.5rem))" },
		},
	);
}

export async function enqueuePaperBackfill(
	vaultPath: string,
	paths: string[],
): Promise<number> {
	const count = await callApiResult(() =>
		commands.jobBackfillEnqueue({ vaultPath, paths }),
	);
	notifySuccess(i18n.t("settings:doctor.backfill.queued", { count }));
	return count;
}

/** Check each activation; only an explicit Later suppresses this session. */
export async function maybeShowPaperBackfill(vaultPath: string): Promise<void> {
	if (deferred.has(vaultPath)) return;
	const generation = (generations.get(vaultPath) ?? 0) + 1;
	generations.set(vaultPath, generation);
	try {
		const preview = await checkPaperBackfill(vaultPath);
		if (generations.get(vaultPath) === generation)
			showPaperBackfill(vaultPath, preview);
	} catch (error) {
		if (generations.get(vaultPath) === generation)
			notifyError(errorText(error));
	}
}
