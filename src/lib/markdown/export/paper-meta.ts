import type {
	MarkdownExportPaperHeader,
	ResolvePaperHeaderInput,
} from "@/lib/markdown/export/types";
import { arxivUrls } from "@/lib/paper/arxiv";
import type { PaperMetadata } from "@/lib/paper/types";
import { paperRelFromNotes } from "@/lib/vault/path";

/** Preferred public link for a paper (arXiv abs → DOI → source/html/pdf URL). */
export function paperShareLink(meta: PaperMetadata): {
	url: string;
	label: string;
} | null {
	if (meta.arxiv_id) {
		const urls = arxivUrls(meta.arxiv_id);
		if (urls) return { url: urls.abs, label: `arXiv:${urls.id}` };
	}
	const doi = meta.doi?.trim();
	if (doi) {
		const bare = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
		return { url: `https://doi.org/${bare}`, label: `doi:${bare}` };
	}
	for (const candidate of [meta.source_url, meta.html_url, meta.pdf_url]) {
		const url = candidate?.trim();
		if (url?.startsWith("http")) {
			try {
				const host = new URL(url).hostname.replace(/^www\./, "");
				return { url, label: host };
			} catch {
				return { url, label: url };
			}
		}
	}
	return null;
}

export function formatPaperAuthorsLine(
	authors: string[] | undefined,
	max = 6,
): string | null {
	if (!authors?.length) return null;
	if (authors.length <= max) return authors.join(", ");
	return `${authors.slice(0, max).join(", ")} et al.`;
}

/**
 * Build export header fields when the note is a paper `NOTES.md` with catalog meta.
 * Returns null for ordinary notes or unknown paper folders.
 */
export function resolveExportPaperHeader(
	input: ResolvePaperHeaderInput,
): MarkdownExportPaperHeader | null {
	const { filePath, vaultPath, paperMetaByRelPath } = input;
	if (!filePath || !vaultPath || !paperMetaByRelPath?.size) return null;
	if (!/NOTES\.md$/i.test(filePath.replace(/\\/g, "/"))) return null;

	const paperRel = paperRelFromNotes(filePath, vaultPath);
	if (!paperRel) return null;

	const meta = paperMetaByRelPath.get(paperRel);
	if (!meta?.title?.trim()) return null;

	const share = paperShareLink(meta);
	return {
		title: meta.title.trim(),
		authorsLine: formatPaperAuthorsLine(meta.authors),
		year: typeof meta.year === "number" && meta.year > 0 ? meta.year : null,
		link: share?.url ?? null,
		linkLabel: share?.label ?? null,
	};
}

/** Default download stem from file path or paper title. */
export function exportDefaultName(
	filePath: string | null,
	paperHeader: MarkdownExportPaperHeader | null,
): string {
	if (paperHeader?.title) {
		return sanitizeFilename(paperHeader.title);
	}
	if (filePath) {
		const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "note";
		return sanitizeFilename(base.replace(/\.md$/i, "") || "note");
	}
	return "note";
}

function sanitizeFilename(raw: string): string {
	const cleaned = raw
		.trim()
		// Strip characters illegal on common filesystems (incl. C0 controls).
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0 strip for filenames
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/-+/g, "-")
		.replace(/^[-.\s]+|[-.\s]+$/g, "")
		.slice(0, 120);
	return cleaned || "note";
}
