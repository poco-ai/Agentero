import { readDir, readFile } from "@tauri-apps/plugin-fs";
import { arxivUrls } from "@/lib/arxiv";
import {
	isPapersRoot,
	isUnderPapers,
	metadataPathForPaper,
	notesPathForPaper,
} from "@/lib/paper-metadata/detect";
import {
	type PaperMetadata,
	withNormalizedTags,
} from "@/lib/paper-metadata/types";
import { isTauri } from "@/lib/tauri";
import { readVaultFile } from "@/lib/vault";
import { toVaultRelative } from "@/lib/wiki";

const PDF_NAME_RE = /\.pdf$/i;

/** Accept only remote http(s) URLs (catalog fields / arxiv-derived). */
export function resolveRemoteUrl(
	ref: string | undefined | null,
): string | null {
	if (!ref?.trim()) return null;
	const value = ref.trim();
	if (/^https?:\/\//i.test(value)) return value;
	return null;
}

/** True when a string can be passed to PDF.js `Document` `file`. */
export function isPdfViewerSource(
	source: string | null | undefined,
): source is string {
	if (!source?.trim()) return false;
	const s = source.trim();
	// blob: (local bytes) or remote https — not asset:// (PDF.js XHR fails on asset protocol)
	if (/^(https?|blob):/i.test(s)) return true;
	return false;
}

/**
 * Read a local file into a `blob:` URL for in-app viewers (PDF.js, img tags).
 *
 * Prefer this over `convertFileSrc` / `asset://`: PDF.js issues range/XHR
 * requests that often fail on Tauri's asset protocol ("Unexpected server response (0)").
 * Caller should `URL.revokeObjectURL` when replacing the source.
 */
export async function localBytesToViewerSource(
	absPath: string,
	mimeType: string,
): Promise<string | null> {
	if (!isTauri() || !absPath?.trim()) return null;
	try {
		let bytes: Uint8Array;
		if (absPath.startsWith("remote:")) {
			const slash = absPath.indexOf("/", "remote:".length);
			if (slash === -1) return null;
			const handle = absPath.slice(0, slash);
			const rel = absPath.slice(slash + 1);
			const { remoteCacheFile, remoteSessionIdFromHandle } = await import(
				"@/lib/remote-vault"
			);
			const sessionId = remoteSessionIdFromHandle(handle);
			if (!sessionId) return null;
			const localPath = await remoteCacheFile(sessionId, rel);
			bytes = await readFile(localPath);
		} else {
			bytes = await readFile(absPath);
		}
		// Copy so Blob owns a stable ArrayBuffer (plugin may return a view)
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		const blob = new Blob([copy], { type: mimeType });
		return URL.createObjectURL(blob);
	} catch {
		return null;
	}
}

/**
 * Read a local PDF into a `blob:` URL for PDF.js.
 * @see localBytesToViewerSource
 */
export async function localPdfToViewerSource(
	absPath: string,
): Promise<string | null> {
	return localBytesToViewerSource(absPath, "application/pdf");
}

/**
 * Read a local image into a `blob:` URL for the image viewer.
 * MIME is inferred from the file extension.
 */
export async function localImageToViewerSource(
	absPath: string,
	mimeType: string,
): Promise<string | null> {
	return localBytesToViewerSource(absPath, mimeType);
}

/** Revoke a blob: URL created by local*ToViewerSource (no-op for others). */
export function revokePdfViewerSource(source: string | null | undefined): void {
	if (source?.startsWith("blob:")) {
		try {
			URL.revokeObjectURL(source);
		} catch {
			// ignore
		}
	}
}

function joinDir(parent: string, name: string): string {
	const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	const base = parent.replace(/[/\\]+$/, "");
	return `${base}${sep}${name}`;
}

/**
 * Find first local PDF under a paper folder.
 * Prefer root-level `*.pdf` (canonical `{id}.pdf`), then shallow recursive
 * under nested dirs (e.g. `source/`). Max depth 4.
 */
export async function findLocalPdfPath(
	paperDir: string,
): Promise<string | null> {
	if (!isTauri() || !paperDir?.trim()) return null;
	const root = paperDir.replace(/[/\\]+$/, "");
	// Remote joined path: list via Host SFTP
	if (root.startsWith("remote:")) {
		const slash = root.indexOf("/", "remote:".length);
		const handle = slash === -1 ? root : root.slice(0, slash);
		const rel = slash === -1 ? "" : root.slice(slash + 1);
		const { remoteList, remoteSessionIdFromHandle } = await import(
			"@/lib/remote-vault"
		);
		const sessionId = remoteSessionIdFromHandle(handle);
		if (!sessionId) return null;
		try {
			const entries = await remoteList(sessionId, rel);
			const pdfs = entries
				.filter((e) => e.isFile && PDF_NAME_RE.test(e.name))
				.map((e) => `${handle}/${e.path}`)
				.sort((a, b) => a.localeCompare(b));
			if (pdfs[0]) return pdfs[0];
			// shallow search source/
			const source = entries.find((e) => e.isDir && e.name === "source");
			if (source) {
				const nested = await remoteList(sessionId, source.path);
				const nestedPdf = nested
					.filter((e) => e.isFile && PDF_NAME_RE.test(e.name))
					.map((e) => `${handle}/${e.path}`)
					.sort((a, b) => a.localeCompare(b));
				return nestedPdf[0] ?? null;
			}
			return null;
		} catch {
			return null;
		}
	}
	try {
		const entries = await readDir(root);
		const rootPdfs: string[] = [];
		for (const e of entries) {
			if (!e.name || !e.isFile) continue;
			if (PDF_NAME_RE.test(e.name)) {
				rootPdfs.push(joinDir(root, e.name));
			}
		}
		if (rootPdfs.length > 0) {
			// Prefer shorter names / id-like: stable sort
			rootPdfs.sort((a, b) => a.localeCompare(b));
			return rootPdfs[0] ?? null;
		}
		return await findPdfUnder(root, 1, 4);
	} catch {
		return null;
	}
}

async function findPdfUnder(
	dir: string,
	depth: number,
	maxDepth: number,
): Promise<string | null> {
	if (depth > maxDepth) return null;
	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(dir);
	} catch {
		return null;
	}
	const subdirs: string[] = [];
	for (const e of entries) {
		if (!e.name) continue;
		if (e.name.startsWith(".")) continue;
		const full = joinDir(dir, e.name);
		if (e.isFile && PDF_NAME_RE.test(e.name)) return full;
		if (e.isDirectory) subdirs.push(full);
	}
	// Prefer source/ before other nested dirs
	subdirs.sort((a, b) => {
		const an = a.replace(/\\/g, "/").toLowerCase();
		const bn = b.replace(/\\/g, "/").toLowerCase();
		const aSrc = an.endsWith("/source") || an.includes("/source/") ? 0 : 1;
		const bSrc = bn.endsWith("/source") || bn.includes("/source/") ? 0 : 1;
		if (aSrc !== bSrc) return aSrc - bSrc;
		return an.localeCompare(bn);
	});
	for (const sub of subdirs) {
		const found = await findPdfUnder(sub, depth + 1, maxDepth);
		if (found) return found;
	}
	return null;
}

