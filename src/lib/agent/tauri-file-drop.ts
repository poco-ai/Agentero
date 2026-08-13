/**
 * Single subscriber hub for Tauri OS file-drag events (composer images,
 * Library PDFs, …). HTML5 DataTransfer is often empty for Finder / Preview
 * / other-app drops on macOS WKWebView; these events carry absolute paths.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { isTauri } from "@/lib/core/tauri";

export type TauriFileDropPayload = DragDropEvent;

type Handler = (payload: TauriFileDropPayload) => void;

const handlers = new Set<Handler>();
let startPromise: Promise<UnlistenFn | null> | null = null;

function dispatch(payload: TauriFileDropPayload): void {
	for (const handler of handlers) {
		handler(payload);
	}
}

async function ensureStarted(): Promise<UnlistenFn | null> {
	if (!isTauri()) return null;
	if (startPromise) return startPromise;
	startPromise = (async () => {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		return getCurrentWindow().onDragDropEvent((event) => {
			dispatch(event.payload);
		});
	})().catch((error) => {
		startPromise = null;
		console.warn("[agentero] tauri file-drop listen failed", error);
		return null;
	});
	return startPromise;
}

export function subscribeTauriFileDrop(handler: Handler): () => void {
	handlers.add(handler);
	void ensureStarted();
	return () => {
		handlers.delete(handler);
	};
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Tauri reports `PhysicalPosition`, but some macOS builds already match CSS
 * pixels. Try both spaces so a drop on the right-rail composer is not missed.
 */
export function isPhysicalPointInRect(
	position: {
		x: number;
		y: number;
		toLogical?: (factor: number) => { x: number; y: number };
	},
	rect: DOMRect,
): boolean {
	if (pointInRect(position.x, position.y, rect)) return true;
	const factor =
		typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	if (
		factor !== 1 &&
		pointInRect(position.x / factor, position.y / factor, rect)
	) {
		return true;
	}
	if (typeof position.toLogical === "function") {
		const logical = position.toLogical(factor);
		if (pointInRect(logical.x, logical.y, rect)) return true;
	}
	return false;
}

export function isClientPointInRect(
	x: number,
	y: number,
	rect: DOMRect,
): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
