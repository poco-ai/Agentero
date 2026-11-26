/** @vitest-environment happy-dom */
import {
	createDockview,
	type DockviewApi,
	DockviewWillDropEvent,
	PanelTransfer,
} from "dockview";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	closeFocusedSidebarTab,
	cycleFocusedSidebarTab,
	newSidebarTab,
	trackSidebarTabInteraction,
} from "@/lib/shell/sidebar-tab-actions";
import {
	connectSidebarDock,
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	restrictSidebarTabDrop,
	type SidebarTarget,
	sidebarChatState,
} from "@/lib/shell/sidebar-tabs";
import { registerLayoutController, uiStore } from "@/lib/shell/ui-store";

const vault = vi.hoisted(() => ({ path: "/vault" }));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => vault.path,
	vaultLoadGeneration: () => 0,
}));
vi.mock("@/lib/workspace/store", () => ({ currentWindowLabel: () => "main" }));
vi.mock("@/lib/workspace/sidebar-files", () => ({
	currentSidebarPaperNotes: (viewId?: string) =>
		`papers/${viewId ?? "current"}/NOTES.md`,
}));

const key = "agentero-sidebar-tabs::main::/vault";
let root: HTMLDivElement;
let api: DockviewApi;
let disconnect: (() => void) | undefined;

beforeEach(() => {
	vault.path = "/vault";
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	uiStore.setState({ rightSidebarOpen: false, agentWindowOpen: false });
	root = document.createElement("div");
	document.body.append(root);
	api = createDockview(root, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
});

afterEach(() => {
	registerLayoutController(null);
	disconnect?.();
	api.dispose();
	root.remove();
	vi.unstubAllGlobals();
});

it("expands the collapsed rail and creates a fresh launcher for each new-tab request", async () => {
	registerLayoutController({
		setRightCollapsed: (collapsed) =>
			uiStore.setState({ rightSidebarOpen: !collapsed }),
	} as NonNullable<Parameters<typeof registerLayoutController>[0]>);
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
	});
	newSidebarTab();
	await vi.waitFor(() =>
		expect(api.activePanel?.api.component).toBe("launcher"),
	);
	const first = api.activePanel?.id;
	expect(uiStore.getState().rightSidebarOpen).toBe(true);
	expect(api.activePanel?.params?.target).toEqual({
		kind: "launcher",
		notesPath: "papers/current/NOTES.md",
		focusSearch: true,
	});
	newSidebarTab();
	expect(api.activePanel?.id).not.toBe(first);
	expect(
		api.panels.filter((panel) => panel.api.component === "launcher"),
	).toHaveLength(2);
});

it("routes a close from a non-focusable right sidebar surface to the active sidebar tab", async () => {
	root.dataset.rightSidebar = "";
	const stop = trackSidebarTabInteraction();
	try {
		disconnect = connectSidebarDock(api, vault.path, {
			title: (target) => target.kind,
		});
		const viewId = await openOrActivateSidebarTarget({ kind: "launcher" });
		uiStore.setState({ rightSidebarOpen: true });
		root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(closeFocusedSidebarTab()).toBe(true);
		expect(api.getPanel(viewId ?? "")).toBeUndefined();
		await openOrActivateSidebarTarget({ kind: "launcher" });
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(closeFocusedSidebarTab()).toBe(false);
	} finally {
		stop();
	}
});

it("closes and collapses the sole visible sidebar tab even before the sidebar has taken focus", async () => {
	const stop = trackSidebarTabInteraction();
	try {
		registerLayoutController({
			setRightCollapsed: (collapsed) =>
				uiStore.setState({ rightSidebarOpen: !collapsed }),
		} as NonNullable<Parameters<typeof registerLayoutController>[0]>);
		disconnect = connectSidebarDock(api, vault.path, {
			title: (target) => target.kind,
		});
		await vi.waitFor(() => expect(api.panels).toHaveLength(1));
		const soleTab = api.panels[0].id;
		uiStore.setState({ rightSidebarOpen: true });
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(closeFocusedSidebarTab()).toBe(true);
		expect(api.getPanel(soleTab)).toBeUndefined();
		expect(uiStore.getState().rightSidebarOpen).toBe(false);
		expect(closeFocusedSidebarTab()).toBe(false);
	} finally {
		stop();
	}
});

