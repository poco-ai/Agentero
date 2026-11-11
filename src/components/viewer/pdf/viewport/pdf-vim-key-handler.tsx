import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { type RefObject, useEffect, useRef } from "react";
import { useSettings } from "@/hooks/use-app-stores";
import { PdfKeySequence } from "@/lib/keyboard/pdf-key-sequence";
import { ownsPdfKeyboard } from "@/lib/pdf/keyboard-ownership";
import { handleScrollSyncIntent } from "@/lib/pdf/scroll-sync";
import { loadSettings } from "@/lib/settings";

type PdfVimKeyHandlerProps = {
	documentId: string;
	active: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	totalPages?: number;
	onFindNext?: () => void;
	onFindPrev?: () => void;
};

/** Local, opt-in Vim navigation for the active PDF surface. */
export function PdfVimKeyHandler({
	documentId,
	active,
	hostRef,
	totalPages = 0,
	onFindNext,
	onFindPrev,
}: PdfVimKeyHandlerProps) {
	const strategy = useSettings((s) => s.pdfScrollStrategy);
	const viewportRef = useViewportElement();
	const { provides: scrollCapability } = useScrollCapability();
	const activeRef = useRef(active);
	activeRef.current = active;
	const strategyRef = useRef(strategy);
	strategyRef.current = strategy;
	const scrollRef = useRef(scrollCapability);
	scrollRef.current = scrollCapability;
	const findNextRef = useRef(onFindNext);
	findNextRef.current = onFindNext;
	const findPrevRef = useRef(onFindPrev);
	findPrevRef.current = onFindPrev;

	useEffect(() => {
		const viewport = viewportRef?.current;
		if (!viewport) return;
		const sequence = new PdfKeySequence();
		const clearPrefix = () => sequence.reset();
		const page = (direction: number) => {
			const scope = scrollRef.current?.forDocument(documentId);
			if (!scope) return;
			handleScrollSyncIntent(documentId);
			if (direction > 0) scope.scrollToNextPage("instant");
			else scope.scrollToPreviousPage("instant");
		};
		const onKeyDown = (event: KeyboardEvent) => {
			// Selection actions win even when this capture listener was mounted first.
			const selectionAction =
				!event.shiftKey &&
				Array.from(
					document.querySelectorAll<HTMLButtonElement>(
						"[data-selection-menu] button[aria-keyshortcuts]:not(:disabled)",
					),
				).some(
					(button) =>
						button.getAttribute("aria-keyshortcuts")?.toLowerCase() ===
						event.key.toLowerCase(),
				);
			// Read the module cache so a settings window toggle applies even
			// before this component re-renders.
			const { pdfVimKeys, vimMode } = loadSettings();
			if (
				!pdfVimKeys ||
				!vimMode ||
				selectionAction ||
				event.defaultPrevented ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.isComposing ||
				!ownsPdfKeyboard({
					target: event.target,
					host: hostRef.current,
					active: activeRef.current,
				})
			) {
				clearPrefix();
				return;
			}
			const scope = scrollRef.current?.forDocument(documentId);
			if (!scope) return;
			const key = event.key;
			if (event.repeat && (key === "g" || key === "G" || /^\d$/.test(key)))
				return;
			const parsed = sequence.feed(key, Date.now());
			if (parsed.consumed) {
				event.preventDefault();
				if (parsed.page === undefined) return;
				handleScrollSyncIntent(documentId);
				const total = totalPages || 1;
				scope.scrollToPage({
					pageNumber: Math.max(
						1,
						Math.min(parsed.page === "last" ? total : parsed.page, total),
					),
					behavior: "instant",
				});
				return;
			}
			if (key === "n") {
				event.preventDefault();
				findNextRef.current?.();
				return;
			}
			if (key === "N") {
				event.preventDefault();
				findPrevRef.current?.();
				return;
			}
			if (key === "J" || key === "K") {
				event.preventDefault();
				page(key === "J" ? 1 : -1);
				return;
			}
			const half = Math.max(1, viewport.clientHeight / 2);
			if (key === "j" || key === "k" || key === "d" || key === "u") {
				event.preventDefault();
				handleScrollSyncIntent(documentId);
				const distance = key === "d" || key === "u" ? half : 72;
				viewport.scrollTop += key === "j" || key === "d" ? distance : -distance;
				return;
			}
			if (key === "h" || key === "l") {
				event.preventDefault();
				if (strategyRef.current === "paginated") page(key === "l" ? 1 : -1);
				else {
					handleScrollSyncIntent(documentId);
					viewport.scrollLeft += key === "l" ? 72 : -72;
				}
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", clearPrefix);
		window.addEventListener("focusin", clearPrefix);
		window.addEventListener("pointerdown", clearPrefix);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", clearPrefix);
			window.removeEventListener("focusin", clearPrefix);
			window.removeEventListener("pointerdown", clearPrefix);
			clearPrefix();
		};
	}, [documentId, hostRef, totalPages, viewportRef]);
	return null;
}
