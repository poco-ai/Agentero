import { describe, expect, it, vi } from "vitest";
import {
	agentSessionStore,
	clearAgentVaultState,
} from "@/lib/agent/agent-session-store";
import {
	clearLibraryVaultState,
	libraryStore,
} from "@/lib/paper/library-store";
import {
	annotationsStore,
	clearAnnotationsVaultState,
} from "@/lib/pdf/annotations-store";
import {
	clearLayoutVaultState,
	layoutAnalysisStore,
} from "@/lib/pdf/layout/store";
import { clearUiVaultState, uiStore } from "@/lib/shell/ui-store";
import { clearWikiVaultState, wikiStore } from "@/lib/wiki/store";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

describe("vault-scoped store clears", () => {
	it("drops library catalog rows but keeps the monotonic trash signal", () => {
		libraryStore.setState({
			papers: [{ path: "papers/a", title: "A" }] as never,
			paperMetaByRelPath: new Map([["papers/a", {} as never]]),
			editMetaDraft: {} as never,
			loading: true,
			rescanning: true,
			ioBusy: "import",
			trashReloadSignal: 7,
		});

		clearLibraryVaultState();

		const s = libraryStore.getState();
		expect(s.papers).toEqual([]);
		expect(s.paperMetaByRelPath.size).toBe(0);
		expect(s.editMetaDraft).toBeNull();
		expect(s.loading).toBe(false);
		expect(s.rescanning).toBe(false);
		expect(s.ioBusy).toBeNull();
		// Zeroing this could equal a subscriber's last-seen value and swallow an update.
		expect(s.trashReloadSignal).toBe(7);
	});

	it("drops the wiki rename flow but keeps the index revision", () => {
		wikiStore.setState({
			wikiIndexRevision: 12,
			externalRenamePreview: {} as never,
			externalRenameVaultPath: "/old",
			externalRenameRepairing: true,
			externalRenameFailure: {} as never,
		});

		clearWikiVaultState();

		const s = wikiStore.getState();
		expect(s.externalRenamePreview).toBeNull();
		expect(s.externalRenameVaultPath).toBeNull();
		expect(s.externalRenameRepairing).toBe(false);
		expect(s.externalRenameFailure).toBeNull();
		expect(s.wikiIndexRevision).toBe(12);
	});

	it("drops agent chat state but keeps the panel's turn-bridge handler", () => {
		const handler = vi.fn(async () => true);
		agentSessionStore.getState().registerSendHandler(handler);
		agentSessionStore.setState({
			sessions: [{ id: "s1" }] as never,
			activeTabId: "s1",
			hydratingSessionId: "s1",
			permissionRequest: { requestId: "req-1" } as never,
			turnRequest: {} as never,
		});

		clearAgentVaultState();

		const s = agentSessionStore.getState();
		expect(s.sessions).toEqual([]);
		expect(s.activeTabId).toBe("draft");
		expect(s.draftLines).toEqual([]);
		expect(s.hydratingSessionId).toBeNull();
		expect(s.permissionRequest).toBeNull();
		expect(s.turnRequest).toBeNull();
		// AgentPanel owns this slot; clearing it would break PDF-pin turns.
		expect(s._sendHandler).toBe(handler);
	});

	it("drops all tab-keyed annotations", () => {
		annotationsStore.setState({
			highlightsByTab: { tab1: [{} as never] },
			asksByTab: { tab1: [{} as never] },
			visualTracesByTab: { tab1: [{} as never] },
		});

		clearAnnotationsVaultState();

		expect(annotationsStore.getState()).toEqual({
			highlightsByTab: {},
			asksByTab: {},
			visualTracesByTab: {},
		});
	});

	it("drops all layout analysis results", () => {
		layoutAnalysisStore.setState({
			byDocument: { doc1: {} as never },
			ui: { stage: "analyzing" } as never,
			activeDocumentId: "doc1",
			activePaperAbsPath: "/vault/papers/a",
			focused: { documentId: "doc1", regionId: "r1" },
			overlayVisible: { doc1: true },
		});

		clearLayoutVaultState();

		expect(layoutAnalysisStore.getState()).toEqual({
			byDocument: {},
			ui: { stage: "idle" },
			activeDocumentId: null,
			activePaperAbsPath: null,
			focused: null,
			overlayVisible: {},
		});
	});

	it("closes vault dialogs but keeps chrome, window truth and signals", () => {
		uiStore.setState({
			skillImportDraft: [] as never,
			zoteroOpen: true,
			alphaxivOpen: true,
			zoteroSyncOpen: true,
			commandOpen: true,
			// Must all survive.
			sidebarCollapsed: true,
			rightSidebarOpen: true,
			rightSidebarTab: "figures",
			agentPanelMounted: true,
			featurePoppedOut: { agent: true },
			settingsOpen: true,
			lookupOpenSignal: 4,
		});

		clearUiVaultState();

		const s = uiStore.getState();
		expect(s.skillImportDraft).toBeNull();
		expect(s.zoteroOpen).toBe(false);
		expect(s.alphaxivOpen).toBe(false);
		expect(s.zoteroSyncOpen).toBe(false);
		expect(s.commandOpen).toBe(false);

		expect(s.sidebarCollapsed).toBe(true);
		expect(s.rightSidebarOpen).toBe(true);
		expect(s.rightSidebarTab).toBe("figures");
		expect(s.agentPanelMounted).toBe(true);
		expect(s.featurePoppedOut).toEqual({ agent: true });
		expect(s.settingsOpen).toBe(true);
		expect(s.lookupOpenSignal).toBe(4);
	});
});
