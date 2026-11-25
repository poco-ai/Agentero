/**
 * Clipboard helpers — single place for writeText + optional success/error toasts.
 */

import {
	type NotifyOptions,
	notifyError,
	notifySuccess,
} from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

export type CopyTextOptions = {
	/** Success toast; omit for silent success. */
	successMessage?: string;
	/** Error toast; omit for silent failure (still returns false). */
	errorMessage?: string;
	/** Extra options for the success toast (duration, id, …). */
	successNotify?: NotifyOptions;
};

export type ReadTextOptions = {
	/** Error toast; omit for silent failure (still returns null). */
	errorMessage?: string;
};

/**
 * Synchronous copy for the desktop webview.
 *
 * WKWebView rejects `navigator.clipboard.writeText` with NotAllowedError while
 * a PDF surface is focused — including the translation pane — even inside the
 * click that asked for the copy. `execCommand("copy")` still runs in that
 * gesture. The sink is a textarea so the PDF selection's copy listener, which
 * ignores editable fields, does not replace the payload.
 */
function copyWithExecCommand(text: string): boolean {
	if (typeof document === "undefined") return false;
	const area = document.createElement("textarea");
	area.value = text;
	area.readOnly = true;
	area.setAttribute("aria-hidden", "true");
	area.tabIndex = -1;
	area.style.position = "fixed";
	area.style.top = "0";
	area.style.left = "0";
	area.style.width = "1px";
	area.style.height = "1px";
	area.style.opacity = "0";
	area.style.pointerEvents = "none";
	document.body.appendChild(area);
	const selection = document.getSelection();
	const saved =
		selection && selection.rangeCount > 0
			? selection.getRangeAt(0).cloneRange()
			: null;
	area.focus({ preventScroll: true });
	area.select();
	area.setSelectionRange(0, area.value.length);
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	area.remove();
	if (selection) {
		selection.removeAllRanges();
		if (saved) {
			try {
				selection.addRange(saved);
			} catch {
				// The saved range can die if its node unmounted during the copy.
			}
		}
	}
	return ok;
}

function reportCopyResult(ok: boolean, opts: CopyTextOptions): boolean {
	if (ok) {
		if (opts.successMessage) {
			notifySuccess(opts.successMessage, opts.successNotify);
		}
		return true;
	}
	if (opts.errorMessage) notifyError(opts.errorMessage);
	return false;
}

/**
 * Write plain text to the system clipboard.
 * @returns true when the write succeeded.
 */
export async function copyTextToClipboard(
	text: string,
	opts: CopyTextOptions = {},
): Promise<boolean> {
	// Desktop first: the sync command has to run before the click's user
	// activation expires. Waiting on writeText and only then falling back is
	// too late — WKWebView has already rejected the gesture.
	if (isTauri() && copyWithExecCommand(text)) {
		return reportCopyResult(true, opts);
	}
	try {
		if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
			throw new Error("clipboard unavailable");
		}
		await navigator.clipboard.writeText(text);
		return reportCopyResult(true, opts);
	} catch {
		if (copyWithExecCommand(text)) return reportCopyResult(true, opts);
		return reportCopyResult(false, opts);
	}
}

/**
 * Read plain text from the system clipboard.
 * @returns clipboard text, including an empty string, or null when unavailable.
 */
export async function readTextFromClipboard(
	opts: ReadTextOptions = {},
): Promise<string | null> {
	try {
		if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
			throw new Error("clipboard unavailable");
		}
		return await navigator.clipboard.readText();
	} catch {
		if (opts.errorMessage) {
			notifyError(opts.errorMessage);
		}
		return null;
	}
}
