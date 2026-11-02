import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellLayout } from "@/hooks/use-shell-layout";
import {
	commitShellRailWidths,
	getShellLayoutPrefs,
	loadShellLayoutPrefs,
	SHELL_LAYOUT_STORAGE_KEY,
} from "@/lib/shell/layout-persist";
import {
	initShellLayoutFromPrefs,
	layout,
	setLayoutMode,
	setRightSidebarOpenState,
	setSidebarCollapsedState,
	toggleSidebar,
	uiStore,
} from "@/lib/shell/ui-store";
import { setNotesSplit } from "@/lib/workspace/actions";

// Exercise the real controller and persistence without mounting desktop UI.
vi.mock("react", () => ({
	useRef: (current: unknown) => ({ current }),
	useMemo: (factory: () => unknown) => factory(),
	useEffect: (effect: () => unknown) => {
		effect();
	},
}));
vi.mock("react-resizable-panels", () => ({
	usePanelRef: () => ({ current: null }),
}));
vi.mock("@/lib/workspace/actions", () => ({
	setNotesSplit: vi.fn(),
	toggleNotesSplit: vi.fn(),
}));
vi.mock("@/lib/workspace/store", () => ({
	getActiveTabId: () => null,
	getTabs: () => [],
}));
const dock = vi.hoisted(() => ({
	maximized: false,
	maximize: vi.fn(() => true),
	exit: vi.fn(),
	isMaximized: vi.fn(() => false),
}));
vi.mock("@/lib/workspace/dock-registry", () => ({
	dockHandle: () => ({
		maximizeActivePanel: () => {
			const ok = dock.maximize();
			dock.maximized = Boolean(ok);
			return Boolean(ok);
		},
		exitMaximizedPanel: () => {
			dock.exit();
			dock.maximized = false;
		},
		isMaximizedPanel: () => dock.maximized,
	}),
}));

function mountController(vaultPath: string | null = null) {
	// biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to exercise the registered controller in Node.
	const shell = useShellLayout(vaultPath);
	const widths = { left: shell.initialLeftPx, right: shell.initialRightPx };
	for (const side of ["left", "right"] as const) {
		const ref =
			side === "left" ? shell.sidebarPanelRef : shell.rightSidebarPanelRef;
		const remembered =
			side === "left" ? shell.leftWidthPxRef : shell.rightWidthPxRef;
		const report = () => {
			if (widths[side] >= 80) remembered.current = widths[side];
			if (side === "left") setSidebarCollapsedState(widths[side] === 0);
			else setRightSidebarOpenState(widths[side] > 0);
		};
		ref.current = {
			collapse: () => {
				widths[side] = 0;
				report();
			},
			expand: () => {
				widths[side] = 260;
				report();
			},
			resize: (size) => {
				widths[side] = Number(size);
				report();
			},
			getSize: () => ({
				inPixels: widths[side],
				asPercentage: widths[side] / 12,
			}),
			isCollapsed: () => widths[side] === 0,
		};
	}
	const rightPanel = shell.rightSidebarPanelRef.current;
	if (!rightPanel) throw new Error("Missing test panel");
	shell.sourcePanelRef.current = {
		...rightPanel,
		getSize: () => ({
			inPixels: 1200 - widths.left - widths.right,
			asPercentage: 0,
		}),
	};
	const controller = layout();
	if (!controller) throw new Error("Layout controller was not registered");
	return { shell, widths, controller };
}

let resizeHandlers: Set<() => void>;

function dispatchWindowResize(): void {
	for (const handler of resizeHandlers) handler();
}

