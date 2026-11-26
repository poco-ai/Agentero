import { createStore } from "zustand/vanilla";
import { patchTab } from "@/lib/workspace/tabs/model";
import type { DocTab } from "@/lib/workspace/tabs/types";

export const sidebarDocuments = createStore<{ tabs: DocTab[] }>(() => ({
	tabs: [],
}));

export const getSidebarDocuments = () => sidebarDocuments.getState().tabs;

export function setSidebarDocuments(update: (tabs: DocTab[]) => DocTab[]) {
	sidebarDocuments.setState((state) => {
		const tabs = update(state.tabs);
		return tabs === state.tabs ? state : { tabs };
	});
}

export function patchSidebarDocument(id: string, patch: Partial<DocTab>) {
	setSidebarDocuments((tabs) => patchTab(tabs, id, patch));
}
