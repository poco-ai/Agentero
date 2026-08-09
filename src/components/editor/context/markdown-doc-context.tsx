"use client";

import { createContext, type ReactNode, useContext } from "react";

export type MarkdownDocContextValue = {
	/** Absolute path of the Markdown file being edited (for `./assets/` resolution). */
	filePath: string | null;
	/** Called after a binary is written under `./assets/` (e.g. refresh file tree). */
	onAssetsChanged?: () => void;
};

const MarkdownDocContext = createContext<MarkdownDocContextValue>({
	filePath: null,
});

export function MarkdownDocProvider({
	value,
	children,
}: {
	value: MarkdownDocContextValue;
	children: ReactNode;
}) {
	return (
		<MarkdownDocContext.Provider value={value}>
			{children}
		</MarkdownDocContext.Provider>
	);
}

export function useMarkdownDoc(): MarkdownDocContextValue {
	return useContext(MarkdownDocContext);
}
