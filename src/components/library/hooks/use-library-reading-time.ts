import { useEffect, useState } from "react";
import {
	loadReadingDurations,
	subscribeUsageCleared,
} from "@/lib/activity/api";
import {
	flushActivity,
	subscribeReadingDurationChanges,
} from "@/lib/activity/track";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import type { PaperMetadata } from "@/lib/paper";

/** One vault-wide aggregate supplies sorting and bars for all filtered library rows. */
export function useLibraryReadingTime(
	vaultPath: string | null,
	active: boolean,
	papers: readonly Pick<PaperMetadata, "path">[],
) {
	const [loaded, setLoaded] = useState<{
		vault: string | null;
		totals: Record<string, number>;
	}>({ vault: null, totals: {} });

	useEffect(() => {
		if (!active || !vaultPath || !papers.length) return;
		let cancelled = false;
		let request = 0;
		const refresh = async () => {
			if (cancelled) return;
			const current = ++request;
			try {
				const totals = await loadReadingDurations(vaultPath);
				if (!cancelled && current === request) {
					setLoaded({ vault: vaultPath, totals });
				}
			} catch (error) {
				logger.warn("library reading duration load failed", {
					error: errorText(error),
				});
			}
		};
		const unsubscribe = subscribeReadingDurationChanges(() => {
			void refresh();
		});
		const unsubscribeClear = subscribeUsageCleared((vault) => {
			if (vault === null || vault === vaultPath) void refresh();
		});
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		// The paper blur can still be buffered when the library first becomes active.
		void flushActivity().then(() => {
			if (!cancelled) void refresh();
		});
		return () => {
			cancelled = true;
			unsubscribe();
			unsubscribeClear();
			window.removeEventListener("focus", onFocus);
		};
	}, [vaultPath, active, papers]);

	return loaded.vault === vaultPath ? loaded.totals : null;
}
