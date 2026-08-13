/**
 * OS file drops on the webview. `dragDropEnabled: false` so HTML5 DnD
 * stays available (Windows WebView2 otherwise swallows it). Path-less
 * File bytes are staged via Host `paper_stage_import_file` into
 * `~/.agentero/import-tmp/`. Tauri `onDragDropEvent` is a no-op extra
 * if a platform still emits it.
 *
 * Without preventDefault, dropping a PDF can navigate the webview to the
 * native viewer and freeze the SPA.
 */

import {
	dataTransferLooksLikeOsFiles,
	hasPdfExtension,
} from "@/lib/core/file-accept";
import { invokeApi } from "@/lib/core/ipc";
import { basenameOf } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";

/** A dropped PDF ready for the confirm dialog / import host. */
export type ResolvedDropPdf = {
	/** Absolute path to read (native or staging). */
	path: string;
	/** Original filename for title/id defaults (e.g. `Attention.pdf`). */
	sourceName: string;
};

/** True when the drag payload includes OS files (not in-app text/plain moves). */
export function dataTransferHasFiles(dt: DataTransfer | null): boolean {
	return dataTransferLooksLikeOsFiles(dt);
}

export function isPdfFileName(name: string): boolean {
	return hasPdfExtension(name);
}

/** Absolute paths for local files in a Drop/Drag event, when the host exposes them. */
export function pathsFromDataTransfer(dt: DataTransfer | null): string[] {
	if (!dt) return [];
	const out: string[] = [];
	const seen = new Set<string>();

	const push = (raw: string) => {
		const p = normalizeDroppedPath(raw);
		if (!p || seen.has(p)) return;
		seen.add(p);
		out.push(p);
	};

	// Desktop webviews sometimes put the absolute path on File (not WKWebView).
	const files = collectFiles(dt);
	for (const file of files) {
		const f = file as File & { path?: string };
		if (typeof f.path === "string" && f.path.trim()) push(f.path);
	}

	// Some platforms expose file:// lines (often empty on macOS drop).
	for (const type of ["text/uri-list", "text/plain"] as const) {
		if (![...dt.types].includes(type)) continue;
		let text = "";
		try {
			text = dt.getData(type);
		} catch {
			// ignore
		}
		if (!text) continue;
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			push(trimmed);
		}
	}

	return out;
}

/** PDF absolute paths only from path metadata (no File byte materialization). */
export function pdfPathsFromDataTransfer(dt: DataTransfer | null): string[] {
	return pathsFromDataTransfer(dt).filter((p) =>
		isPdfFileName(p.replace(/[\\/]+$/, "")),
	);
}

/**
 * Prefer `DataTransferItemList` then `FileList` — on some WebViews one is empty.
 */
