import { expect, it, vi } from "vitest";
import type { ActivityRecord } from "@/lib/activity/api";
import {
	flushActivity,
	resetActivityBufferForTests,
} from "@/lib/activity/track";
import { vaultStore } from "@/lib/vault/store";
import { handleActivePanelChange } from "@/lib/workspace/navigation";
import { getTabs, setTabs } from "@/lib/workspace/store";
import {
	createPlaceholderTab,
	createTranslationSplitPane,
} from "@/lib/workspace/tabs";

const recordActivityEvents = vi.hoisted(() =>
	vi.fn(async (events: ActivityRecord[]) => events.length),
);
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/activity/api", () => ({ recordActivityEvents }));
vi.mock("@/lib/shell/workspace-broadcast", () => ({
	broadcastWorkspaceActive: () => undefined,
}));

it("counts original and translated panes once for the same paper and pauses outside them", async () => {
	const previousVault = vaultStore.getState();
	const previousTabs = getTabs();
	vi.useFakeTimers();
	resetActivityBufferForTests();
	const paper = {
		...createPlaceholderTab("/vault/papers/topic/demo", "pdf"),
		notesPath: "/vault/papers/topic/demo/NOTES.md",
	};
	const translated = createTranslationSplitPane(paper);
	if (!translated) throw new Error("Missing translation pane");
	const notes = createPlaceholderTab(paper.notesPath, "markdown");
	try {
		vaultStore.setState({ vaultPath: "/vault", paperFolders: [paper.path] });
		setTabs([paper, translated, notes]);
		handleActivePanelChange(paper.id);
		await vi.advanceTimersByTimeAsync(2000);
		handleActivePanelChange(translated.id);
		await vi.advanceTimersByTimeAsync(3000);
		handleActivePanelChange(paper.id);
		await vi.advanceTimersByTimeAsync(1000);
		handleActivePanelChange(notes.id);
		await vi.advanceTimersByTimeAsync(4000);
		await flushActivity();
		const slices = recordActivityEvents.mock.calls
			.flatMap(([events]) => events)
			.filter((event) => event.kind === "paper.blur");
		expect(slices.reduce((total, event) => total + (event.durMs ?? 0), 0)).toBe(
			6000,
		);
		expect(slices.every((event) => event.path === "papers/topic/demo")).toBe(
			true,
		);
	} finally {
		resetActivityBufferForTests();
		vi.useRealTimers();
		setTabs(previousTabs);
		vaultStore.setState(previousVault);
	}
});
