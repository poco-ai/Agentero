/**
 * Shared external-link targets for a paper.
 *
 * The Paper Info sidebar chips and the path-bar "Open links" menu must agree
 * on which services a paper exposes and which URL each one points at; this is
 * the single place that derives them from `PaperMetadata`.
 */

import { normalizeDoi } from "@/lib/bibtex";
import type { PaperMetadata } from "@/lib/paper";
import { arxivUrls, isArxivHostedUrl } from "@/lib/paper/arxiv";

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

/** Recover the forum link from a paper's OpenReview landing page or PDF. */
export function openReviewSourceHref(value?: string | null): string | null {
	const href = openreviewHref(value);
	if (!href) return null;
	const url = new URL(href);
	if (
		url.protocol !== "https:" ||
		(url.hostname !== "openreview.net" &&
			!url.hostname.endsWith(".openreview.net"))
	)
		return null;
	const id = url.searchParams.get("id");
	if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
	if (
		!["/forum", "/pdf", "/attachment", "/notes/edits/attachment"].includes(
			url.pathname,
		)
	) {
		return null;
	}
	return `https://openreview.net/forum?id=${id}`;
}

export type PaperLinkTargets = {
	/** Normalized arXiv id, when known. */
	arxivId: string | null;
	/** Normalized DOI, when known. */
	doi: string | null;
	/** arXiv chip target: prefer the stored PDF when arXiv hosts it. */
	arxivUrl: string | null;
	htmlUrl: string | null;
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
	const arxiv = meta?.arxiv_id ? arxivUrls(meta.arxiv_id) : null;
	const arxivId = arxiv?.id ?? null;
	const html = openReviewSourceHref(meta?.html_url)
		? null
		: openreviewHref(meta?.html_url);
	const doi = normalizeDoi(meta?.doi ?? undefined);
	const pdfUrl = meta?.pdf_url?.trim() || null;
	const codeRepo = meta?.code_repo?.trim();
	return {
		arxivId,
		doi,
		arxivUrl: arxiv
			? pdfUrl && isArxivHostedUrl(pdfUrl)
				? pdfUrl
				: arxiv.pdf
			: null,
		htmlUrl: html ?? arxiv?.html ?? null,
		doiUrl: doi ? `https://doi.org/${doi}` : null,
		pdfUrl,
		alphaXivUrl: arxivId ? `https://www.alphaxiv.org/abs/${arxivId}` : null,
		modelScopeUrl: arxivId
			? `https://modelscope.cn/papers/${arxivId}/overview`
			: null,
		huggingFaceUrl: arxivId ? `https://huggingface.co/papers/${arxivId}` : null,
		codeRepoUrl: codeRepo ? repoHref(codeRepo) : null,
		openreviewUrl:
			openreviewHref(meta?.openreview_url) ??
			openReviewSourceHref(meta?.source_url) ??
			openReviewSourceHref(meta?.html_url) ??
			openReviewSourceHref(meta?.pdf_url),
	};
}
