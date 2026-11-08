"use client";

import { createContext, type ReactNode, useContext } from "react";

export type OpenUiOpenSource = (source: string) => void;

const OpenUiSourceContext = createContext<OpenUiOpenSource | undefined>(
	undefined,
);

export function OpenUiSourceProvider({
	onOpenSource,
	children,
}: {
	onOpenSource?: OpenUiOpenSource;
	children: ReactNode;
}) {
	return (
		<OpenUiSourceContext.Provider value={onOpenSource}>
			{children}
		</OpenUiSourceContext.Provider>
	);
}

export function useOpenUiSource(): OpenUiOpenSource | undefined {
	return useContext(OpenUiSourceContext);
}
