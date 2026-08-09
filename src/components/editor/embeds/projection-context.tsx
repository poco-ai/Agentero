import {
	type ComponentType,
	createContext,
	type ReactNode,
	useContext,
} from "react";

export type WikiEmbedProjectionProps = {
	markdown: string;
	filePath: string;
};

const WikiEmbedProjectionContext =
	createContext<ComponentType<WikiEmbedProjectionProps> | null>(null);

export function WikiEmbedProjectionProvider({
	component,
	children,
}: {
	component: ComponentType<WikiEmbedProjectionProps>;
	children: ReactNode;
}) {
	return (
		<WikiEmbedProjectionContext.Provider value={component}>
			{children}
		</WikiEmbedProjectionContext.Provider>
	);
}

export function useWikiEmbedProjection() {
	return useContext(WikiEmbedProjectionContext);
}
