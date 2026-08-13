/**
 * In-app file-tree drag session. Composer image overlay and Library PDF
 * import must ignore this so a `.md` vault move is not stolen.
 *
 * Flag is set on tree dragstart and cleared on dragend / drop. A custom MIME
 * is also written on the DataTransfer so `types` is visible during dragover
 * even when `getData` is empty.
 */

export const VAULT_FILE_DRAG_TYPE = "application/x-agentero-vault-paths";

let active = false;
let endBound = false;

function onGlobalEnd(): void {
	active = false;
}

function bindGlobalEnd(): void {
	if (endBound || typeof window === "undefined") return;
	window.addEventListener("dragend", onGlobalEnd);
	window.addEventListener("drop", onGlobalEnd, true);
	endBound = true;
}

export function beginVaultFileDrag(): void {
	active = true;
	bindGlobalEnd();
}

export function endVaultFileDrag(): void {
	active = false;
}

export function isVaultFileDragActive(): boolean {
	return active;
}
