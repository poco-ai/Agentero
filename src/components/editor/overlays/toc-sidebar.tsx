"use client";

import { type Heading, isHeading } from "@platejs/toc";
import {
	type TocSideBarProps,
	useTocSideBar,
	useTocSideBarState,
} from "@platejs/toc/react";
import { ElementApi, NodeApi, type SlateEditor, type TNode } from "platejs";
import i18n from "@/i18n";
import { cn } from "@/lib/core/utils";

const markerWidthByDepth = {
	1: "w-5",
	2: "w-4",
	3: "w-3.5",
	4: "w-3",
	5: "w-2.5",
	6: "w-2",
} as const;

/** Label indent by heading depth. Applied to the out-of-flow label only, so
 * deep headings cannot push the marker out of the collapsed rail. */
const labelIndentByDepth = {
	1: 8,
	2: 18,
	3: 28,
	4: 38,
	5: 48,
	6: 58,
} as const;

const headingDepthByType: Record<string, number> = {
	h1: 1,
	h2: 2,
	h3: 3,
	h4: 4,
	h5: 5,
	h6: 6,
};

type TocHeadingCacheEntry = {
	/** `editor.children` reference the cache was computed for. */
	children: unknown;
	/** Signature of the cached list (id/depth/title per heading). */
	key: string;
	list: Heading[];
};

/** Per-editor cache; editors are keyed weakly so tabs can be GC'd. */
const tocHeadingCache = new WeakMap<object, TocHeadingCacheEntry>();

/** A heading located relative to the subtree it was found in. */
type RelHeading = Omit<Heading, "path"> & { path: number[] };

const NO_HEADINGS: RelHeading[] = [];

/**
 * Headings inside one node's subtree, keyed on the node object.
 *
 * Slate reuses every node object an edit did not touch, so a keystroke
 * invalidates only the block it landed in. Recursion skips text leaves, which
 * cannot contain a heading and make up the bulk of a long document.
 */
const subtreeHeadingCache = new WeakMap<object, RelHeading[]>();

function subtreeHeadings(node: TNode): RelHeading[] {
	const cached = subtreeHeadingCache.get(node);
	if (cached) return cached;

	const found: RelHeading[] = [];
	if (isHeading(node)) {
		const title = NodeApi.string(node);
		if (title) {
			const { id, type } = node as { id?: string; type: string };
			found.push({
				id: id ?? "",
				depth: headingDepthByType[type] ?? 6,
				path: [],
				title,
				type,
			});
		}
	} else if (ElementApi.isElement(node)) {
		for (const [index, child] of node.children.entries()) {
			if (!ElementApi.isElement(child)) continue;
			for (const heading of subtreeHeadings(child)) {
				found.push({ ...heading, path: [index, ...heading.path] });
			}
		}
	}

	const result = found.length === 0 ? NO_HEADINGS : found;
	subtreeHeadingCache.set(node, result);
	return result;
}

/**
 * `TocPlugin` `queryHeading` override.
 *
 * The library's `getHeadingList` walks the whole document — every element and
 * every text leaf — and returns a fresh array on every call, while both
 * `useTocSideBarState` and its content observer select it. On a long note that
 * landed a full traversal on every keystroke, plus an IntersectionObserver
 * rebuild (the observer effect depends on the list reference).
 *
 * Three layers avoid that: `editor.children` identity short-circuits repeat
 * calls within one edit, `subtreeHeadings` reduces an edit to re-scanning the
 * one block it touched, and holding the array reference while heading
 * id/depth/title are unchanged keeps edits elsewhere from re-rendering the
 * sidebar or rebuilding the observer.
 */
export function queryTocHeadings(editor: SlateEditor): Heading[] {
	let entry = tocHeadingCache.get(editor);
	if (entry && entry.children === editor.children) return entry.list;

	const list: Heading[] = [];
	for (const [index, node] of editor.children.entries()) {
		for (const heading of subtreeHeadings(node)) {
			list.push({ ...heading, path: [index, ...heading.path] });
		}
	}
	const key = list
		.map(
			(heading) => `${heading.id}\u0000${heading.depth}\u0000${heading.title}`,
		)
		.join("\u0001");

	if (!entry) {
		entry = { children: null, key: "", list: [] };
		tocHeadingCache.set(editor, entry);
	}
	entry.children = editor.children;
	if (key !== entry.key) {
		entry.key = key;
		entry.list = list;
		return entry.list;
	}
	// Same headings at shifted positions (an edit above them). The sidebar renders
	// only id/depth/title, so refreshing `path` in place keeps the array and object
	// references stable while `onContentClick`'s `NodeApi.get` stays correct.
	for (const [index, heading] of entry.list.entries()) {
		heading.path = list[index].path;
	}
	return entry.list;
}

