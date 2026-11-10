import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { type RefObject, useEffect, useRef } from "react";
import { useSettings } from "@/hooks/use-app-stores";
import { ownsPdfKeyboard } from "@/lib/pdf/keyboard-ownership";
import { handleScrollSyncIntent } from "@/lib/pdf/scroll-sync";

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
	const enabled = useSettings((s) => s.pdfVimKeys);
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
		if (!enabled || !viewport) return;
		let prefix = "";
		let prefixTimer: number | undefined;
		const clearPrefix = () => {
			prefix = "";
			if (prefixTimer !== undefined) window.clearTimeout(prefixTimer);
			prefixTimer = undefined;
		};
		const page = (direction: number) => {
			const scope = scrollRef.current?.forDocument(documentId);
			if (!scope) return;
			handleScrollSyncIntent(documentId);
			if (direction > 0) scope.scrollToNextPage("instant");
			else scope.scrollToPreviousPage("instant");
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
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
				return;
			}
			const scope = scrollRef.current?.forDocument(documentId);
			if (!scope) return;
			const key = event.key;
			if (key === "Escape") {
				if (prefix) {
					event.preventDefault();
					clearPrefix();
				}
				return;
			}
			if (/^\d$/.test(key)) {
				prefix += key;
				prefixTimer = window.setTimeout(clearPrefix, 1200);
				event.preventDefault();
				return;
			}
			if (key === "g" && !event.shiftKey) {
				if (prefix === "g") {
					event.preventDefault();
					clearPrefix();
					handleScrollSyncIntent(documentId);
					scope.scrollToPage({ pageNumber: 1, behavior: "instant" });
				} else {
					prefix = "g";
					prefixTimer = window.setTimeout(clearPrefix, 700);
					event.preventDefault();
				}
				return;
			}
			if (key === "G") {
				event.preventDefault();
				handleScrollSyncIntent(documentId);
				const number = prefix && prefix !== "g" ? Number(prefix) : undefined;
				clearPrefix();
				const total = totalPages || 1;
				scope.scrollToPage({
					pageNumber: Math.max(1, Math.min(number ?? total, total)),
					behavior: "instant",
				});
				return;
			}
			if (prefix) return;
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
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			clearPrefix();
		};
	}, [documentId, enabled, hostRef, totalPages, viewportRef]);
	return null;
}
