/**
 * Hover state for PDF external links (annotation URI / Launch, and plain-text
 * http(s) / arXiv URLs): the target URL plus its screen anchor. Native `title`
 * tooltips truncate long addresses, so `PdfLinkPreviewCard` renders the full
 * URL — or, when the target is previewable, a compact page / image preview —
 * in a card that stays open when the pointer moves onto it.
 */

import { useCallback, useState } from "react";
import { EPHEMERAL_PREVIEW_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import { useStickyHoverHide } from "@/components/viewer/pdf/hooks/use-sticky-hover-hide";
import type { ScreenPoint } from "@/components/viewer/pdf/types";

export type LinkUrlTipState = {
	url: string;
	screen: ScreenPoint;
};

export function usePdfLinkUrlTip() {
	const [linkUrlTip, setLinkUrlTip] = useState<LinkUrlTipState | null>(null);
	const hide = useCallback(() => setLinkUrlTip(null), []);
	const {
		cancelHide,
		markHoverEnter: markLinkUrlHoverEnter,
		scheduleHide: scheduleLinkUrlHide,
	} = useStickyHoverHide({
		delayMs: EPHEMERAL_PREVIEW_HIDE_MS,
		hide,
	});

	const clearLinkUrlTip = useCallback(() => {
		cancelHide();
		setLinkUrlTip(null);
	}, [cancelHide]);

	const handleLinkUrlHover = useCallback(
		(url: string | null, clientPoint?: ScreenPoint | null) => {
			const trimmed = url?.trim() ?? "";
			if (!trimmed || !clientPoint) {
				scheduleLinkUrlHide();
				return;
			}
			cancelHide();
			setLinkUrlTip({ url: trimmed, screen: clientPoint });
		},
		[cancelHide, scheduleLinkUrlHide],
	);

	return {
		linkUrlTip,
		scheduleLinkUrlHide,
		markLinkUrlHoverEnter,
		clearLinkUrlTip,
		handleLinkUrlHover,
	};
}
