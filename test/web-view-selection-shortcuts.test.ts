// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWebViewSelection } from "@/components/viewer/web-view/use-web-view-selection";

import {
	dismissSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";

const mocks = vi.hoisted(() => ({
	toggle: vi.fn(),
	add: vi.fn(() => true),
	quick: vi.fn(),
	resolve: vi.fn(),
	getShortcut: vi.fn(),
	listeners: new Set<() => void>(),
	settings: { shortcutOverrides: {} },
}));

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/agent/selection-quick-chat", () => ({
	runSelectionQuickChat: mocks.quick,
	runSelectionAddToChat: mocks.add,
}));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.mock("@/lib/pdf/translate", () => ({
	createTranslateRecord: vi.fn(),
	runSelectionTranslate: vi.fn(),
}));
vi.mock("@/lib/shell/ui-window-actions", () => ({ toggleChat: mocks.toggle }));
vi.mock("@/lib/shell/shortcuts", () => ({
	getShortcut: mocks.getShortcut,
	resolveShortcutId: mocks.resolve,
}));
vi.mock("@/lib/settings/react-store", () => ({
	settingsStore: {
		getState: () => mocks.settings,
		subscribe: (listener: () => void) => {
			mocks.listeners.add(listener);
			return () => mocks.listeners.delete(listener);
		},
	},
}));

let root: Root;
let container: HTMLDivElement;
let selection: ReturnType<typeof useWebViewSelection>;
const postMessage = vi.fn();
const contentWindow = { postMessage };
const iframeRef = {
	current: {
		contentWindow,
		getBoundingClientRect: () => ({
			x: 10,
			y: 20,
			left: 10,
			top: 20,
			width: 800,
			height: 600,
		}),
	} as unknown as HTMLIFrameElement,
};
function Probe() {
	selection = useWebViewSelection({
		srcUrl: "https://example.com/paper",
		iframeRef,
		title: "Research paper",
	});
	return null;
}
async function message(
	data: object,
	source: unknown = contentWindow,
	origin = "agentero-web://localhost",
) {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { source: "agentero-web", ...data },
				source: source as Window,
				origin,
			}),
		);
	});
}
const key = {
	key: "l",
	code: "KeyL",
	metaKey: true,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
};

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	dismissSelectionChat();
	mocks.settings.shortcutOverrides = {};
	mocks.getShortcut.mockImplementation((id, overrides) => ({
		id,
		key: overrides[id]?.key ?? id,
	}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	expect(mocks.listeners.size).toBe(0);
});

it("syncs latest effective settings on mount, readiness, load, and settings changes", async () => {
	expect(postMessage).toHaveBeenCalledOnce();
	await message({ type: "ready" });
	expect(postMessage).toHaveBeenCalledTimes(2);
	selection.onFrameLoad();
	expect(postMessage).toHaveBeenCalledTimes(3);
	mocks.settings.shortcutOverrides = { toggleChat: { key: "j" } };
	for (const listener of mocks.listeners) listener();
	expect(postMessage.mock.lastCall?.[0]).toMatchObject({
		type: "shortcuts",
		bindings: [
			{ id: "toggleChat", key: "j" },
			{ id: "quickChat" },
			{ id: "addSelectionToChat" },
		],
	});
});

it("resolves each forwarded key live and keeps toggle independent of an armed selection", async () => {
	await message({
		type: "selection",
		text: "quote",
		rect: { x: 0, y: 0, width: 30, height: 10 },
		url: "https://example.com/paper",
	});
	mocks.resolve.mockReturnValue("toggleChat");
	await message({ type: "shortcut", event: key });
	expect(mocks.resolve.mock.lastCall?.[0]).toMatchObject(key);
	expect(mocks.resolve.mock.lastCall?.[1]).toEqual({ settingsOpen: false });
	expect(mocks.toggle).toHaveBeenCalledOnce();
	expect(mocks.add).not.toHaveBeenCalled();
	expect(selectionChatStore.getState().draft?.selection).toMatchObject({
		text: "quote",
		sourceTitle: "Research paper",
		sourceUrl: "https://example.com/paper",
		surface: "web",
	});
	mocks.resolve.mockReturnValue("addSelectionToChat");
	await message({
		type: "shortcut",
		event: { ...key, key: "L", shiftKey: true },
	});
	expect(mocks.add).toHaveBeenCalledOnce();
	expect(postMessage.mock.lastCall?.[0]).toMatchObject({
		type: "clearSelection",
	});
});

it("rejects sibling frames and foreign origins, and ignores disabled or unrelated bindings", async () => {
	mocks.resolve.mockReturnValue("toggleChat");
	await message({ type: "shortcut", event: key }, {});
	await message(
		{ type: "shortcut", event: key },
		contentWindow,
		"https://example.com",
	);
	expect(mocks.resolve).not.toHaveBeenCalled();
	for (const id of [null, "settings"]) {
		mocks.resolve.mockReturnValue(id);
		await message({ type: "shortcut", event: key });
	}
	expect(mocks.toggle).not.toHaveBeenCalled();
	expect(mocks.add).not.toHaveBeenCalled();
});

it("ignores selection shortcuts owned by another reader and closes its menu on scroll", async () => {
	mocks.resolve.mockReturnValue("quickChat");
	await message({ type: "shortcut", event: key });
	expect(mocks.quick).not.toHaveBeenCalled();
	await message({
		type: "selection",
		text: "quote",
		rect: { x: 20, y: 40, width: 30, height: 10 },
		url: "agentero-web://localhost/example.com/next",
	});
	expect(selectionChatStore.getState().draft).toMatchObject({
		screen: { x: 45, y: 60 },
		selection: { sourceUrl: "https://example.com/next" },
	});
	await message({ type: "shortcut", event: key });
	expect(mocks.quick).toHaveBeenCalledOnce();
	await message({ type: "scroll" });
	expect(selectionChatStore.getState().draft).toBeNull();
});
