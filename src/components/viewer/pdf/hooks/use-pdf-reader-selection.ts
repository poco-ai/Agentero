import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { anchorFromEmbedSelection } from "@/components/viewer/pdf/coords";
import type { UsePdfTranslationSelectionOptions } from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import { locatePdfSelectionPages } from "@/components/viewer/pdf/selection-geometry";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import {
	selectionFocusRect,
	selectionSideFromSelection,
} from "@/lib/agent/selection-side";
import { publishSelection } from "@/lib/agent/selection-store";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { holdLinkPreviewDrag } from "@/lib/pdf/link-preview-drag";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import { readerSelectionFromRange } from "@/lib/pdf/reading/selection";
import { loadSettings } from "@/lib/settings/store";
import { langsFromSettings } from "@/lib/translate/lang";

type Options = Pick<
	UsePdfTranslationSelectionOptions,
	| "enabled"
	| "hostRef"
	| "engineRef"
	| "docCapRef"
	| "docId"
	| "setSelectionMenu"
	| "closeSelectionMenu"
	| "paperAbsPath"
	| "paperRelPath"
> & {
	blocks: readonly ReadingBlock[];
};

/** Native range → shared PDF actions, with original geometry for persistence. */
export function usePdfReaderSelection(options: Options): void {
	const { enabled, hostRef, docId } = options;
	const latest = useRef(options);
	latest.current = options;
	const { i18n } = useTranslation();
	const langRef = useRef(i18n.language);
	langRef.current = i18n.language;
	useEffect(() => {
		if (!enabled) return;
		const host = hostRef.current;
		if (!host) return;
		let cancelled = false,
			epoch = 0,
			dragging = false,
			frame = 0;
		let release: (() => void) | null = null;
		const releaseDrag = () => {
			release?.();
			release = null;
		};
		const currentRange = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount)
				return null;
			const range = selection.getRangeAt(0);
			const inside = (node: Node) => {
				const el = node instanceof Element ? node : node.parentElement;
				return (
					!!el &&
					host.contains(el) &&
					!!el.closest("[data-pdf-reader]") &&
					!el.closest("[data-pdf-chrome]")
				);
			};
			return inside(range.startContainer) && inside(range.endContainer)
				? range
				: null;
		};
		const commit = async () => {
			const range = currentRange();
			if (!range) {
				releaseDrag();
				return;
			}
			const generation = ++epoch;
			const alive = () => !cancelled && epoch === generation;
			const opts = latest.current;
			const language = langsFromSettings(
				loadSettings().translate,
				langRef.current ?? "en",
			).targetLang;
			const resolved = readerSelectionFromRange(
				range,
				host,
				opts.blocks,
				language,
			);
			if (!resolved) {
				releaseDrag();
				return;
			}
			const snapshot = range.cloneRange();
			try {
				const pages = await locatePdfSelectionPages(
					opts.engineRef.current,
					opts.docCapRef.current,
					docId,
					resolved,
					alive,
				);
				const live = currentRange();
				if (
					!alive() ||
					!pages ||
					!live ||
					live.compareBoundaryPoints(Range.START_TO_START, snapshot) !== 0 ||
					live.compareBoundaryPoints(Range.END_TO_END, snapshot) !== 0
				)
					return;
				const doc = opts.docCapRef.current?.getDocument(docId);
				const pageIndex = resolved.pages.at(-1)?.pageIndex;
				if (pageIndex == null) return;
				const anchor = anchorFromEmbedSelection(
					pages,
					resolved.quote,
					(index) => doc?.pages[index]?.size ?? null,
					"selection",
					pageIndex,
				) ?? {
					page: pageIndex + 1,
					rects: [],
					quote: resolved.quote,
					trigger: "selection" as const,
				};
				const selection = window.getSelection();
				const focus =
					selectionFocusRect(selection) ?? live.getBoundingClientRect();
				if (!focus.height) return;
				const menu: SelectionMenuState = {
					screen: {
						x: focus.left + focus.width / 2,
						y: focus.bottom,
						top: focus.top,
						bottom: focus.bottom,
						cursorX: focus.left,
						side: selectionSideFromSelection(selection),
					},
					anchor,
					pages,
					copyText: resolved.copyText,
					fromTranslation: resolved.fromTranslation,
					fromReader: { blockId: resolved.blockId },
					pairedTranslation: resolved.paired || undefined,
				};
				opts.setSelectionMenu(menu);
				publishSelection({
					text: resolved.quote,
					sourcePath: opts.paperRelPath ?? opts.paperAbsPath ?? "PDF",
					origin: "pdf",
					page: anchor.page,
					rects: anchor.rects,
					paperAbsPath: opts.paperAbsPath ?? undefined,
					context: resolved.paired
						? { status: "unavailable", translation: resolved.paired }
						: undefined,
				});
			} catch (error) {
				if (alive()) notifyError(errorText(error));
			} finally {
				if (alive()) releaseDrag();
			}
		};
		const schedule = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (!dragging) void commit();
			});
		};
		const down = (event: PointerEvent) => {
			if (
				event.button !== 0 ||
				!(event.target instanceof Element) ||
				!event.target.closest("[data-pdf-reader]") ||
				event.target.closest("[data-pdf-chrome],button,input,textarea")
			)
				return;
			epoch++;
			dragging = true;
			releaseDrag();
			release = holdLinkPreviewDrag();
		};
		const up = () => {
			if (!dragging) return;
			dragging = false;
			schedule();
		};
		const changed = () => {
			if (!dragging && currentRange()) schedule();
		};
		// Reader scrolling invalidates a screen anchor, but preserves native copy.
		const scrolled = (event: Event) => {
			if (
				event.target instanceof Element &&
				event.target.matches("[data-pdf-reader]")
			) {
				epoch++;
				releaseDrag();
				latest.current.setSelectionMenu(null);
			}
		};
		host.addEventListener("pointerdown", down);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		document.addEventListener("selectionchange", changed);
		host.addEventListener("scroll", scrolled, true);
		return () => {
			cancelled = true;
			epoch++;
			if (frame) cancelAnimationFrame(frame);
			releaseDrag();
			host.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			document.removeEventListener("selectionchange", changed);
			host.removeEventListener("scroll", scrolled, true);
		};
	}, [enabled, hostRef, docId]);
}
