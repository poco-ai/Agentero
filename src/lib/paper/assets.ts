export const PAPER_FILE_MARKERS = [
	"NOTES.md",
	"PAPER.md",
	"metadata.json",
] as const;

/** Direct-child directory names that mark a paper folder. */
export const PAPER_DIR_MARKERS = ["source", "assets", "marks"] as const;

const PDF_NAME_RE = /\.pdf$/i;
const TEX_NAME_RE = /\.(tex|ltx)$/i;
const PAPER_MD_RE = /^paper\.md$/i;

type TreeWalkNode = {
	name: string;
	kind?: string;
	path?: string;
	children?: Array<{
		name: string;
		kind?: string;
		path?: string;
		children?: unknown[];
	}>;
};

/** Walk tree node names for a matching extension. */
function treeHasFileExt(node: TreeWalkNode, re: RegExp): boolean {
	if (node.kind !== "directory" && re.test(node.name)) return true;
	for (const child of node.children ?? []) {
		if (treeHasFileExt(child as TreeWalkNode, re)) return true;
	}
	return false;
}

export function paperHasLocalPdf(node: TreeWalkNode): boolean {
	return treeHasFileExt(node, PDF_NAME_RE);
}

export function paperHasLocalTex(node: TreeWalkNode): boolean {
	return treeHasFileExt(node, TEX_NAME_RE);
}

/** True when the paper folder has a direct-child `PAPER.md` (any depth name match). */
export function paperHasLocalPaperMd(node: TreeWalkNode): boolean {
	if (node.kind !== "directory" && PAPER_MD_RE.test(node.name)) return true;
	for (const child of node.children ?? []) {
		if (paperHasLocalPaperMd(child as TreeWalkNode)) return true;
	}
	return false;
}

/**
 * Reasons a paper row should show the Download icon (for hover tooltip).
 * Keys are i18n suffixes under `sidebar:fileTree.downloadReason.*`.
 *
 * Readable body: **TeX OR PAPER.md** is enough (prefer TeX — if TeX exists, PAPER.md is not required).
 */
export type PaperDownloadReason = "noPdf" | "noBody";

/**
 * Missing local assets that warrant a Download control:
 * - no PDF (at paper folder root or nested), or
 * - no TeX **and** no `PAPER.md` (either body form is sufficient; TeX preferred)
 *
 * Click: download PDF to paper folder root; arXiv TeX into `source/`; if no TeX → liteparse PAPER.md.
 * Note: `source/` is only required for TeX archives — PDF alone does not require `source/`.
 *
 * `meta` is optional catalog metadata. When present, its `body_source` field
 * overrides the file-tree scan: `source/` is lazy‑loaded so TeX files inside it
 * are never visible to `paperHasLocalTex`.
 */
export function paperAssetDownloadReasons(
	node: TreeWalkNode,
	meta?: { body_source?: string } | null,
): PaperDownloadReason[] {
	const reasons: PaperDownloadReason[] = [];
	if (!paperHasLocalPdf(node)) reasons.push("noPdf");
	// Body: trust catalog body_source when set (source/ is lazy‑loaded).
	const bodyKnown = meta?.body_source != null && meta.body_source !== "";
	if (!bodyKnown && !paperHasLocalTex(node) && !paperHasLocalPaperMd(node)) {
		reasons.push("noBody");
	}
	return reasons;
}

/** Show file-tree Download when PDF / source / readable body is incomplete. */
export function paperNeedsAssetDownload(
	node: TreeWalkNode,
	meta?: { body_source?: string } | null,
): boolean {
	return paperAssetDownloadReasons(node, meta).length > 0;
}

/**
 * Local assets are complete enough for reading / paper-reader:
 * PDF present, and TeX or PAPER.md as readable body.
 */
export function paperAssetsComplete(
	node: TreeWalkNode,
	meta?: { body_source?: string } | null,
): boolean {
	return paperAssetDownloadReasons(node, meta).length === 0;
}

/**
 * Show file-tree Zap when assets are complete and catalog says not yet read.
 */
export function paperNeedsRead(
	node: TreeWalkNode,
	meta: { is_read?: boolean; body_source?: string } | null | undefined,
): boolean {
	if (!paperAssetsComplete(node, meta)) return false;
	return !(meta?.is_read === true);
}
