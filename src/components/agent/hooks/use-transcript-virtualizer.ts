/**
 * Windowed rendering for long agent transcripts. Rows are conversation turns
 * whose height spans tens to tens of thousands of pixels (Streamdown with
 * katex / shiki / mermaid), so beyond ~80 turns mounting every row at once
 * dominates memory even with row-level memoization.
 */
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { ChatLine } from "@/lib/agent/chat-state";
import { useUiScale } from "@/lib/settings";

/** Below this many turns the plain map path stays cheaper than virtualizing. */
export const VIRTUALIZE_MIN_LINES = 80;

/**
 * Same key the plain map path uses as React key. Agent lines embed the tab id
 * because history line ids can collide across sessions (e.g. Codex threads).
 */
export function transcriptLineKey(line: ChatLine, activeTabId: string): string {
	return line.kind === "agent" ? `${activeTabId}:${line.id}` : line.id;
}

/** Rough per-kind first-paint estimates to reduce initial measurement jitter. */
const ESTIMATE_BY_KIND: Record<ChatLine["kind"], number> = {
	user: 80,
	agent: 160,
	error: 48,
	system: 32,
};

export function useTranscriptVirtualizer({
	lines,
	activeTabId,
	forceVirtualize = false,
}: {
	lines: ChatLine[];
	activeTabId: string;
	/** Storybook / tests: virtualize even with few lines. */
	forceVirtualize?: boolean;
}): {
	rowVirtualizer: Virtualizer<HTMLElement, Element>;
	virtualized: boolean;
	lineKeys: string[];
} {
	// Reuse the StickToBottom scroll viewport. The totalSize container lives in
	// the content subtree, so its ResizeObserver keeps stick-to-bottom working.
	const { scrollRef } = useStickToBottomContext();
	const uiScale = useUiScale();
	const virtualized = forceVirtualize || lines.length >= VIRTUALIZE_MIN_LINES;

	const lineKeys = useMemo(
		() => lines.map((line) => transcriptLineKey(line, activeTabId)),
		[lines, activeTabId],
	);

	const estimateSize = useCallback(
		(index: number) =>
			Math.round(ESTIMATE_BY_KIND[lines[index]?.kind ?? "system"] * uiScale),
		[lines, uiScale],
	);

	const rowVirtualizer = useVirtualizer({
		count: virtualized ? lines.length : 0,
		getScrollElement: () => scrollRef.current,
		estimateSize,
		overscan: 10,
		getItemKey: (index) => lineKeys[index] ?? index,
	});

	// Only remeasure on scale changes: measure() clears the whole keyed size
	// cache, and rows that stay mounted (streaming updates to the last line,
	// truncating a resend) would be stranded on estimates until they resize.
	// Mount-time ref measurement plus per-row ResizeObservers already cover
	// line set changes; a uiScale change reflows every row, so the cleared
	// cache is repopulated immediately.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional remeasure trigger
	useEffect(() => {
		rowVirtualizer.measure();
	}, [uiScale, rowVirtualizer]);

	return { rowVirtualizer, virtualized, lineKeys };
}
