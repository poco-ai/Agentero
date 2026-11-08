/**
 * Resolve which Markdown editor ⌘/ should toggle.
 *
 * The global active tab follows dockview focus. Opening a PDF citation from a
 * NOTES preview activates the paper body, so `getActiveTabId()` no longer
 * points at the Markdown editor even though the NOTES tab is still the active
 * tab of its column. Prefer the directly active editor, then the active
 * paper's NOTES companion, then the only Markdown pane still visible.
 */

import { dockHandle } from "@/lib/workspace/dock-registry";
import { getActiveTab, getActiveTabId, getTabs } from "@/lib/workspace/store";
import { findReadingCompanion } from "@/lib/workspace/tabs/notes-split";
import {
	markdownEditorFor,
	markdownEditorIds,
} from "@/lib/workspace/viewer/markdown-editor-registry";

/** Markdown editor tab id that owns the current ⌘/ target, if any. */
export function activeMarkdownEditorId(): string | null {
	const activeId = getActiveTabId();
	if (activeId && markdownEditorFor(activeId)) return activeId;

	const registered = markdownEditorIds();
	if (!registered.length) return null;

	const visible = new Set(dockHandle()?.visiblePanelIds() ?? []);
	// The paper body is active, but its NOTES tab can still be the active tab
	// of the notes column. Toggle that pane without requiring DOM focus there.
	const companion = findReadingCompanion(getTabs(), getActiveTab());
	if (
		companion &&
		markdownEditorFor(companion.id) &&
		(visible.size === 0 || visible.has(companion.id))
	) {
		return companion.id;
	}

	const visibleMarkdown = registered.filter((id) => visible.has(id));
	return visibleMarkdown.length === 1 ? (visibleMarkdown[0] ?? null) : null;
}

/** Toggle the resolved Markdown editor. False when there is no target. */
export function toggleActiveMarkdownSource(): boolean {
	const id = activeMarkdownEditorId();
	if (!id) return false;
	markdownEditorFor(id)?.toggleSource();
	return true;
}
