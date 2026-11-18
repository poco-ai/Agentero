// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/tauri")>()),
	isTauri: () => true,
}));

import { setVaultPath } from "@/lib/vault/store";
import { initWorkspaceStore, workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab } from "@/lib/workspace/tabs/model";
import {
	extractTabsFromLayout,
	panelPersistParams,
	savePersistedTabs,
} from "@/lib/workspace/tabs/persist";

describe("compiled LaTeX output session restore", () => {
	it("preserves the source association for a renamed PDF in a custom output folder", () => {
		const path = "/vault/thesis/build/paper.pdf";
		const root = "/vault/thesis/main.tex";
		const tab = {
			...createPlaceholderTab(path, "pdf"),
			loaded: true,
			texRoot: root,
		};
		const params = panelPersistParams(tab);
		expect(params).toMatchObject({ path, texRoot: root });
		expect(params.texLive).toBeUndefined();
		const layout = {
			panels: { [tab.id]: { id: tab.id, params } },
			activeGroup: "pdf",
			grid: { root: { type: "leaf", data: { id: "pdf", activeView: tab.id } } },
		};
		expect(extractTabsFromLayout(layout).tabs[0]).toMatchObject({
			path,
			texRoot: root,
		});
		savePersistedTabs(layout);
		setVaultPath("/vault");
		initWorkspaceStore();
		expect(workspaceStore.getState().tabs[0]).toMatchObject({
			path,
			texRoot: root,
			loaded: false,
		});
		expect(workspaceStore.getState().tabs[0]?.texLive).toBeUndefined();
		localStorage.removeItem("agentero-open-tabs");
	});
});
