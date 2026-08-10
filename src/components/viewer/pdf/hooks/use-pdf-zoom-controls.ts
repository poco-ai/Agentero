/**
 * Zoom percentage field for the toolbar.
 *
 * Split out because the input is a controlled mirror of plugin state with its
 * own focus/cancel rules: while the field is focused the observed zoom must not
 * overwrite what the user is typing, and Escape restores the last committed
 * value instead of committing a half-typed one.
 */

import type { useZoom } from "@embedpdf/plugin-zoom/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	formatPdfZoomPercentage,
	parsePdfZoomPercentage,
} from "@/lib/pdf/zoom";

type ZoomCapability = ReturnType<typeof useZoom>["provides"];

export type PdfZoomControls = {
	/** Toolbar input value (percent text, not a number). */
	zoomField: string;
	setZoomField: (value: string) => void;
	/** True while the input has focus; blocks the observed-zoom sync. */
	zoomFieldFocusedRef: RefObject<boolean>;
	/** Escape sets this so blur restores instead of committing. */
	zoomFieldCancelRef: RefObject<boolean>;
	/** Latest observed zoom, for render paths that must not re-run on change. */
	zoomRef: RefObject<number>;
	/** Parse and apply the typed percentage (falls back to the current zoom). */
	commitZoomField: (value: string) => void;
};

export function usePdfZoomControls(
	zoom: ZoomCapability,
	zoomLevel: number,
): PdfZoomControls {
	const [zoomField, setZoomField] = useState(() =>
		formatPdfZoomPercentage(zoomLevel),
	);
	const zoomRef = useRef(zoomLevel);
	zoomRef.current = zoomLevel;
	const zoomFieldFocusedRef = useRef(false);
	const zoomFieldCancelRef = useRef(false);

	useEffect(() => {
		if (!zoomFieldFocusedRef.current) {
			setZoomField(formatPdfZoomPercentage(zoomLevel));
		}
	}, [zoomLevel]);

	const commitZoomField = useCallback(
		(value: string) => {
			const requested = parsePdfZoomPercentage(value);
			if (requested == null) {
				setZoomField(formatPdfZoomPercentage(zoomLevel));
				return;
			}
			zoom?.requestZoom(requested);
			setZoomField(formatPdfZoomPercentage(requested));
		},
		[zoom, zoomLevel],
	);

	return {
		zoomField,
		setZoomField,
		zoomFieldFocusedRef,
		zoomFieldCancelRef,
		zoomRef,
		commitZoomField,
	};
}
