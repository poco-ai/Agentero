// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentHistorySidebar } from "@/components/agent/zen/agent-history-sidebar";
import type { ZenHarnessHistory } from "@/components/agent/zen/use-zen-history";
import { closeZenWorkspace, zenStore } from "@/lib/agent/zen-store";

const histories = vi.hoisted(() => [] as ZenHarnessHistory[]);

vi.mock("@/components/agent/zen/use-zen-history", () => ({
	useZenHarnessHistory: () => ({ sections: histories }),
}));
vi.mock("@/components/agent/agent-logo", () => ({ AgentLogo: () => null }));
vi.mock("@/components/sidebar/file-tree/file-tree-primitives", () => ({
	FileTreeDisclosureIcon: () => null,
}));
vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

function agentHistory(name: string, count: number): ZenHarnessHistory {
	return {
		agent: {
			id: name,
			name,
			template: "custom",
			command: "agent",
			args: [],
			env: {},
			available: true,
		},
		loading: false,
		sessions: Array.from({ length: count }, (_, index) => ({
			sessionId: `${name}-${index + 1}`,
			title: `${name} session ${index + 1}`,
			cwd: "/vault",
			updatedAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
		})),
	};
}

it("shows five recent sessions per agent and resets show-all after collapsing", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	histories.push(
		agentHistory("Agent One", 7),
		agentHistory("Agent Two", 6),
		agentHistory("Agent Three", 5),
	);
	zenStore.getState().addSlot({
		agentId: "Agent One",
		sessions: [
			{
				id: "open-session",
				agentId: "Agent One",
				providerSessionId: "Agent One-1",
				agentName: "Agent One",
				source: "local",
				title: "Recently updated open session",
				startedAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-11-01T00:00:00Z",
				status: "completed",
				lines: [],
			},
		],
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(() =>
			root.render(createElement(AgentHistorySidebar, { active: true })),
		);
		const one = host.querySelector<HTMLButtonElement>(
			'button[aria-label="Agent One"]',
		);
		const group = one?.closest("section");
		const rows = () =>
			Array.from(group?.querySelectorAll("button[title]") ?? [])
				.map((button) => button.textContent)
				.filter(Boolean);
		const showAllButtons = (scope?: ParentNode | null) =>
			Array.from(
				scope?.querySelectorAll<HTMLButtonElement>("button[aria-controls]") ??
					[],
			).filter(
				(button) =>
					button.textContent === "zen.showAllSessions" &&
					!button.closest("[inert]"),
			);
		const showAll = () => showAllButtons(group)[0];
		expect(rows()).toEqual([
			"Recently updated open session",
			"Agent One session 7",
			"Agent One session 6",
			"Agent One session 5",
			"Agent One session 4",
		]);
		expect(showAllButtons(host)).toHaveLength(2);
		expect(showAll()?.querySelector("svg")).toBeNull();
		expect(showAll()?.className).toContain("text-muted-foreground/80");
		const revealSlot = showAll()?.parentElement;
		expect(revealSlot?.className).toBe("h-7");
		const more = document.getElementById(
			showAll()?.getAttribute("aria-controls") ?? "",
		);
		expect(more?.className).toContain("grid-rows-[0fr]");
		const panel = document.getElementById(
			one?.getAttribute("aria-controls") ?? "",
		);
		expect(panel?.className).toContain(
			"motion-safe:data-open:animate-accordion-down",
		);
		expect(panel?.className).toContain(
			"motion-safe:data-closed:animate-accordion-up",
		);
		await act(() => showAll()?.click());
		expect(more?.className).toContain("grid-rows-[1fr]");
		expect(revealSlot?.querySelector("button")?.textContent).toBe(
			"Agent One session 3",
		);
		expect(revealSlot?.contains(document.activeElement)).toBe(true);
		expect(more?.contains(document.activeElement)).toBe(false);
		expect(more?.textContent).toBe("Agent One session 2");
		expect(rows()).toHaveLength(7);
		expect(rows()).toContain("Agent One session 2");
		expect(showAllButtons(host)).toHaveLength(1);
		await act(() => one?.click());
		expect(one?.getAttribute("aria-expanded")).toBe("false");
		expect(rows()).toHaveLength(0);
		await act(() => one?.click());
		expect(one?.getAttribute("aria-expanded")).toBe("true");
		expect(rows()).toHaveLength(5);
		expect(showAll()?.textContent).toBe("zen.showAllSessions");
	} finally {
		await act(() => root.unmount());
		host.remove();
		closeZenWorkspace();
		vi.unstubAllGlobals();
	}
});
