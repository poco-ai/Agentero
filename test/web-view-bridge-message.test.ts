import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
	bridgeSelectionScreen,
	parseWebBridgeMessage,
} from "@/components/viewer/web-view/bridge-message";

describe("parseWebBridgeMessage", () => {
	it("parses a selection with a rect", () => {
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "selection",
				text: "quoted text",
				rect: { x: 10, y: 20, width: 100, height: 5 },
				url: "https://x.com/a",
				side: "below",
				cursorX: 42,
			}),
		).toEqual({
			type: "selection",
			text: "quoted text",
			rect: { x: 10, y: 20, width: 100, height: 5 },
			url: "https://x.com/a",
			side: "below",
			cursorX: 42,
		});
	});

	it("parses an emptied selection (rect may be null)", () => {
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "selection",
				text: "",
				rect: null,
				url: "https://x.com/a",
			}),
		).toEqual({
			type: "selection",
			text: "",
			rect: null,
			url: "https://x.com/a",
		});
	});

	it("drops a malformed rect rather than trusting partial numbers", () => {
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "selection",
				text: "t",
				rect: { x: 1, y: 2 },
				url: "https://x.com/a",
			})?.type,
		).toBe("selection");
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "selection",
				text: "t",
				rect: { x: 1, y: 2 },
				url: "https://x.com/a",
			}),
		).toMatchObject({ rect: null });
	});

	it("parses scroll / escape / shortcut / external messages", () => {
		expect(
			parseWebBridgeMessage({ source: "agentero-web", type: "scroll" }),
		).toEqual({
			type: "scroll",
		});
		expect(
			parseWebBridgeMessage({ source: "agentero-web", type: "escape" }),
		).toEqual({ type: "escape" });
		expect(
			parseWebBridgeMessage({ source: "agentero-web", type: "ready" }),
		).toEqual({ type: "ready" });
		const event = {
			key: "L",
			code: "KeyL",
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
		};
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "shortcut",
				event,
			}),
		).toEqual({ type: "shortcut", event });
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "shortcut",
				event: { key: "l" },
			}),
		).toBeNull();
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "external",
				url: "https://y.com",
			}),
		).toEqual({ type: "external", url: "https://y.com" });
	});

	it("refuses foreign or malformed payloads", () => {
		// Spoofed marker from an unrelated frame.
		expect(
			parseWebBridgeMessage({ source: "evil", type: "scroll" }),
		).toBeNull();
		expect(parseWebBridgeMessage({ type: "scroll" })).toBeNull();
		expect(parseWebBridgeMessage("agentero-web")).toBeNull();
		expect(parseWebBridgeMessage(null)).toBeNull();
		// Known type, bad payload.
		expect(
			parseWebBridgeMessage({ source: "agentero-web", type: "external" }),
		).toBeNull();
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "shortcut",
				id: "x",
			}),
		).toBeNull();
		expect(
			parseWebBridgeMessage({
				source: "agentero-web",
				type: "selection",
				text: 1,
			}),
		).toBeNull();
	});
});

describe("bridgeSelectionScreen", () => {
	it("maps the frame-viewport rect into app coordinates with the selection box", () => {
		expect(
			bridgeSelectionScreen(
				{ x: 100, y: 200, width: 60, height: 8 },
				{ x: 40, y: 12 },
				"above",
				100,
			),
		).toEqual({
			x: 170,
			y: 212,
			side: "above",
			cursorX: 140,
			selectionBounds: { left: 140, top: 212, right: 200, bottom: 220 },
		});
	});
});

// Execute the shipped script rather than a second implementation of its matcher.
const bridgeScript = readFileSync(
	new URL("../src/lib/web-view/selection-bridge.js", import.meta.url),
	"utf8",
);

function frameBridge() {
	const messages: Record<string, unknown>[] = [];
	const listeners: Record<string, (event: Record<string, unknown>) => void> =
		{};
	const parent = {
		get location(): never {
			throw new Error("cross origin");
		},
		postMessage: (message: Record<string, unknown>) => messages.push(message),
	};
	let selected = true;
	const window = {
		addEventListener: (type: string, listener: (typeof listeners)[string]) => {
			listeners[type] = listener;
		},
		getSelection: () => ({
			isCollapsed: !selected,
			toString: () => (selected ? "quote" : ""),
		}),
	};
	// Document mouseup/keyup listeners exist in the shipped script; these tests
	// only drive keyboard forwarding.
	const document = { addEventListener: () => {} };
	if (!bridgeScript) throw new Error("Missing injected bridge script");
	runInNewContext(bridgeScript, {
		parent,
		window,
		document,
		history: {},
		location: { pathname: "/example.com/paper" },
	});
	const configure = (
		bindings: object[],
		isMac = true,
		source: unknown = parent,
	) => {
		listeners.message({
			source,
			data: { source: "agentero-web-host", type: "shortcuts", bindings, isMac },
		});
	};
	const keydown = (key: string, overrides: Record<string, unknown> = {}) => {
		let prevented = false;
		listeners.keydown({
			key,
			code: `Key${key.toUpperCase()}`,
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			target: { nodeName: "DIV" },
			preventDefault: () => {
				prevented = true;
			},
			...overrides,
		});
		return prevented;
	};
	return {
		messages,
		configure,
		keydown,
		select: (value: boolean) => {
			selected = value;
		},
	};
}

