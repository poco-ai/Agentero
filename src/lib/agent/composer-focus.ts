import { chatInputRecipient } from "@/lib/agent/chat-input-surface";
import type { SelectionRecipient } from "@/lib/agent/selection-store";
import {
	removeSelection,
	selectionsForRecipient,
} from "@/lib/agent/selection-store";
import { zenScopeId, zenStore } from "@/lib/agent/zen-store";
import { broadcastSafe } from "@/lib/core/tauri-events";
import {
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	sidebarAgentTargets,
} from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";

/**
 * Focus the Agent composer input (⇧⌘L / palette). React `autoFocus` only fires
 * on mount, and the rail composer stays mounted while hidden, so callers that
 * just expanded the rail need an imperative focus. The composer may appear a few
 * frames later (rail expand + lazy panel), hence the bounded retry.
 *
 * Supports both the legacy textarea and the inline contenteditable field.
 */

export const AGENT_COMPOSER_INPUT_ATTR = "data-agent-composer-input";

const FOCUS_TIMEOUT_MS = 3000;

export const FEATURE_COMPOSER_INPUT_EVENT = "agent:feature-composer-input";

function visibleComposerInput(scopeId: string | null): HTMLElement | null {
	const nodes = document.querySelectorAll<HTMLElement>(
		`[${AGENT_COMPOSER_INPUT_ATTR}]`,
	);
	for (const node of nodes) {
		if (
			node.getAttribute(AGENT_COMPOSER_INPUT_ATTR) === (scopeId ?? "") &&
			node.offsetParent !== null
		)
			return node;
	}
	return null;
}

export type ComposerFocusOptions = {
	scopeId?: string | null;
	recipient?: SelectionRecipient;
	/**
	 * Focus the field without moving the caret. Add-to-chat inserts at the
	 * saved caret and then places it; jumping to the end would undo that.
	 */
	preserveCaret?: boolean;
};

function placeCaretAtEnd(el: HTMLElement) {
	if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
		const len = el.value.length;
		el.setSelectionRange(len, len);
		return;
	}
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	// selectNodeContents + collapse(false) lands before a contentEditable=false
	// chip. Walk back to a real text node (the caret pad after the last chip).
	let node: Node | null = el.lastChild;
	while (node && node.nodeType !== Node.TEXT_NODE) {
		node = node.previousSibling;
	}
	if (node) {
		range.setStart(node, (node as Text).data.length);
	} else {
		range.selectNodeContents(el);
		range.collapse(false);
	}
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/**
 * Surface the chat that owns app-wide inputs and put the caret in its
 * composer: the Agent rail normally, or the active Zen slot when an open Zen
 * workspace owns them.
 */
export function presentAgentComposer(options?: ComposerFocusOptions): void {
	const scopeId =
		options?.scopeId === undefined
			? chatInputRecipient().scopeId
			: options.scopeId;
	if (scopeId?.startsWith("zen:")) {
		focusAgentComposer({ ...options, scopeId });
		return;
	}
	void (async () => {
		if (scopeId === null && uiStore.getState().featurePoppedOut.agent) {
			const { focusFeatureWindow } = await import("@/lib/shell/feature-window");
			if (await focusFeatureWindow("agent")) {
				const selections = options?.recipient
					? selectionsForRecipient(options.recipient)
					: [];
				broadcastSafe(FEATURE_COMPOSER_INPUT_EVENT, { selections });
				for (const selection of selections) removeSelection(selection.id);
				return;
			}
			if (uiStore.getState().featurePoppedOut.agent) return;
		}
		const target =
			sidebarAgentTargets().find((target) => target.scopeId === scopeId) ??
			DEFAULT_SIDEBAR_AGENT;
		await openOrActivateSidebarTarget(target);
		focusAgentComposer({ ...options, scopeId });
	})();
}

export function focusAgentComposer(options?: ComposerFocusOptions): void {
	if (typeof document === "undefined") return;
	const scopeId =
		options?.scopeId === undefined
			? chatInputRecipient().scopeId
			: options.scopeId;
	const deadline = Date.now() + FOCUS_TIMEOUT_MS;
	const attempt = () => {
		const input = visibleComposerInput(scopeId);
		if (input) {
			if (options?.preserveCaret) {
				// Focusing again can drop a caret that was just placed after a
				// reference. Keep the selection when it already sits in the field.
				const selection = window.getSelection();
				const range =
					selection &&
					selection.rangeCount > 0 &&
					input.contains(selection.getRangeAt(0).startContainer)
						? selection.getRangeAt(0).cloneRange()
						: null;
				input.focus({ preventScroll: true });
				if (range && selection) {
					selection.removeAllRanges();
					selection.addRange(range);
				}
				return;
			}
			input.focus();
			placeCaretAtEnd(input);
			return;
		}
		if (Date.now() < deadline) requestAnimationFrame(attempt);
	};
	requestAnimationFrame(attempt);
}

export function focusZenComposer() {
	const active = zenStore.getState().activeSlotId;
	if (active) focusAgentComposer({ scopeId: zenScopeId(active) });
}