it("cycles the focused sidebar in visual tab order without sending the shortcut to the main dock", async () => {
	root.dataset.rightSidebar = "";
	const stop = trackSidebarTabInteraction();
	try {
		disconnect = connectSidebarDock(api, vault.path, {
			title: (target) => target.kind,
		});
		const pdfId = await openOrActivateSidebarTarget({
			kind: "pdf",
			vaultRelPath: "paper.pdf",
		});
		const launcherId = await openOrActivateSidebarTarget({ kind: "launcher" });
		const agentId = api.groups[0].panels[0].id;
		api.getPanel(pdfId ?? "")?.api.moveTo({ index: 0 });
		uiStore.setState({ rightSidebarOpen: true });
		root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(cycleFocusedSidebarTab(-1)).toBe(true);
		expect(api.activePanel?.id).toBe(launcherId);
		expect(cycleFocusedSidebarTab(1)).toBe(true);
		expect(api.activePanel?.id).toBe(pdfId);
		expect(cycleFocusedSidebarTab(1)).toBe(true);
		expect(api.activePanel?.id).toBe(agentId);
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(cycleFocusedSidebarTab(-1)).toBe(false);
		expect(api.activePanel?.id).toBe(agentId);
	} finally {
		stop();
	}
});

it("uses the focused iframe to route native tab shortcuts even without a parent pointer event", async () => {
	root.dataset.rightSidebar = "";
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.srcdoc = "<p>Preview</p>";
	root.append(frame);
	const stop = trackSidebarTabInteraction();
	try {
		disconnect = connectSidebarDock(api, vault.path, {
			title: (target) => target.kind,
		});
		await openOrActivateSidebarTarget({
			kind: "html",
			vaultRelPath: "report.html",
		});
		const html = api.activePanel;
		const agent = api.groups[0].panels[0];
		uiStore.setState({ rightSidebarOpen: true });
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		frame.focus();
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(document.activeElement).toBe(frame);
		expect(cycleFocusedSidebarTab(-1)).toBe(true);
		expect(api.activePanel).toBe(agent);
		frame.blur();
		expect(cycleFocusedSidebarTab(1)).toBe(true);
		expect(api.activePanel).toBe(html);
	} finally {
		stop();
	}
});

it("keeps the main workspace paper as the launcher source while opening and focusing a different sidebar PDF", async () => {
	root.dataset.rightSidebar = "";
	const mainPaper = document.createElement("button");
	mainPaper.dataset.workspaceView = "paper-b";
	document.body.append(mainPaper);
	const stop = trackSidebarTabInteraction();
	try {
		disconnect = connectSidebarDock(api, vault.path, {
			title: (target) => target.kind,
		});
		mainPaper.focus();
		const sidebarPdf = await openOrActivateSidebarTarget({
			kind: "pdf",
			vaultRelPath: "papers/paper-a/a.pdf",
		});
		const sidebarSurface = document.createElement("button");
		sidebarSurface.dataset.sidebarView = sidebarPdf;
		root.append(sidebarSurface);
		sidebarSurface.focus();
		newSidebarTab();
		expect(api.activePanel?.params?.target.notesPath).toBe(
			"papers/paper-b/NOTES.md",
		);
	} finally {
		stop();
		mainPaper.remove();
	}
});

it("saves the new order when a tab moves within the sidebar group", async () => {
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
	});
	const pdfId = await openOrActivateSidebarTarget({
		kind: "pdf",
		vaultRelPath: "paper.pdf",
	});
	const pdf = api.getPanel(pdfId ?? "");
	const agentId = api.groups[0].panels[0].id;
	pdf?.api.moveTo({ index: 0 });
	expect(api.groups[0].panels.map((panel) => panel.id)).toEqual([
		pdfId,
		agentId,
	]);
	expect(
		JSON.parse(localStorage.getItem(key) ?? "null").tabs.map(
			(tab: { viewId: string }) => tab.viewId,
		),
	).toEqual([pdfId, agentId]);
});

