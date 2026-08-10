/**
 * Bulk (whole-document) translation of body-text layout regions.
 *
 * Its own hook because it shares nothing with hover or with the analysis run
 * beyond the region list it reads: one abortable job, progressive overlay items,
 * and the toolbar button's three-phase label (start → stop → clear).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "@/lib/core/notify";
import {
	groupLayoutTranslateItemsByPage,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	listTranslatableLayoutRegions,
	type PdfLayoutRegion,
	runLayoutRegionTranslate,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";

export type UsePdfLayoutTranslateOptions = {
	docId: string;
	/** Pre-merge regions from {@link usePdfLayoutRegions}; the translate source. */
	layoutRawRegions: PdfLayoutRegion[] | null;
};

export type PdfLayoutTranslate = {
	/** Progressive bulk-translate overlays (body text / abstract / header), bucketed by page. */
	layoutTranslateItemsByPage: ReadonlyMap<
		number,
		readonly LayoutTranslateItem[]
	>;
	layoutTranslateRunning: boolean;
	/** Running, or finished with overlays still painted. */
	layoutTranslateActive: boolean;
	/** Toolbar button label for the current job phase. */
	layoutTranslateLabel: string;
	/** Toolbar button: start → stop → clear → start. */
	toggleLayoutTranslate: () => void;
};

export function usePdfLayoutTranslate({
	docId,
	layoutRawRegions,
}: UsePdfLayoutTranslateOptions): PdfLayoutTranslate {
	const { t } = useTranslation("viewer");
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [layoutTranslateJob, setLayoutTranslateJob] = useState<{
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	}>({ status: "idle", items: [] });
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);

	const stopLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob((prev) =>
			prev.status === "running" ? { ...prev, status: "cancelled" } : prev,
		);
	}, []);

	const clearLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob({ status: "idle", items: [] });
	}, []);

	const startLayoutTranslate = useCallback(() => {
		const raw = layoutRawRegions;
		if (!raw?.length) {
			notifyError(t("pdf.layoutTranslate.needLayout"));
			return;
		}
		const regions = listTranslatableLayoutRegions(raw);
		if (regions.length === 0) {
			notifyError(t("pdf.layoutTranslate.noText"));
			return;
		}
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		const items = toLayoutTranslateItems(regions);
		setLayoutTranslateJob({ status: "running", items });
		void runLayoutRegionTranslate({
			items,
			signal: ac.signal,
			onUpdate: (next) => {
				if (ac.signal.aborted) return;
				setLayoutTranslateJob((prev) => ({
					status: prev.status === "cancelled" ? "cancelled" : "running",
					items: next,
				}));
			},
		})
			.then((finalItems) => {
				if (ac.signal.aborted) {
					setLayoutTranslateJob({ status: "cancelled", items: finalItems });
					return;
				}
				setLayoutTranslateJob({ status: "done", items: finalItems });
			})
			.catch((e) => {
				if (ac.signal.aborted) return;
				const message = e instanceof Error ? e.message : String(e);
				notifyError(t("pdf.layoutTranslate.failed"), { description: message });
				setLayoutTranslateJob((prev) => ({
					status: "done",
					items: prev.items,
				}));
			})
			.finally(() => {
				if (layoutTranslateAbortRef.current === ac) {
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [layoutRawRegions, t]);

	const toggleLayoutTranslate = useCallback(() => {
		if (layoutTranslateJob.status === "running") {
			stopLayoutTranslate();
			return;
		}
		if (
			layoutTranslateJob.status === "done" ||
			layoutTranslateJob.status === "cancelled"
		) {
			// Second click clears overlays; third starts again from the button.
			if (layoutTranslateJob.items.some((it) => it.translated)) {
				clearLayoutTranslate();
				return;
			}
		}
		startLayoutTranslate();
	}, [
		layoutTranslateJob,
		startLayoutTranslate,
		stopLayoutTranslate,
		clearLayoutTranslate,
	]);

	// Abort bulk translate when switching documents.
	useEffect(() => {
		if (!docId) return;
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob({ status: "idle", items: [] });
		return () => {
			layoutTranslateAbortRef.current?.abort();
		};
	}, [docId]);

	// Bucket once per job update (not per page); unchanged buckets keep their
	// previous array identity so memoized page overlays bail out while another
	// page streams.
	const layoutTranslateByPageRef = useRef<
		ReadonlyMap<number, readonly LayoutTranslateItem[]>
	>(new Map());
	const layoutTranslateItemsByPage = useMemo(() => {
		const grouped = groupLayoutTranslateItemsByPage(
			layoutTranslateJob.items,
			layoutTranslateByPageRef.current,
		);
		layoutTranslateByPageRef.current = grouped;
		return grouped;
	}, [layoutTranslateJob.items]);

	const layoutTranslateRunning = layoutTranslateJob.status === "running";
	const layoutTranslateActive =
		layoutTranslateRunning ||
		layoutTranslateJob.items.some((it) => it.translated);
	const layoutTranslateLabel = layoutTranslateRunning
		? t("pdf.layoutTranslate.stop")
		: layoutTranslateActive
			? t("pdf.layoutTranslate.clear")
			: t("pdf.layoutTranslate.start");

	return {
		layoutTranslateItemsByPage,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
	};
}
