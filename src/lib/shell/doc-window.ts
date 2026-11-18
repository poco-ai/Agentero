/**
 * Per-path document native windows.
 *
 * Opening a window is not the same as the target holding the document.
 * `doc_window_open` returns when the webview is built or an existing window
 * is focused. The source then asks that window, by label, to accept only
 * after its content is loaded.
 */

import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { getVaultPath } from "@/lib/vault/store";

/** Same width as Rust `doc_window_label` (`doc-` + first 16 sha256 hex chars). */
const DOC_LABEL_HEX = 16;

export const DOC_MOVE_REQUEST_EVENT = "doc-window:move-request";
export const DOC_MOVE_RESULT_EVENT = "doc-window:move-result";
/** Source keeps its view when the target has not answered by this time. */
export const DOC_MOVE_ACCEPT_TIMEOUT_MS = 8_000;
const DOC_MOVE_RETRY_MS = 200;
const DOC_MOVE_DECISION_POLL_MS = 50;

export type DocMoveRequest = {
	requestId: string;
	/** Path the target must already be showing. A mismatch is ignored. */
	path: string;
	sourceLabel: string;
};

export type DocMoveRefusal = "unsaved" | "load";

export type DocMoveResult = {
	requestId: string;
	outcome: "accept" | "refuse";
	reason?: DocMoveRefusal;
};

export type DocMoveAccept =
	| { status: "accept" }
	| { status: "refuse"; reason: DocMoveRefusal }
	| { status: "timeout" };

/** What the document window can say about the path it was opened with. */
export type DocMoveHold = {
	unsaved: boolean;
	ready: boolean;
	/** Content for this path is loaded. A created-but-empty window is not. */
	loaded: boolean;
	failed: boolean;
};

export type DocMoveDecision =
	| { outcome: "accept" }
	| { outcome: "refuse"; reason: DocMoveRefusal };

/**
 * `doc-` + SHA-256(path UTF-8) first 16 hex chars.
 * Must match `doc_window_label` in `window/commands.rs`.
 */
export async function docWindowLabel(path: string): Promise<string> {
	const bytes = new TextEncoder().encode(path);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `doc-${hex.slice(0, DOC_LABEL_HEX)}`;
}

/**
 * Open or focus a document window for `path`.
 * Returns false when the desktop command fails. Callers must leave the
 * source view in place; a true result only means the webview exists.
 * An existing window is focused and keeps its current mode.
 */
export async function openDocWindow(
	path: string,
	mode?: string | null,
	opts?: { title?: string | null },
): Promise<boolean> {
	if (!isTauri()) {
		notifyError(i18n.t("app:windows.docDesktopOnly"));
		return false;
	}
	try {
		const fileName = path.split(/[/\\]/).pop() || undefined;
		const res = await commands.docWindowOpen(
			path,
			mode ?? null,
			getVaultPath(),
			opts?.title?.trim() || fileName || i18n.t("app:windows.titleDocument"),
		);
		if (res.status === "error") {
			notifyError(res.error);
			return false;
		}
		return true;
	} catch (error) {
		notifyError(String(error));
		return false;
	}
}

export function readDocWindowParams(): {
	path: string | null;
	mode: string | null;
	vaultPath: string | null;
} {
	try {
		const params = new URLSearchParams(window.location.search);
		return {
			path: params.get("path"),
			mode: params.get("mode"),
			vaultPath: params.get("vault_path"),
		};
	} catch {
		return { path: null, mode: null, vaultPath: null };
	}
}

/**
 * Unsaved draft refuses before a loaded document can accept.
 * Still loading waits. A finished load that has no content refuses.
 * This does not change the target's mode.
 */
export function decideDocMoveHold(hold: DocMoveHold): DocMoveDecision | "wait" {
	if (hold.unsaved) return { outcome: "refuse", reason: "unsaved" };
	if (hold.ready && hold.loaded && !hold.failed) return { outcome: "accept" };
	if (hold.ready) return { outcome: "refuse", reason: "load" };
	return "wait";
}

