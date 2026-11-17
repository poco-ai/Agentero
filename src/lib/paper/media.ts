import { readDir } from "@tauri-apps/plugin-fs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { basenameOf, joinPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { arxivUrls } from "@/lib/paper/arxiv";
import type { PaperMetadata } from "@/lib/paper/types";
import { readVaultBytes, vaultPathExists } from "@/lib/vault";
import {
	parseRemoteJoinedPath,
	remoteList,
} from "@/lib/vault/remote/remote-vault";

const PDF_NAME_RE = /\.pdf$/i;

/**
 * In-process leases for `blob:` viewer URLs.
 *
 * Creating a URL takes one lease. A shallow tab copy (`cloneTabForSplit`)
 * shares that URL and must call {@link retainViewerSource} — it does not
 * call `createObjectURL` again. {@link revokePdfViewerSource} drops one
 * lease; the last holder is the one that revokes the object URL. Remote
 * `https:` sources are not tracked.
 */
const blobViewerLeases = new Map<string, number>();

function leaseViewerSource(source: string): void {
	blobViewerLeases.set(source, (blobViewerLeases.get(source) ?? 0) + 1);
}

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

async function tryReadVaultBytes(absPath: string): Promise<Uint8Array | null> {
	if (!isTauri() || !absPath?.trim()) return null;
	try {
		return await readVaultBytes(absPath);
	} catch (e) {
		// Read failed (fs scope / OneDrive placeholder / missing file). Log so the
		// silent fall back to a remote URL (which can fail CORS) is diagnosable.
		logger.warn("pdf: read local bytes failed", {
			path: absPath,
			error: errorText(e),
		});
		return null;
	}
}

/**
 * Read a local file into a `blob:` URL for in-app viewers (PDF.js, img tags).
 *
 * Prefer this over `convertFileSrc` / `asset://`: PDF.js issues range/XHR
 * requests that often fail on Tauri's asset protocol ("Unexpected server response (0)").
 * The returned `blob:` URL starts with one in-process lease. Release it with
 * {@link revokePdfViewerSource}; the object URL is revoked with the last lease.
 */
export async function localBytesToViewerSource(
	absPath: string,
	mimeType: string,
): Promise<string | null> {
	const bytes = await tryReadVaultBytes(absPath);
	if (!bytes) return null;
	const blob = new Blob([bytes], { type: mimeType });
	const url = URL.createObjectURL(blob);
	leaseViewerSource(url);
	return url;
}

/**
 * Read a local (or remote-cached) file into a standalone `ArrayBuffer`.
 *
 * Preferred over {@link localBytesToViewerSource} for the PDF engine: EmbedPDF
 * can open a document straight from a buffer, avoiding a `fetch(blob:)` step
 * that stalls/fails under some webviews (Windows WebView2; see the engine host
 * note about the wasm worker re-fetching from `blob:`). Returns null on read
 * failure (logged) so callers can fall back to a remote URL.
 */
export async function localFileToArrayBuffer(
	absPath: string,
): Promise<ArrayBuffer | null> {
	const bytes = await tryReadVaultBytes(absPath);
	if (!bytes) return null;
	// Consumers may transfer this buffer to workers, so it must be owned and
	// exactly sized. plugin-fs `readFile` already returns such a view; only
	// slice if a future plugin version ever hands back a sub-view.
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
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

/** Take another lease on an existing viewer `blob:` URL (no-op otherwise). */
export function retainViewerSource(source: string | null | undefined): void {
	if (!source?.startsWith("blob:")) return;
	leaseViewerSource(source);
}

/**
 * Drop one lease on a `blob:` URL created by local*ToViewerSource.
 *
 * Untracked blob URLs (not created here) still revoke immediately. Non-blob
 * sources are ignored.
 */
export function revokePdfViewerSource(source: string | null | undefined): void {
	if (!source?.startsWith("blob:")) return;
	const leases = blobViewerLeases.get(source);
	if (leases == null) {
		try {
			URL.revokeObjectURL(source);
		} catch {
			// ignore
		}
		return;
	}
	if (leases > 1) {
		blobViewerLeases.set(source, leases - 1);
		return;
	}
	blobViewerLeases.delete(source);
	try {
		URL.revokeObjectURL(source);
	} catch {
		// ignore
	}
}

/**
 * Layout-analysis PDF: `{paperDir}/{id}.pdf` and nothing else.
 *
 * `id` is the paper folder name. The viewer also accepts legacy root PDF
 * filenames; neither path treats a source illustration as the paper.
 */
export function canonicalPaperPdfPath(paperDir: string): string | null {
	const root = paperDir.trim().replace(/[/\\]+$/, "");
	if (!root) return null;
	const id = basenameOf(root);
	if (!id || id === "." || id === "..") return null;
	return joinPath(root, `${id}.pdf`);
}

/**
 * Resolve {@link canonicalPaperPdfPath} when the file is already on disk.
 * Returns null while the root PDF has not landed — callers should skip,
 * not search `source/assets/`.
 */
export async function findCanonicalPaperPdfPath(
	paperDir: string,
): Promise<string | null> {
	const path = canonicalPaperPdfPath(paperDir);
	if (!path || !isTauri()) return null;
	try {
		return (await vaultPathExists(path)) ? path : null;
	} catch (e) {
		logger.warn("pdf: canonical paper pdf check failed", {
			path,
			error: errorText(e),
		});
		return null;
	}
}

/**
 * Primary PDF: canonical `{id}.pdf`, then legacy root-level filenames.
 * Source illustrations and attachments never stand in for the main document.
 */
export async function findLocalPdfPath(
	paperDir: string,
): Promise<string | null> {
	if (!isTauri() || !paperDir?.trim()) return null;
	const root = paperDir.replace(/[/\\]+$/, "");
	// Remote joined path: list via Host SFTP
	const parsed = parseRemoteJoinedPath(root);
	if (parsed) {
		const { sessionId, rel } = parsed;
		const handle = `remote:${sessionId}`;
		try {
			const entries = await remoteList(sessionId, rel);
			const pdfs = entries
				.filter((e) => e.isFile && PDF_NAME_RE.test(e.name))
				.map((e) => `${handle}/${e.path}`)
				.sort((a, b) => a.localeCompare(b));
			const canonical = canonicalPaperPdfPath(root);
			return pdfs.find((path) => path === canonical) ?? pdfs[0] ?? null;
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
				rootPdfs.push(joinPath(root, e.name));
			}
		}
		if (rootPdfs.length > 0) {
			// Prefer shorter names / id-like: stable sort
			rootPdfs.sort((a, b) => a.localeCompare(b));
			return (
				rootPdfs.find((path) => path === canonicalPaperPdfPath(root)) ??
				rootPdfs[0] ??
				null
			);
		}
		return null;
	} catch (e) {
		logger.warn("pdf: list paper dir failed", {
			dir: root,
			error: errorText(e),
		});
		return null;
	}
}

/**
 * Whether we should attempt a `DownloadAssets` job when local PDF is missing.
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
	// Older webpage entries stored their URL only in source_url.
	if (!htmlUrl && meta.type === "html") {
		htmlUrl = resolveRemoteUrl(meta.source_url);
	}

	return { pdfUrl, htmlUrl };
}