function collectFiles(dt: DataTransfer): File[] {
	const out: File[] = [];
	const seen = new Set<string>();

	const push = (file: File | null) => {
		if (!file) return;
		// Dedupe by name+size+lastModified when path is missing.
		const key = `${file.name}\0${file.size}\0${file.lastModified}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(file);
	};

	try {
		if (dt.items?.length) {
			for (let i = 0; i < dt.items.length; i++) {
				const item = dt.items[i];
				if (item?.kind === "file") push(item.getAsFile());
			}
		}
	} catch {
		// ignore
	}

	try {
		if (dt.files?.length) {
			for (let i = 0; i < dt.files.length; i++) {
				push(dt.files.item(i) ?? dt.files[i] ?? null);
			}
		}
	} catch {
		// ignore
	}

	return out;
}

/**
 * Snapshot everything we need from a drop **synchronously** during the drop
 * handler. Starts `arrayBuffer()` immediately so the read is claimed before
 * WKWebView revokes access. Prefer `nativeEvent.dataTransfer` when available.
 */
export type DroppedFileSnapshot = {
	/** Absolute path when the host exposes `File.path`. */
	path: string | null;
	name: string;
	type: string;
	size: number;
	/** In-flight read started during the drop event. */
	bytesPromise: Promise<ArrayBuffer> | null;
};

export function snapshotDataTransfer(dt: DataTransfer | null): {
	paths: string[];
	files: DroppedFileSnapshot[];
} {
	if (!dt) return { paths: [], files: [] };

	// getData must run synchronously in the drop handler.
	const paths = pathsFromDataTransfer(dt);

	const files: DroppedFileSnapshot[] = [];
	for (const file of collectFiles(dt)) {
		const native = (file as File & { path?: string }).path?.trim() || null;
		// Kick off the read immediately — critical on WKWebView.
		let bytesPromise: Promise<ArrayBuffer> | null = null;
		try {
			bytesPromise = file.arrayBuffer();
		} catch {
			bytesPromise = null;
		}
		files.push({
			path: native ? normalizeDroppedPath(native) : null,
			name: file.name || "",
			type: file.type || "",
			size: file.size || 0,
			bytesPromise,
		});
	}

	return { paths, files };
}

/**
 * Resolve absolute paths for dropped PDFs from a **snapshot** taken in the
 * drop handler (see `snapshotDataTransfer`).
 * 1) Prefer absolute path metadata.
 * 2) Else stage File bytes via Host into `~/.agentero/import-tmp/`.
 */
export async function resolveDroppedPdfPaths(
	dtOrSnapshot: DataTransfer | null | ReturnType<typeof snapshotDataTransfer>,
): Promise<ResolvedDropPdf[]> {
	const snap =
		dtOrSnapshot && "files" in dtOrSnapshot && !("types" in dtOrSnapshot)
			? (dtOrSnapshot as ReturnType<typeof snapshotDataTransfer>)
			: snapshotDataTransfer(dtOrSnapshot as DataTransfer | null);

	const out: ResolvedDropPdf[] = [];
	const seen = new Set<string>();
	const errors: string[] = [];

	const push = (path: string, sourceName: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		out.push({ path, sourceName: sourceName || basenameOf(path) });
	};

	// Path metadata first (when the webview exposes it).
	for (const p of snap.paths) {
		if (isPdfFileName(p.replace(/[\\/]+$/, ""))) {
			push(p, basenameOf(p));
		}
	}
	if (out.length) return out;

	const pdfFiles = snap.files.filter(
		(f) =>
			f.type === "application/pdf" ||
			isPdfFileName(f.name) ||
			(f.path != null && isPdfFileName(f.path)),
	);

	// If we only got non-PDF names but have a single file drop, still try
	// (some WebViews omit extension / type on drop).
	const candidates =
		pdfFiles.length > 0 ? pdfFiles : snap.files.length === 1 ? snap.files : [];

	if (!candidates.length) {
		if (snap.files.length > 0) {
			throw new Error(
				`dropped ${snap.files.length} file(s) but none look like PDF (${snap.files.map((f) => f.name || f.type || "?").join(", ")})`,
			);
		}
		throw new Error(
			"drop payload had no file bytes (WebView did not expose FileList)",
		);
	}

	for (const entry of candidates) {
		if (entry.path) {
			push(entry.path, entry.name || basenameOf(entry.path));
			continue;
		}

		if (!isTauri() || !entry.bytesPromise) {
			errors.push(entry.name || "file");
			continue;
		}
		try {
			const buf = await entry.bytesPromise;
			const staged = await stageImportBytes(
				entry.name || "drop.pdf",
				new Uint8Array(buf),
			);
			push(staged, entry.name || basenameOf(staged));
		} catch (e) {
			errors.push(
				`${entry.name || "file"}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	if (!out.length) {
		throw new Error(
			errors.length
				? `could not stage PDF: ${errors.slice(0, 2).join("; ")}`
				: "could not stage dropped PDF",
		);
	}

	return out;
}

/** Whether a path looks like our drop materialization staging area. */
export function isImportTempPath(path: string): boolean {
	const n = path.replace(/\\/g, "/");
	return n.includes("/.agentero/import-tmp/");
}

/**
 * Best-effort cleanup of staging files after import.
 * Only deletes paths under `~/.agentero/import-tmp/`.
 */
export async function cleanupImportTempPaths(paths: string[]): Promise<void> {
	if (!isTauri() || !paths.length) return;
	try {
		const { remove } = await import("@tauri-apps/plugin-fs");
		for (const p of paths) {
			if (!isImportTempPath(p)) continue;
			try {
				await remove(p);
			} catch {
				// ignore missing / locked
			}
		}
	} catch {
		// plugin unavailable
	}
}

/** Host write — no plugin-fs scope issues; works for path-less drops. */
async function stageImportBytes(
	fileName: string,
	bytes: Uint8Array,
): Promise<string> {
	const contentBase64 = uint8ToBase64(bytes);
	const result = await invokeApi<{ path: string }>("paper_stage_import_file", {
		args: {
			fileName: fileName || "drop.pdf",
			contentBase64,
		},
	});
	if (!result.path) {
		throw new Error("stage import failed");
	}
	return result.path;
}

/** Chunked btoa for large ArrayBuffers (avoids call-stack limits). */
function uint8ToBase64(bytes: Uint8Array): string {
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		const slice = bytes.subarray(i, i + chunk);
		binary += String.fromCharCode.apply(null, slice as unknown as number[]);
	}
	return btoa(binary);
}

function normalizeDroppedPath(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	if (/^file:\/\//i.test(s)) {
		try {
			const u = new URL(s);
			// file:///Users/a/b.pdf → /Users/a/b.pdf; Windows file:///C:/… → C:/…
			let path = decodeURIComponent(u.pathname);
			if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
			return path || null;
		} catch {
			return null;
		}
	}
	// Absolute local paths only — ignore http(s) and relative junk.
	if (/^https?:\/\//i.test(s)) return null;
	// Unify separators so `C:\a\b.pdf` (File.path / text/plain) dedupes against
	// `C:/a/b.pdf` from file:// URIs — Windows drops carry both forms.
	if (s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s))
		return s.replace(/\\/g, "/");
	return null;
}
