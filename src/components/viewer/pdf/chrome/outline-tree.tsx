import type { PdfBookmarkObject } from "@embedpdf/models";
import { bookmarkPageIndex } from "@/lib/pdf/bookmark";

/** Recursive outline (bookmarks) list for the PDF side panel. */
export function OutlineTree({
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
				<li key={`${depth}-${n.title}-${JSON.stringify(n.target ?? null)}`}>
					<button
						type="button"
						className="w-full truncate rounded px-2 py-1 text-left text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground"
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
}
