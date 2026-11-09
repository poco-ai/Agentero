/**
 * Editor/PDF text-selection → Agent context (zustand vanilla).
 * `active` mirrors the latest live selection so ⇧⌘L / ⌘K can freeze it; it is
 * never shown in the composer or included in a turn until pinned. `pinned`
 * holds selections the user froze via ⇧⌘L / ⌘K / Add to chat. Never persisted —
 * selections are ephemeral and consumed by the next submitted turn.
 *
 * PDF selections may carry page geometry (`rects` + `paperAbsPath`) so a
 * submitted Agent turn can insert a conversation card (`kind: ask`) pin at
 * the selection — not a visual-annotation / agent-trace mark.
 */

import { createStore } from "zustand/vanilla";
import { stripSystemReminder } from "@/lib/agent/prompt-display";
import { toVaultRelative } from "@/lib/core/path";
import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";
import { vaultStore } from "@/lib/vault/store";
import { normalizeQuoteContext, type QuoteContext } from "./selection-context";

export type SelectionOrigin = "pdf" | "markdown" | "chat";

export type SelectionContext = {
	id: string;
	text: string;
	/** Vault-relative source path when the file lives inside the Vault. */
	sourcePath: string;
	/** Display provenance for reading surfaces without a Vault file. */
	sourceTitle?: string;
	sourceUrl?: string;
	/** Rendering surface, independent of the anchor/storage origin. */
	surface?: "feed" | "web" | "abstract" | "text" | "markdown" | "chat";
	origin: SelectionOrigin;
	/** 1-based PDF page number. */
	page?: number;
	/** 1-based first/last selected line (code-editor selections). */
	lineFrom?: number;
	lineTo?: number;
	/**
	 * Page-normalized selection rects (PDF only). Present when the selection
	 * came from a PDF viewer that knows anchor geometry — used to place a
	 * conversation pin after the Agent turn that consumes this chip.
	 */
	rects?: PdfVisualNormalizedRect[];
	/** Absolute paper folder for mark writes (PDF only). */
	paperAbsPath?: string;
	/** Optional instruction attached to this quote, not to the whole turn. */
	comment?: string;
	/** Source message within a chat conversation. */
	messageId?: string;
	/** Durable provider conversation identity when available. */
	chatSessionId?: string;
	/** Text and neighbors let a reopened surface locate the quote without choosing an ambiguous match. */
	textAnchor?: { exact: string; prefix: string; suffix: string };
	context?: QuoteContext;
	pinned: boolean;
};

type SelectionStore = {
	active: SelectionContext | null;
	pinned: SelectionContext[];
};

const MAX_SELECTION_CHARS = 4000;
const MAX_PINNED = 4;

export const selectionStore = createStore<SelectionStore>(() => ({
	active: null,
	pinned: [],
}));

export type SelectionInput = Omit<SelectionContext, "id" | "pinned">;
export type PublishSelectionInput = SelectionInput;

/** Freeze provenance before focus changes or a PDF selection is cleared. */
export function createSelectionContext(
	input: SelectionInput,
): SelectionContext | null {
	const text = stripSystemReminder(input.text.trim())
		.trim()
		.slice(0, MAX_SELECTION_CHARS);
	if (!text) return null;
	return {
		...input,
		id: `sel-${crypto.randomUUID()}`,
		text,
		sourcePath:
			input.origin === "chat"
				? input.sourcePath
				: toVaultRelative(vaultStore.getState().vaultPath, input.sourcePath),
		context: normalizeQuoteContext(input.context),
		comment: input.comment?.trim() || undefined,
		paperAbsPath: input.paperAbsPath?.trim() || undefined,
		rects: input.rects?.map((r) => ({ ...r })),
		pinned: false,
	};
}

/** Replace the live selection chip (empty text clears it instead). */
export function publishSelection(input: SelectionInput): void {
	const active = createSelectionContext(input);
	if (!active) {
		clearActiveSelection(input.origin);
		return;
	}
	selectionStore.setState({ active });
}

/**
 * PDF selections that carry enough geometry to leave an ask conversation
 * card pin (page + rects + absolute paper folder).
 */
export function selectionsWithPdfAnchor(selections: SelectionContext[]): Array<
	SelectionContext & {
		page: number;
		rects: PdfVisualNormalizedRect[];
		paperAbsPath: string;
	}
> {
	const out: Array<
		SelectionContext & {
			page: number;
			rects: PdfVisualNormalizedRect[];
			paperAbsPath: string;
		}
	> = [];
	for (const sel of selections) {
		if (sel.origin !== "pdf") continue;
		const page = sel.page;
		const rects = sel.rects;
		const paperAbsPath = sel.paperAbsPath?.trim();
		if (
			page == null ||
			!Number.isFinite(page) ||
			!rects?.length ||
			!paperAbsPath
		) {
			continue;
		}
		out.push({
			...sel,
			page: Math.max(1, Math.floor(page)),
			rects: rects.map((r) => ({ ...r })),
			paperAbsPath,
		});
	}
	return out;
}

/** Drop the live selection (optionally only when it came from `origin`). */
export function clearActiveSelection(origin?: SelectionOrigin): void {
	const active = selectionStore.getState().active;
	if (!active) return;
	if (origin && active.origin !== origin) return;
	selectionStore.setState({ active: null });
}

/** Freeze the live selection as a pinned chip. Returns false when there is none. */
export function pinActiveSelection(): boolean {
	const { active } = selectionStore.getState();
	if (!active) return false;
	pinSelection(active);
	return true;
}

/** Pin a captured quote even after focus has cleared/replaced the live selection. */
export function pinSelection(active: SelectionContext): void {
	const { pinned } = selectionStore.getState();
	const deduped = pinned.filter(
		(item) =>
			item.text !== active.text ||
			item.sourcePath !== active.sourcePath ||
			item.origin !== active.origin ||
			item.page !== active.page ||
			item.lineFrom !== active.lineFrom ||
			item.lineTo !== active.lineTo ||
			item.messageId !== active.messageId ||
			item.comment !== active.comment,
	);
	selectionStore.setState({
		active: null,
		pinned: [...deduped, { ...active, pinned: true }].slice(-MAX_PINNED),
	});
}

/** Remove one chip (live or pinned) by id. */
export function removeSelection(id: string): void {
	const { active, pinned } = selectionStore.getState();
	if (active?.id === id) {
		selectionStore.setState({ active: null });
		return;
	}
	selectionStore.setState({ pinned: pinned.filter((item) => item.id !== id) });
}

/** Snapshot pinned chips for a turn (live `active` is staging-only, not sent). */
export function currentSelections(): SelectionContext[] {
	return selectionStore.getState().pinned;
}

/** Snapshot pinned chips and clear active + pinned after a submitted turn. */
export function consumeSelections(): SelectionContext[] {
	const { active, pinned } = selectionStore.getState();
	const all = pinned;
	if (active || all.length)
		selectionStore.setState({ active: null, pinned: [] });
	return all;
}

/** Drop every selection chip without returning them (e.g. vault switch). */
export function clearSelections(): void {
	const { active, pinned } = selectionStore.getState();
	if (!active && pinned.length === 0) return;
	selectionStore.setState({ active: null, pinned: [] });
}
