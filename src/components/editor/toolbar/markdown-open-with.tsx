import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { OpenWithMenu } from "@/components/workspace/open-with-menu";
import { isTauri } from "@/lib/core/tauri";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { useWikiNav } from "@/lib/wiki/nav-context";

/**
 * Same "Open with" split control the paper PDF path bar shows, for a plain
 * Markdown note: the left half reveals the note in the file manager, the
 * chevron lists the file manager, installed editors and the preferred terminal.
 * A note has no paper metadata, so the menu's external-link group stays empty.
 *
 * Only local files can be opened by the Host: remote vaults and virtual
 * `agentero:` documents leave the slot empty.
 */
export function noteShowsOpenWith(
	filePath: string | null | undefined,
	vaultPath: string | null | undefined,
): boolean {
	if (!filePath || !isTauri()) return false;
	if (filePath.startsWith("agentero:")) return false;
	// Remote notes live under a joined `remote:` path; the vault root is the
	// handle. Either signal means the Host cannot open the file.
	return !isRemoteVaultHandle(vaultPath) && !isRemoteVaultHandle(filePath);
}

/** Contextual "Open with" control for the note editor's top-right slot. */
export function MarkdownOpenWithButton() {
	const { filePath } = useMarkdownDoc();
	const vaultPath = useWikiNav()?.vaultPath ?? null;
	if (!filePath || !noteShowsOpenWith(filePath, vaultPath)) return null;
	return <OpenWithMenu path={filePath} meta={null} htmlUrl={null} />;
}
