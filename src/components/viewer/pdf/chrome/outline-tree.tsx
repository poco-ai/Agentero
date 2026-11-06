import type { PdfBookmarkObject } from "@embedpdf/models";
import { memo } from "react";
import { bookmarkPageIndex } from "@/lib/pdf/bookmark";

/**
 * Key per bookmark object, computed once: the raw JSON.stringify of the target
 * walked every node on every render before this cache existed.
 */
const bookmarkKeyCache = new WeakMap<PdfBookmarkObject, string>();

function bookmarkKey(node: PdfBookmarkObject, depth: number): string {
	let key = bookmarkKeyCache.get(node);
	if (key === undefined) {
		key = `${depth}-${node.title}-${JSON.stringify(node.target ?? null)}`;
		bookmarkKeyCache.set(node, key);
	}
	return key;
}

/** Recursive outline (bookmarks) list for the PDF side panel. */
export const OutlineTree = memo(function OutlineTree({
	nodes,
	depth,
	onGoToPage,
}: {
	nodes: PdfBookmarkObject[];
	depth: number;
	onGoToPage: (page: number) => void;
}) {
	return (
		<ul className="space-y-0.5">
			{nodes.map((n) => (
				<li key={bookmarkKey(n, depth)}>
					<button
						type="button"
						className="w-full truncate rounded-md px-2 py-1 text-left text-muted-foreground text-sm transition-colors duration-100 hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
						style={{ paddingLeft: 8 + depth * 12 }}
						title={n.title}
						onClick={() => {
							const pageIndex = bookmarkPageIndex(n);
							if (pageIndex != null) {
								onGoToPage(pageIndex + 1);
							}
						}}
					>
						{n.title}
					</button>
					{n.children?.length ? (
						<OutlineTree
							nodes={n.children}
							depth={depth + 1}
							onGoToPage={onGoToPage}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
});
