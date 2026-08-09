"use client";

import { RangeApi } from "platejs";
import type { PlateEditor } from "platejs/react";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";

const PUBLISH_DEBOUNCE_MS = 300;

/**
 * Mirror the live text selection into the Agent composer as an ephemeral
 * context chip. Debounced because dragging a selection fires continuously;
 * a collapsed selection clears the chip instead of publishing an empty one.
 *
 * Returns the scheduler to call whenever the selection may have moved.
 */
export function useSelectionContextPublish({
	editor,
	filePathRef,
}: {
	editor: PlateEditor;
	filePathRef: RefObject<string | null>;
}): () => void {
	const timerRef = useRef<number | null>(null);

	const schedule = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
		}
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			const selection = editor.selection;
			if (!selection || RangeApi.isCollapsed(selection)) {
				clearActiveSelection("markdown");
				return;
			}
			const path = filePathRef.current;
			if (!path) return;
			publishSelection({
				text: editor.api.string(selection),
				sourcePath: path,
				origin: "markdown",
			});
		}, PUBLISH_DEBOUNCE_MS);
	}, [editor, filePathRef]);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
			}
			clearActiveSelection("markdown");
		};
	}, []);

	return schedule;
}
