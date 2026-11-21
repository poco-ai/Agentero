/**
 * Shared external-link targets for a paper.
 *
 * The Paper Info sidebar chips and the path-bar "Open links" menu must agree
 * on which services a paper exposes and which URL each one points at; this is
 * the single place that derives them from `PaperMetadata`.
 */

import { normalizeDoi } from "@/lib/bibtex";
import type { PaperMetadata } from "@/lib/paper";
import { arxivUrls } from "@/lib/paper/arxiv";

/** `github.com/x/y` form is common when pasted; bare hosts need a scheme. */
export function repoHref(value: string): string {
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function openreviewHref(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(
			/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
		);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

export type PaperLinkTargets = {
	/** Normalized arXiv id, when known. */
	arxivId: string | null;
	/** Normalized DOI, when known. */
	doi: string | null;
	/** arXiv chip target: the paper PDF URL wins when present. */
	arxivUrl: string | null;
	doiUrl: string | null;
	pdfUrl: string | null;
	alphaXivUrl: string | null;
	modelScopeUrl: string | null;
	huggingFaceUrl: string | null;
	codeRepoUrl: string | null;
	openreviewUrl: string | null;
};

export function paperLinkTargets(
	meta: PaperMetadata | null | undefined,
): PaperLinkTargets {
	const arxivId = meta?.arxiv_id
		? (arxivUrls(meta.arxiv_id)?.id ?? null)
		: null;
	const doi = normalizeDoi(meta?.doi ?? undefined);
	const pdfUrl = meta?.pdf_url?.trim() || null;
	const codeRepo = meta?.code_repo?.trim();
	return {
		arxivId,
		doi,
		arxivUrl: arxivId ? (pdfUrl ?? arxivUrls(arxivId)?.pdf ?? null) : null,
		doiUrl: doi ? `https://doi.org/${doi}` : null,
		pdfUrl,
		alphaXivUrl: arxivId ? `https://www.alphaxiv.org/abs/${arxivId}` : null,
		modelScopeUrl: arxivId
			? `https://modelscope.cn/papers/${arxivId}/overview`
			: null,
		huggingFaceUrl: arxivId ? `https://huggingface.co/papers/${arxivId}` : null,
		codeRepoUrl: codeRepo ? repoHref(codeRepo) : null,
		openreviewUrl: openreviewHref(meta?.openreview_url),
	};
}