beforeEach(() => {
	vi.useFakeTimers();
	dock.maximized = false;
	dock.maximize.mockClear();
	dock.exit.mockClear();
	dock.isMaximized.mockClear();
	resizeHandlers = new Set();
	const data = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
	});
	vi.stubGlobal("window", {
		innerWidth: 1200,
		matchMedia: () => ({ matches: true }),
		addEventListener: (type: string, handler: () => void) => {
			if (type === "resize") resizeHandlers.add(handler);
		},
		removeEventListener: (type: string, handler: () => void) => {
			if (type === "resize") resizeHandlers.delete(handler);
		},
		setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
		clearTimeout: (id?: number) => clearTimeout(id),
	});
	vi.stubGlobal("document", { getElementById: () => null });
	loadShellLayoutPrefs();
	initShellLayoutFromPrefs();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("shell layout restoration", () => {
	it("maximizes the active pane in reading and toggles back to the previous custom layout", () => {
		const { controller, widths } = mountController();
		controller.applyLayoutMode("agent");
		setLayoutMode("custom");
		controller.setLeftCollapsed(false);
		controller.setRightCollapsed(false);
		const beforeReading = { ...widths };
		vi.mocked(setNotesSplit).mockClear();
		dock.exit.mockClear();

		controller.applyLayoutMode("reading");
		expect(uiStore.getState().layoutMode).toBe("reading");
		expect(widths).toEqual({ left: 0, right: 0 });
		expect(dock.maximize).toHaveBeenCalledTimes(1);
		expect(setNotesSplit).not.toHaveBeenCalled();

		// A second click must reliably leave reading even though the menu value
		// did not change (#764 follow-up: repeated clicks).
		controller.applyLayoutMode("reading");
		expect(dock.exit).toHaveBeenCalledTimes(1);
		expect(uiStore.getState().layoutMode).toBe("custom");
		expect(widths).toEqual(beforeReading);
	});

	it("leaves reading for another preset and exits the dock maximize", () => {
		const { controller, widths } = mountController();
		controller.applyLayoutMode("reading");
		expect(widths).toEqual({ left: 0, right: 0 });

		controller.applyLayoutMode("agent");
		expect(dock.exit).toHaveBeenCalledTimes(1);
		expect(uiStore.getState().layoutMode).toBe("agent");
		expect(widths.left).toBeGreaterThan(0);
		expect(widths.right).toBeGreaterThan(0);
	});

	it("boots into reading without stealing the previous preset's width slot", () => {
		localStorage.setItem(
			SHELL_LAYOUT_STORAGE_KEY,
			JSON.stringify({
				lastMode: "reading",
				lastPreset: "agent",
				widths: { agent: { left: 0.2 } },
			}),
		);
		loadShellLayoutPrefs();
		initShellLayoutFromPrefs();
		expect(uiStore.getState()).toMatchObject({
			layoutMode: "reading",
			lastAppliedPreset: "agent",
			sidebarCollapsed: true,
			rightSidebarOpen: false,
		});
		const { controller } = mountController();
		// A restored maximized layout has no in-memory snapshot; toggling it off
		// must still return to the previous preset, not the reading slot.
		controller.applyLayoutMode("reading");
		controller.applyLayoutMode("reading");
		expect(uiStore.getState().layoutMode).toBe("agent");
	});

	it("keeps the width owner when customizing a preset restored from older prefs", () => {
		localStorage.setItem(
			SHELL_LAYOUT_STORAGE_KEY,
			JSON.stringify({
				lastMode: "agent",
				widths: { agent: { left: 0.2, right: 0.3 } },
			}),
		);
		loadShellLayoutPrefs();
		initShellLayoutFromPrefs();
		setLayoutMode("custom");
		loadShellLayoutPrefs();
		initShellLayoutFromPrefs();
		expect(uiStore.getState().lastAppliedPreset).toBe("agent");
		expect(mountController().widths).toEqual({ left: 240, right: 360 });
	});

	it("reapplies the latest saved left width after Vault panel registration", () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
			frames.push(callback),
		);
		const { widths, shell } = mountController("/vault");
		expect(shell.initialLeftPx).toBe(200);
		commitShellRailWidths({ leftRatio: 0.24 }, "custom", 1200);
		// Registration may restore an old library layout; the explicit restore
		// must read the latest preference rather than the boot default.
		widths.left = 200;
		frames[0](0);
		expect(widths.left).toBe(288);
		expect(shell.leftWidthPxRef.current).toBe(288);
	});

	it("keeps a remembered left rail collapsed when a Vault opens", () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
			frames.push(callback),
		);
		commitShellRailWidths({ leftRatio: 0.24 }, "custom", 1200);
		const { widths, shell } = mountController("/vault");
		setSidebarCollapsedState(true);
		frames[0](0);
		expect(widths.left).toBe(0);
		expect(shell.leftWidthPxRef.current).toBe(288);
	});
	it("restores both notes rails after Agent round-trips, including reopening", () => {
		const { controller, widths } = mountController();
		controller.applyLayoutMode("notes");
		setLayoutMode("custom");
		controller.setLeftCollapsed(false);
		controller.setRightCollapsed(false);
		commitShellRailWidths({ leftRatio: 0.2, rightRatio: 0.3 }, "notes", 1200);
		controller.applyLayoutMode("agent");
		commitShellRailWidths({ leftRatio: 0.25, rightRatio: 0.4 }, "agent", 1200);
		controller.applyLayoutMode("notes");
		expect(widths.right).toBe(0);
		controller.setLeftCollapsed(true);
		expect(widths).toEqual({ left: 0, right: 0 });
		controller.setLeftCollapsed(false);
		controller.setRightCollapsed(false);
		// Agent width is global: the last committed 0.4 wins over notes' 0.3.
		expect(widths).toEqual({ left: 240, right: 480 });
		controller.applyLayoutMode("agent");
		expect(widths.right).toBe(480);
	});

	it("restores the previous preset and its global Agent width after reading", () => {
		commitShellRailWidths({ leftRatio: 0.25, rightRatio: 0.4 }, "agent", 1200);
		const { controller, widths } = mountController();
		widths.left = 300;
		controller.applyLayoutMode("agent");
		controller.applyLayoutMode("reading");
		controller.applyLayoutMode("reading");
		expect(uiStore.getState().layoutMode).toBe("agent");
		expect(widths).toEqual({ left: 300, right: 480 });
	});

	it("decouples left sidebar visibility from Agent and Notes layout modes", () => {
		const { controller, widths } = mountController();
		expect(widths.left).toBe(200);

		// Applying notes preset keeps left rail open
		controller.applyLayoutMode("notes");
		expect(uiStore.getState().layoutMode).toBe("notes");
		expect(widths.left).toBe(200);
		expect(widths.right).toBe(0);

		// Manually collapsing left rail preserves notes layout
		controller.setLeftCollapsed(true);
		expect(widths.left).toBe(0);
		expect(uiStore.getState().layoutMode).toBe("notes");

		// Switching to agent preset keeps left rail collapsed
		controller.applyLayoutMode("agent");
		expect(uiStore.getState().layoutMode).toBe("agent");
		expect(widths.left).toBe(0);
		expect(widths.right).toBeGreaterThan(0);

		// Toggling left rail via toggleSidebar preserves agent layout
		toggleSidebar();
		expect(widths.left).toBeGreaterThan(0);
		expect(uiStore.getState().layoutMode).toBe("agent");

		toggleSidebar();
		expect(widths.left).toBe(0);
		expect(uiStore.getState().layoutMode).toBe("agent");
	});

	it("restores custom visibility and its preset width owner after a cold reload", () => {
		const { controller } = mountController();
		controller.applyLayoutMode("notes");
		setLayoutMode("custom");
		controller.setLeftCollapsed(false);
		controller.setRightCollapsed(false);
		commitShellRailWidths({ leftRatio: 0.2, rightRatio: 0.3 }, "notes", 1200);
		// Re-read persisted JSON, with a new store state and different window width.
		loadShellLayoutPrefs();
		uiStore.setState({
			lastAppliedPreset: null,
			sidebarCollapsed: true,
			rightSidebarOpen: false,
		});
		initShellLayoutFromPrefs();
		window.innerWidth = 1500;
		const restored = useShellLayout();
		expect(restored.initialLeftPx).toBe(300);
		expect(restored.initialRightPx).toBe(450);
		expect(uiStore.getState()).toMatchObject({
			layoutMode: "custom",
			lastAppliedPreset: "notes",
			sidebarCollapsed: false,
			rightSidebarOpen: true,
		});
		commitShellRailWidths(
			{ rightRatio: 0.32 },
			uiStore.getState().lastAppliedPreset ?? "custom",
			1500,
		);
		expect(getShellLayoutPrefs().aiWidth).toBe(0.32);
	});

	it("snapshots both rail flags when entering custom without a visibility change", () => {
		mountController().controller.applyLayoutMode("agent");
		setLayoutMode("custom");
		expect(getShellLayoutPrefs().customRails).toEqual({
			leftCollapsed: false,
			rightOpen: true,
		});
	});

	it("reopens collapsed rails at the saved ratios after a window resize", () => {
		const { controller, widths, shell } = mountController();
		controller.applyLayoutMode("notes");
		commitShellRailWidths({ leftRatio: 0.2, rightRatio: 0.3 }, "notes", 1200);
		window.innerWidth = 1500;
		// A programmatic resize echo must not win over the user's saved widths.
		shell.leftWidthPxRef.current = 170;
		shell.rightWidthPxRef.current = 270;
		controller.setLeftCollapsed(false);
		controller.setRightCollapsed(false);
		expect(widths).toEqual({ left: 300, right: 450 });
	});

	it("reapplies remembered ratios after a post-boot window resize settles", () => {
		commitShellRailWidths({ leftRatio: 0.2, rightRatio: 0.35 }, "custom", 1200);
		setRightSidebarOpenState(true);
		const { widths } = mountController();
		expect(widths).toEqual({ left: 240, right: 420 });
		// macOS finishes restoring/maximizing the window after React's first
		// paint; the stale boot pixel widths must be replaced by the ratios.
		window.innerWidth = 1600;
		dispatchWindowResize();
		vi.advanceTimersByTime(150);
		expect(widths).toEqual({ left: 320, right: 560 });
	});

	it("stops mirroring the window once the boot settle window ends", () => {
		commitShellRailWidths({ leftRatio: 0.2, rightRatio: 0.35 }, "custom", 1200);
		setRightSidebarOpenState(true);
		const { widths } = mountController();
		vi.advanceTimersByTime(2100);
		expect(resizeHandlers.size).toBe(0);
		// Later window resizes keep the current pixel widths (panel default).
		window.innerWidth = 1600;
		dispatchWindowResize();
		vi.advanceTimersByTime(200);
		expect(widths).toEqual({ left: 240, right: 420 });
	});
});
