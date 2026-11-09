/** Only file-backed quotes belong in the Host's Vault context resolver. */
export function isVaultSelection(selection: {
	origin: string;
	sourcePath: string;
	sourceUrl?: string;
}): boolean {
	return (
		selection.origin !== "chat" &&
		!selection.sourceUrl &&
		!/^(?:https?:|agentero:|feed:)/i.test(selection.sourcePath)
	);
}
