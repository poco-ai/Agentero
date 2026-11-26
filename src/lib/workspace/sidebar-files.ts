import { lstat, stat } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { commands, type HtmlPreviewGrant } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { normalizeLocalPath, normalizePath } from "@/lib/core/path";
import { paperDirFromPath } from "@/lib/paper/detect";
import { findLocalPdfPath } from "@/lib/paper/media";
import { notesPathForPaper } from "@/lib/paper/paths";
import { readVaultBytes, readVaultFile } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { isMarkdownPath } from "@/lib/vault/path-kinds";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { ensureLocalFsScope } from "@/lib/vault/scope";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { isPathMissingError } from "@/lib/vault/tree";
import { getActiveTab } from "@/lib/workspace/store";
import { isHtmlPath } from "@/lib/workspace/viewer";

export type SidebarFileData = {
	pdfBytes?: ArrayBuffer;
	markdown?: string;
	htmlGrant?: HtmlPreviewGrant;
};

export type SidebarFileTarget = {
	kind: "pdf" | "notes" | "html";
	vaultRelPath: string;
};

export function sidebarVaultRelative(
	vault: string,
	path: string,
): string | null {
	const root = normalizePath(vault);
	let relative = normalizePath(path);
	if (
		relative.startsWith("/") ||
		/^[a-z]:\//i.test(relative) ||
		relative.startsWith("remote:")
	) {
		const prefix = `${root}/`;
		const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
		if (
			!(windows
				? relative.toLowerCase().startsWith(prefix.toLowerCase())
				: relative.startsWith(prefix))
		)
			return null;
		relative = relative.slice(prefix.length);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.includes("\0"))
		return null;
	const parts: string[] = [];
	for (const part of relative.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/") || null;
}

export function sidebarFileTarget(
	vault: string,
	path: string,
): SidebarFileTarget | null {
	const vaultRelPath = sidebarVaultRelative(vault, path);
	if (!vaultRelPath) return null;
	if (/\.pdf$/i.test(vaultRelPath)) return { kind: "pdf", vaultRelPath };
	if (isHtmlPath(vaultRelPath)) return { kind: "html", vaultRelPath };
	if (isMarkdownPath(vaultRelPath)) return { kind: "notes", vaultRelPath };
	return null;
}

export function currentSidebarPaperNotes(pdfPath?: string): string | undefined {
	const vault = getVaultPath();
	if (!vault) return;
	const active = getActiveTab();
	const path = pdfPath
		? joinVaultPath(vault, pdfPath)
		: active?.mode === "pdf" || active?.mode === "translation"
			? active.path
			: null;
	if (!path) return;
	const paper = paperDirFromPath(path, vaultStore.getState().paperFolders);
	const notes =
		(pdfPath ? null : active?.notesPath) ??
		(paper ? notesPathForPaper(paper) : null);
	return notes ? (sidebarVaultRelative(vault, notes) ?? undefined) : undefined;
}

export async function sidebarPaperPdf(
	vault: string,
	paperPath: string,
): Promise<SidebarFileTarget | null> {
	const relative = sidebarVaultRelative(vault, paperPath);
	if (!relative) return null;
	await ensureLocalFsScope(vault);
	const pdf = await findLocalPdfPath(joinVaultPath(vault, relative));
	return pdf ? sidebarFileTarget(vault, pdf) : null;
}

export async function sidebarPdfPageCount(
	content: ArrayBuffer,
): Promise<number> {
	const { withBackgroundPdfDocument } = await import(
		"@/lib/pdf/background-engine"
	);
	return withBackgroundPdfDocument(
		{ id: crypto.randomUUID(), content: content.slice(0) },
		undefined,
		async (_engine, document) => document.pageCount,
	);
}

export async function restoreSidebarFile(
	vault: string,
	target: SidebarFileTarget,
): Promise<SidebarFileTarget | null> {
	const normalized = sidebarFileTarget(vault, target.vaultRelPath);
	if (normalized?.kind !== target.kind) return null;
	const path = joinVaultPath(vault, normalized.vaultRelPath);
	if (isRemoteVaultHandle(vault)) return normalized;
	try {
		await ensureLocalFsScope(vault);
		const exists = (await stat(normalizeLocalPath(path))).isFile;
		return exists ? normalized : null;
	} catch (error) {
		return isPathMissingError(error) ? null : normalized;
	}
}

export async function readSidebarFile(
	vault: string,
	target: SidebarFileTarget,
): Promise<SidebarFileData> {
	const normalized = sidebarFileTarget(vault, target.vaultRelPath);
	if (normalized?.kind !== target.kind)
		throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
	const path = joinVaultPath(vault, normalized.vaultRelPath);
	await ensureLocalFsScope(vault);
	if (target.kind !== "html" && !isRemoteVaultHandle(vault)) {
		let entry = vault;
		for (const segment of normalized.vaultRelPath.split("/")) {
			entry = joinVaultPath(entry, segment);
			if ((await lstat(normalizeLocalPath(entry))).isSymlink) {
				throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
			}
		}
	}
	switch (target.kind) {
		case "html":
			return {
				htmlGrant: await callApiResult(() =>
					commands.htmlPreviewGrant({ path }),
				),
			};
		case "notes":
			return { markdown: await readVaultFile(path) };
		case "pdf": {
			const bytes = await readVaultBytes(path);
			const buffer = bytes.buffer;
			return {
				pdfBytes:
					buffer instanceof ArrayBuffer &&
					bytes.byteLength === buffer.byteLength
						? buffer
						: new Uint8Array(bytes).buffer,
			};
		}
	}
}