/**
 * Whether we should attempt `paper_download_assets` when local PDF is missing.
 * Needs a remote candidate (pdf_url or arxiv_id / arxiv-like folder id).
 */
export function canAttemptPdfDownload(
	meta: PaperMetadata | null,
	remotePdfUrl: string | null,
): boolean {
	if (remotePdfUrl) return true;
	if (meta?.arxiv_id?.trim()) return true;
	if (meta?.type === "arxiv") return true;
	return false;
}

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
 * `metadata.json` omits `path` (folder identity is the path); callers must re-inject it.
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

/**
 * Load paper metadata from catalog.sqlite via Host `paper_get`.
 *
 * Always sets `path` (vault-relative) when `vaultRoot` is known.
 * Projection file `metadata.json` is write-only for rescan / external tools.
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
			await import("@/lib/remote-vault");
		let data: PaperMetadata | null = null;
		if (isRemoteVaultHandle(vaultRoot)) {
			const sessionId = remoteSessionIdFromHandle(vaultRoot);
			if (sessionId) {
				data = (await remotePaperGet(sessionId, { path })) as PaperMetadata;
			}
		} else {
			const { ipc } = await import("@/lib/ipc");
			data = await ipc<PaperMetadata>("paper_get", {
				args: { vaultPath: vaultRoot, path },
			});
		}
		if (data?.id) {
			return withNormalizedTags(
				enrichArxivUrls({
					...data,
					path: data.path ?? path,
				}),
			);
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
export async function detectPaperDirectory(path: string): Promise<boolean> {
	if (!isUnderPapers(path) || isPapersRoot(path)) return false;
	try {
		await readVaultFile(notesPathForPaper(path));
		return true;
	} catch {
		// continue
	}
	try {
		await readVaultFile(metadataPathForPaper(path));
		return true;
	} catch {
		return false;
	}
}

/**
 * Remote PDF/HTML URLs from catalog metadata.
 * Prefer metadata fields; fall back to arxiv_id-derived URLs.
 * PDF remote URL is a **download candidate / fallback**, not the only preview path.
 * HTML remote URL is the iframe source.
 */
export function paperRemoteAssetsFromMetadata(meta: PaperMetadata | null): {
	pdfUrl: string | null;
	htmlUrl: string | null;
} {
	if (!meta) return { pdfUrl: null, htmlUrl: null };

	let pdfUrl = resolveRemoteUrl(meta.pdf_url);
	let htmlUrl = resolveRemoteUrl(meta.html_url);

	const arxiv = meta.arxiv_id ? arxivUrls(meta.arxiv_id) : null;
	if (!pdfUrl && arxiv) pdfUrl = arxiv.pdf;
	if (!htmlUrl && arxiv) htmlUrl = arxiv.html;

	return { pdfUrl, htmlUrl };
}
