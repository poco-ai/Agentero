/**
 * Open the target behind a composer mention chip.
 *
 * Clicking a chip navigates: a Vault path opens its file or paper tab, a plaza
 * entry opens the matching Plaza source (Feeds selects the item). Removal is
 * never a click — it lives on the hover card or on Backspace in the editor.
 */

import { isPlazaMentionPath } from "@/lib/agent/plaza-mention";
import { isUnderPapers } from "@/lib/paper/paths";
import { openPlazaMentionPath } from "@/lib/plaza/mention-open";
import { openFolderLibrary, openVaultRel } from "@/lib/workspace/actions";

/** Paths ending in a file extension open as a document tab. */
const FILE_OR_PAPER = /\.[a-z0-9]{1,8}$/i;

export function openMentionTarget(path: string | null | undefined): void {
	const trimmed = path?.trim() ?? "";
	if (!trimmed) return;
	if (isPlazaMentionPath(trimmed)) {
		openPlazaMentionPath(trimmed);
		return;
	}
	if (FILE_OR_PAPER.test(trimmed) || isUnderPapers(trimmed)) {
		openVaultRel(trimmed);
		return;
	}
	// Plain directory mention: scope the Library instead of opening a file.
	openFolderLibrary(trimmed);
}
