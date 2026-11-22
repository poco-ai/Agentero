import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerLayoutController,
	setRightSidebarOpenState,
	uiStore,
} from "@/lib/shell/ui-store";
import { openRightTab, toggleChat } from "@/lib/shell/ui-window-actions";

const probe = vi.hoisted(() => ({
	preferFeatureWindow: vi.fn<(tab: string) => Promise<boolean>>(),
}));

vi.mock("@/lib/shell/feature-window", () => ({
	preferFeatureWindow: probe.preferFeatureWindow,
}));

describe("agent rail open", () => {
	const calls: boolean[] = [];

	beforeEach(() => {
		calls.length = 0;
		uiStore.setState({
			immersiveReading: false,
			layoutMode: "custom",
			rightSidebarOpen: false,
			rightSidebarTab: "agent",
			featurePoppedOut: {},
			agentPanelMounted: false,
		});
		probe.preferFeatureWindow.mockReset();
		probe.preferFeatureWindow.mockResolvedValue(false);
		registerLayoutController({
			setLeftCollapsed: () => undefined,
			setRightCollapsed: (collapsed) => {
				calls.push(collapsed);
				setRightSidebarOpenState(!collapsed);
			},
			applyLayoutMode: () => undefined,
			toggleImmersiveReading: () => undefined,
			focusSidebar: () => undefined,
			focusEditorPane: () => undefined,
			focusNotesEditor: () => undefined,
		});
	});

	afterEach(() => {
		registerLayoutController(null);
	});

	it("expands the rail before the feature-window probe resolves", async () => {
		let resolveProbe: (found: boolean) => void = () => undefined;
		probe.preferFeatureWindow.mockReturnValue(
			new Promise((resolve) => {
				resolveProbe = resolve;
			}),
		);
		toggleChat();
		expect(calls).toEqual([false]);
		expect(uiStore.getState().rightSidebarOpen).toBe(true);
		expect(uiStore.getState().agentPanelMounted).toBe(false);
		resolveProbe(false);
		await vi.waitFor(() =>
			expect(probe.preferFeatureWindow).toHaveBeenCalledWith("agent"),
		);
		await Promise.resolve();
		expect(calls).toEqual([false]);
		expect(uiStore.getState().rightSidebarOpen).toBe(true);
	});

	it("focuses a known agent window without expanding the rail", async () => {
		uiStore.setState({ featurePoppedOut: { agent: true } });
		toggleChat();
		expect(calls).toEqual([]);
		expect(uiStore.getState().rightSidebarOpen).toBe(false);
		await vi.waitFor(() =>
			expect(probe.preferFeatureWindow).toHaveBeenCalledWith("agent"),
		);
	});

	it("yields a speculative rail when the probe finds a window", async () => {
		probe.preferFeatureWindow.mockResolvedValue(true);
		toggleChat();
		expect(calls[0]).toBe(false);
		await vi.waitFor(() => expect(calls).toEqual([false, true]));
		expect(uiStore.getState().rightSidebarOpen).toBe(false);
	});

	it("ignores a stale window hit after the rail is opened again", async () => {
		let resolveFirst: (found: boolean) => void = () => undefined;
		probe.preferFeatureWindow.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		toggleChat();
		await vi.waitFor(() =>
			expect(probe.preferFeatureWindow).toHaveBeenCalledTimes(1),
		);
		toggleChat();
		toggleChat();
		resolveFirst(true);
		await vi.waitFor(() =>
			expect(probe.preferFeatureWindow).toHaveBeenCalledTimes(2),
		);
		await Promise.resolve();
		expect(uiStore.getState().rightSidebarOpen).toBe(true);
		expect(calls).toEqual([false, true, false]);
	});

	it("opens a closed rail immediately from openRightTab", async () => {
		openRightTab("agent");
		expect(uiStore.getState().rightSidebarOpen).toBe(true);
		expect(calls).toEqual([false]);
		await vi.waitFor(() =>
			expect(probe.preferFeatureWindow).toHaveBeenCalledWith("agent"),
		);
	});
});
