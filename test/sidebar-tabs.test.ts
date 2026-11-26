/** @vitest-environment happy-dom */
import { createDockview, type DockviewApi } from "dockview";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	connectSidebarDock,
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	type SidebarTarget,
	sidebarChatState,
} from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";

const vault = vi.hoisted(() => ({ path: "/vault" }));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => vault.path,
	vaultLoadGeneration: () => 0,
}));
vi.mock("@/lib/workspace/store", () => ({ currentWindowLabel: () => "main" }));

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
	uiStore.setState({ rightSidebarOpen: false });
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
	disconnect?.();
	api.dispose();
	root.remove();
	vi.unstubAllGlobals();
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
