/**
 * Wire contract of the `agentero-web` selection bridge (injected by
 * `features/web/proxy.rs` into every proxied document).
 *
 * Frame → app messages carry `source: "agentero-web"`; the reverse direction
 * (`use-web-view-selection` → frame) carries `source: "agentero-web-host"`.
 * Parsing lives here so both the listener hook and tests share one guard.
 */

import type { SelectionDraftScreen } from "@/lib/agent/selection-chat-store";
import type { SelectionSide } from "@/lib/agent/selection-side";

/** Keyboard state forwarded for authoritative matching against live settings. */
export type WebBridgeKeyEvent = Pick<
	KeyboardEvent,
	"key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** Selection rect in the frame's viewport (CSS px). */
export type WebBridgeRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type WebBridgeMessage =
	| {
			type: "selection";
			text: string;
			rect: WebBridgeRect | null;
			url: string;
			/** Side of the selection where the frame gesture ended. */
			side?: SelectionSide;
			/** Frame-viewport x of the gesture endpoint. */
			cursorX?: number;
	  }
	| { type: "scroll" }
	| { type: "ready" }
	| { type: "escape" }
	| { type: "shortcut"; event: WebBridgeKeyEvent }
	| { type: "external"; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Narrow a `MessageEvent.data` into a bridge message (null when foreign). */
export function parseWebBridgeMessage(data: unknown): WebBridgeMessage | null {
	if (!isRecord(data) || data.source !== "agentero-web") return null;
	switch (data.type) {
		case "selection": {
			if (typeof data.text !== "string" || typeof data.url !== "string")
				return null;
			const raw = data.rect;
			let rect: WebBridgeRect | null = null;
			if (isRecord(raw)) {
				const { x, y, width, height } = raw;
				if (
					typeof x === "number" &&
					typeof y === "number" &&
					typeof width === "number" &&
					typeof height === "number"
				) {
					rect = { x, y, width, height };
				}
			}
			const side =
				data.side === "above" || data.side === "below" ? data.side : undefined;
			const cursorX =
				typeof data.cursorX === "number" ? data.cursorX : undefined;
			return {
				type: "selection",
				text: data.text,
				rect,
				url: data.url,
				side,
				cursorX,
			};
		}
		case "ready":
			return { type: "ready" };
		case "scroll":
			return { type: "scroll" };
		case "escape":
			return { type: "escape" };
		case "shortcut": {
			const event = data.event;
			if (
				!isRecord(event) ||
				typeof event.key !== "string" ||
				typeof event.code !== "string" ||
				typeof event.metaKey !== "boolean" ||
				typeof event.ctrlKey !== "boolean" ||
				typeof event.altKey !== "boolean" ||
				typeof event.shiftKey !== "boolean"
			)
				return null;
			const { key, code, metaKey, ctrlKey, altKey, shiftKey } = event;
			return {
				type: "shortcut",
				event: { key, code, metaKey, ctrlKey, altKey, shiftKey },
			};
		}
		case "external":
			return typeof data.url === "string"
				? { type: "external", url: data.url }
				: null;
		default:
			return null;
	}
}

/**
 * Anchor point (top-center of the selection) in app viewport coordinates:
 * frame-viewport rect + the iframe element's offset in the page. The returned
 * bounds let floating cards open outside the selected lines.
 */
export function bridgeSelectionScreen(
	rect: WebBridgeRect,
	iframeRect: { x: number; y: number },
	side?: SelectionSide,
	cursorX?: number,
): SelectionDraftScreen {
	const left = iframeRect.x + rect.x;
	const top = iframeRect.y + rect.y;
	const right = left + rect.width;
	const bottom = top + rect.height;
	return {
		x: (left + right) / 2,
		y: top,
		side,
		cursorX: cursorX != null ? iframeRect.x + cursorX : undefined,
		selectionBounds: { left, top, right, bottom },
	};
}
