import { toast } from "sonner";
import i18n from "@/i18n";
import { type BackfillPreview, commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";

const deferred = new Set<string>();
const generations = new Map<string, number>();
const toastId = (vaultPath: string) => `paper-backfill:${vaultPath}`;

export type BackfillPromptRequest = {
	preview: BackfillPreview;
	/** Sonner toast id; also honored by `dismissPaperBackfill`. */
	toastId: string;
	onLater: () => void;
	onStart: (paths: string[]) => Promise<void>;
};

/**
 * Registered by the main window (`usePaperBackfillPrompt`) to render the
 * prompt UI. Kept as a setter so this module stays component-free
 * (`lib-no-components`), mirroring `setNetworkFailureReporter`.
 */
let presenter: ((request: BackfillPromptRequest) => void) | null = null;

export function setBackfillPromptPresenter(
	fn: ((request: BackfillPromptRequest) => void) | null,
): void {
	presenter = fn;
}

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
	presenter?.({
		preview,
		toastId: toastId(vaultPath),
		onLater: () => {
			deferred.add(vaultPath);
			toast.dismiss(toastId(vaultPath));
		},
		onStart: async (paths) => {
			await enqueuePaperBackfill(vaultPath, paths);
			toast.dismiss(toastId(vaultPath));
		},
	});
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
