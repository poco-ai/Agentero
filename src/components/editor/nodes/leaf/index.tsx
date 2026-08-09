"use client";

import { PlateLeaf, type PlateLeafProps } from "platejs/react";

/**
 * Every leaf renderer is the same element with a different tag and classes,
 * so they are declared through one factory rather than repeated five times.
 */
function leafRenderer(
	displayName: string,
	as: "code" | "kbd" | "mark",
	className: string,
) {
	const Leaf = (props: PlateLeafProps) => (
		<PlateLeaf {...props} as={as} className={className}>
			{props.children}
		</PlateLeaf>
	);
	Leaf.displayName = displayName;
	return Leaf;
}

export const CodeLeaf = leafRenderer(
	"CodeLeaf",
	"code",
	"whitespace-pre-wrap rounded-md bg-muted px-[0.3em] py-[0.2em] font-mono text-sm",
);

export const HighlightLeaf = leafRenderer(
	"HighlightLeaf",
	"mark",
	"bg-highlight/30 text-inherit",
);

export const KbdLeaf = leafRenderer(
	"KbdLeaf",
	"kbd",
	"rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-sm",
);

export const SearchHighlightLeaf = leafRenderer(
	"SearchHighlightLeaf",
	"mark",
	"rounded-[2px] bg-yellow-300/45 text-inherit dark:bg-yellow-400/30",
);

export const SearchHighlightActiveLeaf = leafRenderer(
	"SearchHighlightActiveLeaf",
	"mark",
	"rounded-[2px] bg-orange-400/70 text-inherit ring-1 ring-orange-500/60 dark:bg-orange-400/50",
);
