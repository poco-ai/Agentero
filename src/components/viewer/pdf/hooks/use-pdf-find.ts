/**
 * ⌘F find bar for the EmbedPDF viewer: open/close chrome, the debounced
 * full-document query, and prev/next navigation that scrolls the match into
 * view.
 *
 * Split out because nothing else in the viewer reads the find state — the
 * search plugin is the only consumer — while the ⌘F listener and the debounce
 * timer are easy to break when they sit next to unrelated effects. The
 * `useSearch` capability itself stays in `PdfViewerInner` (plugin context) and
 * is injected here.
 */

import type { ScrollScope } from "@embedpdf/plugin-scroll/react";
import type {
	SearchDocumentState,
	SearchScope,
} from "@embedpdf/plugin-search/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";

/** How long the query rests before a full-document search is issued. */
const FIND_DEBOUNCE_MS = 250;

export type UsePdfFindOptions = {
	/** ⌘F only opens the bar while the PDF host is hovered or focused. */
	hostRef: RefObject<HTMLDivElement | null>;
	search: SearchScope | null;
	searchState: SearchDocumentState;
	scroll: ScrollScope | null;
};

export type PdfFind = {
	findOpen: boolean;
	findQuery: string;
	setFindQuery: Dispatch<SetStateAction<string>>;
	findInputRef: RefObject<HTMLInputElement | null>;
	/** Total matches for the current query. */
	findTotal: number;
	/** 0-based index of the focused match. */
	findActiveIndex: number;
	findNext: () => void;
	findPrev: () => void;
	closeFind: () => void;
};

export function usePdfFind({
	hostRef,
	search,
	searchState,
	scroll,
}: UsePdfFindOptions): PdfFind {
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const findInputRef = useRef<HTMLInputElement>(null);

	// Run a debounced full-document search as the query changes.
	useEffect(() => {
		if (!search) return;
		const q = findQuery.trim();
		if (!q) {
			search.stopSearch();
			return;
		}
		const id = setTimeout(() => {
			void search.searchAllPages(q);
		}, FIND_DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [findQuery, search]);

	// Cmd/Ctrl+F opens the in-document find bar when the PDF host is focused.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
			if (!host.matches(":hover") && !host.contains(document.activeElement))
				return;
			e.preventDefault();
			setFindOpen(true);
			search?.startSearch();
			setTimeout(() => findInputRef.current?.focus(), 0);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hostRef, search]);

	const scrollToResult = (idx: number) => {
		const r = searchState.results[idx];
		if (r && scroll)
			scroll.scrollToPage({
				pageNumber: r.pageIndex + 1,
				behavior: "instant",
			});
	};

	const closeFind = () => {
		setFindOpen(false);
		setFindQuery("");
		search?.stopSearch();
	};

	return {
		findOpen,
		findQuery,
		setFindQuery,
		findInputRef,
		findTotal: searchState.total,
		findActiveIndex: searchState.activeResultIndex,
		findNext: () => scrollToResult(search?.nextResult() ?? -1),
		findPrev: () => scrollToResult(search?.previousResult() ?? -1),
		closeFind,
	};
}