const selectionBindings = [
	{ id: "toggleChat", key: "l", meta: true },
	{ id: "addSelectionToChat", key: "l", meta: true, shift: true },
	{ id: "quickChat", key: "k", meta: true },
];

describe("injected selection shortcut routing", () => {
	it("requests configuration and separates toggle, pin, and quick chat with exact modifiers", () => {
		const frame = frameBridge();
		expect(frame.messages).toEqual([{ source: "agentero-web", type: "ready" }]);
		expect(frame.keydown("l")).toBe(false);
		frame.configure(selectionBindings);
		expect(frame.keydown("l")).toBe(true);
		expect(frame.messages.at(-1)).toMatchObject({
			type: "shortcut",
			event: { key: "l", shiftKey: false },
		});
		expect(frame.keydown("L", { shiftKey: true })).toBe(true);
		expect(frame.messages.at(-1)).toMatchObject({
			event: { key: "L", shiftKey: true },
		});
		expect(frame.keydown("k")).toBe(true);
		expect(frame.keydown("k", { shiftKey: true })).toBe(false);
		expect(frame.keydown("l", { altKey: true })).toBe(false);
		expect(frame.keydown("l", { ctrlKey: true })).toBe(false);
	});

	it("toggles without selection, but selection actions require a live selection", () => {
		const frame = frameBridge();
		frame.configure(selectionBindings);
		frame.select(false);
		expect(frame.keydown("l")).toBe(true);
		expect(frame.keydown("L", { shiftKey: true })).toBe(false);
		expect(frame.keydown("k")).toBe(false);
	});

	it("replaces bindings live, including disabled shortcuts and Windows Ctrl mapping", () => {
		const frame = frameBridge();
		frame.configure(selectionBindings);
		frame.configure([{ id: "toggleChat", key: "j", meta: true }], false);
		expect(frame.keydown("l")).toBe(false);
		expect(frame.keydown("j", { metaKey: false, ctrlKey: true })).toBe(true);
		frame.configure([], false);
		expect(frame.keydown("j", { metaKey: false, ctrlKey: true })).toBe(false);
		frame.configure(selectionBindings, true, {});
		expect(frame.keydown("l")).toBe(false);
	});

	it("preserves editable targets, plain typing, IME, and already-handled keys", () => {
		const frame = frameBridge();
		frame.configure(selectionBindings);
		for (const target of [
			{ nodeName: "INPUT" },
			{ nodeName: "TEXTAREA" },
			{ nodeName: "SELECT" },
			{ nodeName: "SPAN", isContentEditable: true },
		])
			expect(frame.keydown("l", { target })).toBe(false);
		expect(frame.keydown("l", { metaKey: false })).toBe(false);
		expect(frame.keydown("l", { isComposing: true })).toBe(false);
		expect(frame.keydown("l", { defaultPrevented: true })).toBe(false);
	});

	it("matches custom Alt-only physical keys without stealing unmodified typing", () => {
		const frame = frameBridge();
		frame.configure([{ id: "addSelectionToChat", key: "a", alt: true }]);
		expect(
			frame.keydown("å", { code: "KeyA", metaKey: false, altKey: true }),
		).toBe(true);
		expect(frame.keydown("a", { metaKey: false })).toBe(false);
	});

	it("relays Escape without consuming it, except in editable fields", () => {
		const frame = frameBridge();
		const escapes = () =>
			frame.messages.filter((message) => message.type === "escape");
		expect(frame.keydown("Escape")).toBe(false);
		expect(escapes()).toHaveLength(1);
		expect(frame.keydown("Escape", { isComposing: true })).toBe(false);
		expect(frame.keydown("Escape", { repeat: true })).toBe(false);
		expect(frame.keydown("Escape", { target: { nodeName: "INPUT" } })).toBe(
			false,
		);
		expect(escapes()).toHaveLength(1);
		// A site that already handled Escape must not hide the app's own UI.
		expect(frame.keydown("Escape", { defaultPrevented: true })).toBe(false);
		expect(escapes()).toHaveLength(2);
	});
});
