import { beforeEach, expect, it, vi } from "vitest";
import { runChatShortcut } from "@/lib/agent/selection-chat-shortcut";
import {
	clearSelections,
	consumeSelections,
	currentSelections,
	publishSelection,
	selectionsForRecipient,
} from "@/lib/agent/selection-store";
import { DEFAULT_SIDEBAR_AGENT } from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";
import { openRightTab } from "@/lib/shell/ui-window-actions";

const actions = vi.hoisted(() => ({
	focusFeatureWindow: vi.fn(async () => true),
	openOrActivateSidebarTarget: vi.fn(async () => "view-agent"),
	toggleSidebarTabs: vi.fn(),
	presentAgentComposer: vi.fn(),
	chatInputRecipient: vi.fn(() => ({
		scopeId: "zen:active",
		sessionId: "session-a",
	})),
}));

vi.mock("@/lib/shell/sidebar-tabs", () => ({
	DEFAULT_SIDEBAR_AGENT: { kind: "agent", scopeId: null },
	openOrActivateSidebarTarget: actions.openOrActivateSidebarTarget,
	toggleSidebarTabs: actions.toggleSidebarTabs,
}));
vi.mock("@/lib/shell/feature-window", () => ({
	focusFeatureWindow: actions.focusFeatureWindow,
}));
vi.mock("@/lib/agent/chat-input-surface", () => ({
	chatInputRecipient: actions.chatInputRecipient,
}));
vi.mock("@/lib/agent/composer-focus", () => ({
	presentAgentComposer: actions.presentAgentComposer,
}));

beforeEach(() => {
	vi.clearAllMocks();
	uiStore.setState({ featurePoppedOut: {} });
	clearSelections();
});

it("toggles the shared sidebar without probing a popped-out Agent when there is no selection", () => {
	uiStore.setState({
		featurePoppedOut: { agent: true },
		agentWindowOpen: true,
	});
	runChatShortcut();
	expect(actions.toggleSidebarTabs).toHaveBeenCalledOnce();
	expect(actions.focusFeatureWindow).not.toHaveBeenCalled();
	expect(actions.presentAgentComposer).not.toHaveBeenCalled();
});

it("pins a quote once to the captured conversation and keeps the sidebar unchanged", () => {
	const recipient = { scopeId: "zen:active", sessionId: "session-a" };
	publishSelection({
		text: "quoted passage",
		sourcePath: "paper.pdf",
		origin: "pdf",
	});
	runChatShortcut();
	expect(actions.presentAgentComposer).toHaveBeenCalledOnce();
	expect(actions.presentAgentComposer).toHaveBeenCalledWith({
		preserveCaret: true,
		scopeId: recipient.scopeId,
		recipient,
	});
	expect(actions.toggleSidebarTabs).not.toHaveBeenCalled();
	expect(selectionsForRecipient(recipient).map((quote) => quote.text)).toEqual([
		"quoted passage",
	]);
	expect(
		selectionsForRecipient({ ...recipient, sessionId: "session-b" }),
	).toEqual([]);
	expect(currentSelections()).toEqual([]);
	expect(consumeSelections()).toEqual([]);
	expect(selectionsForRecipient(recipient)).toHaveLength(1);
});

it("focuses an existing popout on an explicit Agent open", async () => {
	uiStore.setState({ featurePoppedOut: { agent: true } });
	await openRightTab("agent");
	expect(actions.focusFeatureWindow).toHaveBeenCalledWith("agent");
	expect(actions.openOrActivateSidebarTarget).not.toHaveBeenCalled();
});

it("opens the default Agent in the sidebar on an explicit Agent open", async () => {
	await openRightTab("agent");
	expect(actions.openOrActivateSidebarTarget).toHaveBeenCalledWith(
		DEFAULT_SIDEBAR_AGENT,
	);
});
