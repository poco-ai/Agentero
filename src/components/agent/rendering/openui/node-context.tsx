"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { createContext, type ReactNode, useContext } from "react";

export type OpenUiRenderNode = (node: ElementNode) => ReactNode;

const OpenUiNodeContext = createContext<OpenUiRenderNode | null>(null);

export function OpenUiNodeProvider({
	render,
	children,
}: {
	render: OpenUiRenderNode;
	children: ReactNode;
}) {
	return (
		<OpenUiNodeContext.Provider value={render}>
			{children}
		</OpenUiNodeContext.Provider>
	);
}

export function useOpenUiRenderNode(): OpenUiRenderNode {
	return useContext(OpenUiNodeContext) ?? (() => null);
}