it("accepts tab-strip drops only from the same group", async () => {
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
	});
	const viewId = await openOrActivateSidebarTarget({
		kind: "pdf",
		vaultRelPath: "paper.pdf",
	});
	const group = api.groups[0];
	const drop = (
		kind: "tab" | "header_space" | "content",
		sourceGroup: string,
		sourceView: string | null,
		sourceDock = api.id,
	) => {
		const event = new DockviewWillDropEvent({
			api,
			group,
			kind,
			nativeEvent: new PointerEvent("pointerup"),
			position: "center",
			getData: () => new PanelTransfer(sourceDock, sourceGroup, sourceView),
		});
		restrictSidebarTabDrop(event);
		return event.defaultPrevented;
	};
	expect(drop("tab", group.id, viewId ?? null)).toBe(false);
	expect(drop("header_space", group.id, viewId ?? null)).toBe(false);
	expect(drop("content", group.id, viewId ?? null)).toBe(true);
	expect(drop("tab", "external-group", viewId ?? null)).toBe(true);
	expect(drop("tab", group.id, viewId ?? null, "external-dock")).toBe(true);
	expect(drop("header_space", group.id, null)).toBe(true);
});

it("restores the saved order and active tab without rewriting the snapshot mid-restore", async () => {
	const first = { viewId: "view-first", target: DEFAULT_SIDEBAR_AGENT };
	const second = {
		viewId: "view-second",
		target: { kind: "agent", scopeId: "second" },
	};
	const snapshot = {
		tabs: [first, second],
		activeViewId: first.viewId,
		expanded: false,
	};
	localStorage.setItem(key, JSON.stringify(snapshot));
	let resume!: (target: SidebarTarget) => void;
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
		restoreTarget: (target) =>
			target.kind !== "agent" || target.scopeId
				? Promise.resolve(target)
				: new Promise((resolve) => {
						resume = resolve;
					}),
	});
	uiStore.setState({ rightSidebarOpen: true });
	expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(snapshot);
	resume(DEFAULT_SIDEBAR_AGENT);
	await vi.waitFor(() => expect(api.activePanel?.id).toBe(first.viewId));
	expect(api.groups[0].panels.map((panel) => panel.id)).toEqual([
		first.viewId,
		second.viewId,
	]);
	openOrActivateSidebarTarget(DEFAULT_SIDEBAR_AGENT);
	expect(api.groups[0].panels).toHaveLength(2);
});

it("drains a pre-mount open intent after restoring the saved tabs", async () => {
	openOrActivateSidebarTarget({ kind: "launcher" });
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
	});
	await vi.waitFor(() =>
		expect(api.activePanel?.api.component).toBe("launcher"),
	);
	expect(api.groups[0].panels.map((panel) => panel.api.component)).toEqual([
		"agent",
		"launcher",
	]);
	expect(JSON.parse(localStorage.getItem(key) ?? "null").tabs).toHaveLength(1);
});

it("skips missing files, falls back to the first surviving tab, and reuses it", async () => {
	const pdf = { kind: "pdf", vaultRelPath: "papers/paper.pdf" } as const;
	const html = { kind: "html", vaultRelPath: "report.html" } as const;
	localStorage.setItem(
		key,
		JSON.stringify({
			tabs: [
				{ viewId: "view-pdf", target: pdf },
				{ viewId: "view-html", target: html },
			],
			activeViewId: "view-html",
			expanded: false,
		}),
	);
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
		restoreTarget: async (target) => (target.kind === "html" ? null : target),
	});
	await vi.waitFor(() => expect(api.activePanel?.id).toBe("view-pdf"));
	expect(await openOrActivateSidebarTarget(pdf)).toBe("view-pdf");
	expect(api.panels).toHaveLength(1);
});

it("restores the last conversation separately from the active document tab", async () => {
	const first = {
		viewId: "view-agent-a",
		target: { kind: "agent", scopeId: "sidebar:a" },
	};
	const second = {
		viewId: "view-agent-b",
		target: { kind: "agent", scopeId: "sidebar:b" },
	};
	const pdf = {
		viewId: "view-pdf",
		target: { kind: "pdf", vaultRelPath: "paper.pdf" },
	};
	localStorage.setItem(
		key,
		JSON.stringify({
			tabs: [first, second, pdf],
			activeViewId: pdf.viewId,
			lastAgentViewId: first.viewId,
			expanded: false,
		}),
	);
	disconnect = connectSidebarDock(api, vault.path, {
		title: (target) => target.kind,
	});
	await vi.waitFor(() => expect(api.activePanel?.id).toBe(pdf.viewId));
	expect(sidebarChatState.getState().scopeId).toBe("sidebar:a");
});
