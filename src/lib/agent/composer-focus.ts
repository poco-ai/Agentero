import { zenOwnsChatInput } from "@/lib/agent/chat-input-surface";
import { openRightTab } from "@/lib/shell/ui-window-actions";

/**
 * Focus the Agent composer input (⇧⌘L / palette). React `autoFocus` only fires
 * on mount, and the rail composer stays mounted while hidden, so callers that
 * just expanded the rail need an imperative focus. The composer may appear a few
 * frames later (rail expand + lazy panel), hence the bounded retry.
 *
 * Supports both the legacy textarea and the inline contenteditable field.
 */

export const AGENT_COMPOSER_INPUT_ATTR = "data-agent-composer-input";

const FOCUS_TIMEOUT_MS = 800;

function visibleComposerInput(): HTMLElement | null {
	const nodes = document.querySelectorAll<HTMLElement>(
		`[${AGENT_COMPOSER_INPUT_ATTR}]`,
	);
	for (const node of nodes) {
		if (node.offsetParent !== null) return node;
	}
	return null;
}

export type ComposerFocusOptions = {
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
	if (zenOwnsChatInput()) {
		// Dynamic import keeps workspace actions (and navigation) out of this
		// hot module's static graph.
		void import("@/lib/workspace/actions").then(({ openZenWorkspace }) => {
			openZenWorkspace();
			focusAgentComposer(options);
		});
		return;
	}
	openRightTab("agent");
	focusAgentComposer(options);
}

export function focusAgentComposer(options?: ComposerFocusOptions): void {
	if (typeof document === "undefined") return;
	const deadline = Date.now() + FOCUS_TIMEOUT_MS;
	const attempt = () => {
		const input = visibleComposerInput();
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