/**
 * Mounting this component adds two editor selectors and an
 * IntersectionObserver over every heading, so the caller gates on this
 * threshold instead of letting the component render null.
 */
export const MINIMUM_TOC_HEADINGS = 3;

export function TocSidebar(props: TocSideBarProps) {
	const state = useTocSideBarState(props);
	const { navProps, onContentClick } = useTocSideBar(state);

	if (state.headingList.length < MINIMUM_TOC_HEADINGS) return null;

	return (
		<nav
			{...navProps}
			aria-label={i18n.t("editor:toc.label")}
			className={cn(
				"group/toc absolute top-1/4 right-2 z-20 w-10",
				// Hover expands to w-64: wider than a narrow pane, so drop the strip
				// there (the editor also reclaims its right gutter at that width).
				"@max-2xs/editor:hidden",
				"transition-[width] duration-200 ease-out hover:w-64 focus-within:w-64 motion-reduce:transition-none",
			)}
		>
			<div
				className={cn(
					"rounded-xl border border-transparent bg-transparent p-1",
					"transition-[background-color,border-color,box-shadow] duration-200 ease-out",
					"group-hover/toc:border-border/70 group-hover/toc:bg-background/95 group-hover/toc:shadow-overlay",
					"group-focus-within/toc:border-border/70 group-focus-within/toc:bg-background/95 group-focus-within/toc:shadow-overlay",
				)}
			>
				<div
					id="toc_wrap"
					className="max-h-[min(46vh,28rem)] overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{state.headingList.map((item, index) => {
						const active = item.id === state.activeContentId;
						const depth = Math.min(Math.max(item.depth || 1, 1), 6);

						return (
							<button
								key={item.id}
								id={active ? "toc_item_active" : undefined}
								type="button"
								aria-current={active ? "location" : undefined}
								aria-label={item.title}
								data-active={active}
								className={cn(
									"group/item relative flex h-5 w-full items-center rounded-md outline-none",
									// Breathing room before each top-level section heading.
									index > 0 && depth === 1 && "mt-1.5",
									"transition-colors duration-150 ease-out",
									"text-muted-foreground hover:bg-muted/40 hover:text-foreground",
									"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
									depth === 1 && "text-foreground/80",
									active && "text-foreground hover:text-foreground",
								)}
								onClick={(event) => onContentClick(event, item, "smooth")}
							>
								{/*
								 * The label is out of flow: its depth indent never widens the
								 * collapsed rail, so deep headings can't push the heading
								 * markers right (and back on hover). The marker stays pinned
								 * to the same right edge at every rail width.
								 */}
								<span
									className={cn(
										"pointer-events-none absolute inset-y-0 left-0 right-8 flex min-w-0 items-center",
										"translate-x-1 opacity-0 transition-[transform,opacity] duration-200 ease-out",
										"group-hover/toc:translate-x-0 group-hover/toc:opacity-100",
										"group-focus-within/toc:translate-x-0 group-focus-within/toc:opacity-100",
										"motion-reduce:transition-none",
									)}
									style={{
										paddingLeft:
											labelIndentByDepth[
												depth as keyof typeof labelIndentByDepth
											],
									}}
								>
									<span
										className={cn(
											"min-w-0 truncate text-left text-xs",
											active
												? "font-semibold"
												: depth === 1
													? "font-medium"
													: "font-normal",
										)}
									>
										{item.title}
									</span>
								</span>
								<span
									aria-hidden="true"
									className={cn(
										"absolute right-1.5 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted-foreground/35",
										"transition-[height,width,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
										markerWidthByDepth[
											item.depth as keyof typeof markerWidthByDepth
										] ?? markerWidthByDepth[6],
										"group-hover/item:bg-muted-foreground/70",
										active &&
											"h-1 bg-foreground ring-2 ring-foreground/15 group-hover/item:bg-foreground",
									)}
								/>
							</button>
						);
					})}
				</div>
			</div>
		</nav>
	);
}
