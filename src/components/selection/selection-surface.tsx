import { type ComponentProps, useEffect } from "react";
import { closeSelectionSource } from "@/lib/agent/selection-chat-store";
import type { SelectionInput } from "@/lib/agent/selection-store";

export type SelectionSource = Pick<
	SelectionInput,
	| "sourcePath"
	| "origin"
	| "sourceTitle"
	| "sourceUrl"
	| "surface"
	| "messageId"
>;

/** Use with an existing editor/message root that cannot add a wrapper. */
export function useSelectionSource(sourcePath: string | null | undefined) {
	useEffect(
		() => () => {
			if (sourcePath) closeSelectionSource(sourcePath);
		},
		[sourcePath],
	);
}

/** Opt a content region into the window's selection host. Controls remain native. */
export function selectionSurfaceProps(
	source: SelectionSource,
	autoCopy = false,
) {
	return {
		"data-selection-chat-source": source.sourcePath,
		"data-selection-chat-origin": source.origin,
		"data-selection-chat-title": source.sourceTitle,
		"data-selection-chat-url": source.sourceUrl,
		"data-selection-chat-surface": source.surface,
		"data-selection-chat-message": source.messageId,
		"data-selection-auto-copy": autoCopy ? "true" : undefined,
	};
}

/** Use the props helper on an existing editor root; use this component for prose. */
export function SelectionSurface({
	source,
	autoCopy = false,
	...props
}: ComponentProps<"div"> & { source: SelectionSource; autoCopy?: boolean }) {
	useSelectionSource(source.sourcePath);
	return <div {...props} {...selectionSurfaceProps(source, autoCopy)} />;
}
