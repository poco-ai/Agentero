import {
	commands,
	type PaperRecord_Serialize as PaperRecordWire,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { toVaultRelative } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { arxivUrls } from "@/lib/paper/arxiv";
import { adoptLibraryCodeRepo } from "@/lib/paper/library-store";
import type { PaperMetadata } from "@/lib/paper/types";
import { paperFromWire } from "@/lib/paper/wire";

function enrichArxivUrls(data: PaperMetadata): PaperMetadata {
	if (!data.arxiv_id) return data;
	const urls = arxivUrls(data.arxiv_id);
	if (!urls) return data;
	if (!data.pdf_url) data.pdf_url = urls.pdf;
	if (!data.html_url) data.html_url = urls.html;
	if (!data.source_url) data.source_url = urls.abs;
	return data;
}

/**
 * Vault-relative paper folder path for catalog APIs.
 */
export function paperCatalogPath(
	paperDir: string,
	vaultRoot?: string | null,
): string | undefined {
	if (!vaultRoot) return undefined;
	const path = toVaultRelative(vaultRoot, paperDir)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!path || path === ".") return undefined;
	return path;
}

export type PaperOpenBundle = {
	paper: PaperMetadata;
	pathRel: string;
	pdfPath?: string;
	hasTex: boolean;
	hasPaperMd: boolean;
};

/**
 * Bundle local paper-open data from Host in one round trip.
 * Remote vaults intentionally fall back to existing remote helpers.
 */
export async function loadPaperOpenBundle(
	paperDir: string,
	vaultRoot?: string | null,
): Promise<PaperOpenBundle | null> {
	const path = paperCatalogPath(paperDir, vaultRoot);
	if (!isTauri() || !vaultRoot || !path) return null;
	try {
		const { isRemoteVaultHandle } = await import(
			"@/lib/vault/remote/remote-vault"
		);
		if (isRemoteVaultHandle(vaultRoot)) return null;
		void callApiResult(() =>
			commands.jobFocusPaper({ vaultPath: vaultRoot, path }),
		).catch(() => undefined);
		const data = await callApiResult(() =>
			commands.paperOpenBundle({ vaultPath: vaultRoot, path }),
		);
		if (!data?.paper?.id) return null;
		const paper = enrichArxivUrls(paperFromWire(data.paper));
		adoptLibraryCodeRepo(paper);
		return {
			paper,
			pathRel: data.pathRel,
			pdfPath: data.pdfPath ?? undefined,
			hasTex: data.hasTex,
			hasPaperMd: data.hasPaperMd,
		};
	} catch {
		return null;
	}
}

/**
 * Load paper metadata from catalog.sqlite via Host `paper_get`.
 *
 * Always sets `path` (vault-relative) when `vaultRoot` is known.
 *
 * @param paperDir absolute paper folder path
 * @param vaultRoot absolute vault root (needed for catalog lookup)
 */
export async function loadPaperMetadata(
	paperDir: string,
	vaultRoot?: string | null,
): Promise<PaperMetadata | null> {
	const path = paperCatalogPath(paperDir, vaultRoot);
	if (!isTauri() || !vaultRoot || !path) return null;

	// Primary: SQLite catalog (local vault path or remote work mirror)
	try {
		const { isRemoteVaultHandle, remotePaperGet, remoteSessionIdFromHandle } =
			await import("@/lib/vault/remote/remote-vault");
		let record: PaperRecordWire | null = null;
		if (isRemoteVaultHandle(vaultRoot)) {
			const sessionId = remoteSessionIdFromHandle(vaultRoot);
			if (sessionId) {
				record = (await remotePaperGet(sessionId, {
					path,
				})) as PaperRecordWire;
			}
		} else {
			record = await callApi(() =>
				commands.paperGet({ vaultPath: vaultRoot, path }),
			);
		}
		if (record?.id) {
			return enrichArxivUrls(paperFromWire(record));
		}
	} catch {
		// catalog miss or Host error
	}
	return null;
}

/**
 * Async paper-folder check when tree children are unavailable
 * (graph navigation, session restore). Probes marker files on disk.
 */