/**
 * Ask `targetLabel` to take `request.path` and wait for accept or refuse.
 * The request is repeated until an answer or the timeout, because the new
 * webview may not be listening at the moment `doc_window_open` returns.
 * An answer that arrives after the timeout is ignored.
 */
export function requestDocMoveAccept(
	targetLabel: string,
	request: DocMoveRequest,
	timeoutMs = DOC_MOVE_ACCEPT_TIMEOUT_MS,
): Promise<DocMoveAccept> {
	return new Promise((resolve) => {
		let settled = false;
		let unlisten: UnlistenFn | undefined;
		let retry: ReturnType<typeof setInterval> | undefined;
		const timeout = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

		function finish(outcome: DocMoveAccept) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (retry) clearInterval(retry);
			retry = undefined;
			unlisten?.();
			unlisten = undefined;
			resolve(outcome);
		}

		const send = () => {
			if (settled) return;
			void emitTo(targetLabel, DOC_MOVE_REQUEST_EVENT, request).catch(() => {});
		};

		void listen<DocMoveResult>(DOC_MOVE_RESULT_EVENT, (event) => {
			const payload = event.payload;
			if (!payload || payload.requestId !== request.requestId) return;
			if (settled) return;
			if (payload.outcome === "accept") {
				finish({ status: "accept" });
				return;
			}
			finish({ status: "refuse", reason: payload.reason ?? "load" });
		})
			.then((stop) => {
				if (settled) {
					stop();
					return;
				}
				unlisten = stop;
				send();
				retry = setInterval(send, DOC_MOVE_RETRY_MS);
			})
			.catch(() => {
				finish({ status: "timeout" });
			});
	});
}

function emitDocMoveResult(
	sourceLabel: string,
	result: DocMoveResult,
): Promise<void> {
	return emitTo(sourceLabel, DOC_MOVE_RESULT_EVENT, result).catch(() => {});
}

function waitUntilDocMoveDecision(
	readHold: () => DocMoveHold,
	isCancelled: () => boolean,
): Promise<DocMoveDecision | null> {
	const deadline = Date.now() + DOC_MOVE_ACCEPT_TIMEOUT_MS;
	return new Promise((resolve) => {
		const tick = () => {
			if (isCancelled()) {
				resolve(null);
				return;
			}
			const decision = decideDocMoveHold(readHold());
			if (decision !== "wait") {
				resolve(decision);
				return;
			}
			// The source ignores a late accept. Stop polling instead of waiting
			// forever when this window's load never settles.
			if (Date.now() >= deadline) {
				resolve({ outcome: "refuse", reason: "load" });
				return;
			}
			setTimeout(tick, DOC_MOVE_DECISION_POLL_MS);
		};
		tick();
	});
}

/**
 * Listen for move requests aimed at this document window.
 * A different path is ignored. An already-loaded clean document accepts
 * without any mode change. Call the returned function to stop listening.
 */
export function startDocMoveTarget(
	path: string,
	readHold: () => DocMoveHold,
): () => void {
	let disposed = false;
	let unlisten: UnlistenFn | undefined;
	const outcomes = new Map<string, DocMoveDecision>();
	const pending = new Set<string>();

	void listen<DocMoveRequest>(DOC_MOVE_REQUEST_EVENT, (event) => {
		const request = event.payload;
		if (disposed || !request || request.path !== path) return;
		const cached = outcomes.get(request.requestId);
		if (cached) {
			void emitDocMoveResult(request.sourceLabel, {
				requestId: request.requestId,
				...cached,
			});
			return;
		}
		if (pending.has(request.requestId)) return;
		pending.add(request.requestId);
		void waitUntilDocMoveDecision(readHold, () => disposed).then((decision) => {
			pending.delete(request.requestId);
			if (!decision || disposed) return;
			outcomes.set(request.requestId, decision);
			void emitDocMoveResult(request.sourceLabel, {
				requestId: request.requestId,
				...decision,
			});
		});
	})
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		})
		.catch(() => {});

	return () => {
		disposed = true;
		unlisten?.();
		unlisten = undefined;
	};
}
