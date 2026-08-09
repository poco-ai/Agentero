"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * When set, wiki embeds and export chrome switch to a print-friendly layout:
 * expand long content, drop interactive affordances, keep titles.
 */
export type MarkdownExportMode = {
	/** Expand embed shells past the editor `max-h-96` cap. Default true. */
	expandEmbeds: boolean;
	/** Hide “open source” and other interactive chrome. Default true. */
	hideChromeActions: boolean;
};

const MarkdownExportModeContext = createContext<MarkdownExportMode | null>(
	null,
);

export function MarkdownExportModeProvider({
	value,
	children,
}: {
	value: MarkdownExportMode;
	children: ReactNode;
}) {
	return (
		<MarkdownExportModeContext.Provider value={value}>
			{children}
		</MarkdownExportModeContext.Provider>
	);
}

/** Null when not exporting (normal editor / live preview). */
export function useMarkdownExportMode(): MarkdownExportMode | null {
	return useContext(MarkdownExportModeContext);
}
