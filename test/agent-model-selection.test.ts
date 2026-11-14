// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
	type AgentConfig,
	useAgentConfig,
} from "@/components/agent/hooks/use-agent-config";
import { loadModelPref, warmAgent } from "@/lib/agent";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/agent/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agent/api")>()),
	scanCatalog: async () => ({ entries: [] }),
	listAgents: async () => ({ defaultId: "claude", agents: [] }),
	listAgentSkills: async () => [],
	warmAgent: vi.fn(async () => ({
		agentId: "claude",
		ok: true,
		models: {
			agentId: "claude",
			configId: "model",
			currentId: "sonnet",
			models: [{ id: "sonnet", name: "Sonnet" }],
		},
	})),
}));

const refs = {
	historyHydrationGenRef: { current: 0 },
	selectedAgentIdRef: { current: "claude" as string | null },
	vaultPathRef: { current: "/vault" as string | null },
};
const setSelectedAgentId = vi.fn();
const setLines = vi.fn();
const t = (key: string) => key;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
let config: AgentConfig;

function Probe() {
	config = useAgentConfig({
		vaultPath: "/vault",
		selectedAgentId: "claude",
		setSelectedAgentId,
		refs,
		t,
		setLines,
	});
	return null;
}

afterEach(async () => {
	await act(() => root?.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
	localStorage.clear();
});

it("reapplies an explicitly reselected current model and retains intent for the next turn", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	root = createRoot(container);
	await act(() => root.render(createElement(Probe)));
	await act(() => config.setAgentListenersReady(true));
	await act(() => vi.advanceTimersByTimeAsync(300));
	expect(config.modelId).toBe("sonnet");
	expect(vi.mocked(warmAgent).mock.lastCall?.[0].forceModel).toBeUndefined();

	await act(() => config.pickModel("sonnet"));
	expect(vi.mocked(warmAgent).mock.lastCall?.[0]).toMatchObject({
		agentId: "claude",
		modelId: "sonnet",
		forceModel: true,
	});
	expect(loadModelPref("claude")).toBe("sonnet");
	const firstSelection = config.modelSelectionRef.current;
	expect(firstSelection).toEqual({ agentId: "claude", modelId: "sonnet" });

	// Confirming the same item again creates a fresh intent, including while
	// an earlier turn may still be awaiting acceptance.
	await act(() => config.pickModel("sonnet"));
	expect(config.modelSelectionRef.current).not.toBe(firstSelection);
	expect(config.modelId).toBe("sonnet");
});
