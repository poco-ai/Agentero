/**
 * Retry orchestration for PDF layout translation. Extraction and transport
 * splitting live in the core runner so all entrypoints preserve the same
 * source text, styles and sentence anchors.
 */
import { errorText } from "@/lib/core/error";
import { runLayoutRegionTranslate as runCoreLayoutRegionTranslate } from "@/lib/pdf/layout/layout-translate";
import { splitTranslationChunks } from "@/lib/pdf/layout/translation-chunks";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

export {
	applyLayoutTranslateSidecar,
	countPendingLayoutTranslateItems,
	currentLayoutTranslateCacheKey,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	hydrateLayoutTranslateItems,
	type LayoutTranslateCacheHydration,
	type LayoutTranslateCacheKey,
	layoutTranslatePendingPageRange,
	listTranslatableLayoutRegions,
	persistLayoutTranslateSidecarBestEffort,
	readLayoutTranslateSidecar,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
export type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

export const LAYOUT_TRANSLATE_MAX_CHARS = 2200;
const LAYOUT_TRANSLATE_RETRY_ROUNDS = 2;

/** Compatibility helper; core transport splits protected text after masking. */
export function splitLongLayoutTranslateSource(
	text: string,
	maxChars = LAYOUT_TRANSLATE_MAX_CHARS,
): string[] {
	return splitTranslationChunks(text.trim(), maxChars)
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Whether this item produces painted overlay content.
 *
 * LayoutTranslateOverlay paints done, running, or partially translated error
 * items. Pending items and clean failures leave the page's original PDF visible.
 */
export function isLayoutTranslateItemPainted(
	item: Pick<LayoutTranslateItem, "status" | "translated">,
): boolean {
	return (
		item.status === "done" ||
		item.status === "running" ||
		(item.status === "error" && Boolean(item.translated))
	);
}

/** Which blocks the current job is measuring progress over. */
export type LayoutTranslateRunScope = "initial" | "pending" | "all";

/** A finished job can now explicitly report that some blocks still need work. */
export type LayoutTranslateJobStatus =
	| "idle"
	/** Layout regions not parsed yet; the job auto-starts once they land. */
	| "waitingLayout"
	| "running"
	| "done"
	| "partial"
	| "cancelled";

function mergePass(
	current: readonly LayoutTranslateItem[],
	updates: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	const byId = new Map(updates.map((item) => [item.id, item]));
	return current.map((item) => {
		const update = byId.get(item.id);
		return update ? { ...item, ...update } : { ...item };
	});
}

/** Retry terminal errors individually without changing paragraph identity. */
export async function runLayoutRegionTranslate(options: {
	items: LayoutTranslateItem[];
	signal?: AbortSignal;
	concurrency?: number;
	onUpdate: (items: LayoutTranslateItem[]) => void;
	paperKey?: string | null;
	vaultPath?: string | null;
}): Promise<LayoutTranslateItem[]> {
	let items = options.items.map((item) => ({ ...item }));
	const publish = () => options.onUpdate(items.map((item) => ({ ...item })));

	const runPass = async (
		seed: LayoutTranslateItem[],
		concurrency: number | undefined,
	): Promise<LayoutTranslateItem[]> => {
		const result = await runCoreLayoutRegionTranslate({
			items: seed.map((item) => ({ ...item })),
			signal: options.signal,
			concurrency,
			paperKey: options.paperKey,
			vaultPath: options.vaultPath,
			onUpdate: (next) => {
				items = mergePass(items, next);
				publish();
			},
		});
		return result;
	};

	try {
		const first = await runPass(items, options.concurrency);
		items = mergePass(items, first);
	} catch (error) {
		if (options.signal?.aborted) return items.map((item) => ({ ...item }));
		// Resolver/session setup can fail before the legacy runner paints item
		// errors. Mark the current pending set so the hook reports partial, not done.
		items = items.map((item) =>
			item.status === "done"
				? item
				: { ...item, status: "error", error: errorText(error) },
		);
		publish();
		return items.map((item) => ({ ...item }));
	}

	for (let round = 0; round < LAYOUT_TRANSLATE_RETRY_ROUNDS; round++) {
		if (options.signal?.aborted) break;
		const failed = items
			.filter((item) => item.status === "error")
			.map((item) => ({
				...item,
				status: "pending" as const,
				translated: undefined,
				sentences: undefined,
				error: undefined,
			}));
		if (failed.length === 0) break;
		// Retry failures as individual units. This is intentionally serialized:
		// it avoids repeating the same rate-limit/batch failure pattern.
		for (const item of failed) {
			if (options.signal?.aborted) break;
			try {
				const retried = await runPass([item], 1);
				items = mergePass(items, retried);
			} catch (error) {
				items = items.map((current) =>
					current.id === item.id
						? { ...current, status: "error", error: errorText(error) }
						: current,
				);
			}
			publish();
		}
	}

	return items.map((item) => ({ ...item }));
}
