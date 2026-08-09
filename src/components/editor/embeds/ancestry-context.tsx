"use client";

import { createContext, type ReactNode, useContext } from "react";

const WikiEmbedAncestryContext = createContext<readonly string[]>([]);

export function WikiEmbedAncestryProvider({
	ancestry,
	children,
}: {
	ancestry: readonly string[];
	children: ReactNode;
}) {
	return (
		<WikiEmbedAncestryContext.Provider value={ancestry}>
			{children}
		</WikiEmbedAncestryContext.Provider>
	);
}

export function useWikiEmbedAncestry(): readonly string[] {
	return useContext(WikiEmbedAncestryContext);
}
