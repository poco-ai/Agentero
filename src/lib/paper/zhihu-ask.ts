/**
 * "去知乎提问" shared by the Paper Info chips and the path-bar "Open links"
 * menu: build the question draft, copy it, then open Zhihu. A desktop app
 * cannot prefill Zhihu's ask modal, so the draft lands on the clipboard.
 */

import i18n from "@/i18n";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { openExternalUrl } from "@/lib/core/open-external";
import type { PaperMetadata } from "@/lib/paper";
import { buildZhihuQuestionDraft, ZHIHU_HOME_URL } from "@/lib/zhihu";

export type ZhihuDraft = { title: string; body: string };

/** Build the question draft for one paper (Host translates when configured). */
export function buildPaperZhihuDraft(meta: PaperMetadata): Promise<ZhihuDraft> {
	return buildZhihuQuestionDraft({
		title: meta.title ?? "",
		authors: meta.authors ?? [],
		venue: meta.publication ?? "",
		year: meta.year != null ? String(meta.year) : "",
		doi: meta.doi ?? "",
		arxivId: meta.arxiv_id ?? "",
		url: meta.html_url ?? meta.source_url ?? "",
		abstractText: meta.abstract ?? "",
	});
}

/** Copy a draft with the same toast the Paper Info panel shows. */
export async function copyPaperZhihuDraft(draft: ZhihuDraft): Promise<void> {
	await copyTextToClipboard(`${draft.title}\n\n${draft.body}`, {
		successMessage: i18n.t("sidebar:paperInfo.zhihuAskCopied"),
		errorMessage: i18n.t("sidebar:paperInfo.copyFailed"),
		successNotify: { duration: 5000, id: "zhihu-ask-copied" },
	});
}

/** Build, copy, then open Zhihu; returns the visible draft. */
export async function askPaperOnZhihu(
	meta: PaperMetadata,
): Promise<ZhihuDraft> {
	const draft = await buildPaperZhihuDraft(meta);
	await copyPaperZhihuDraft(draft);
	openExternalUrl(ZHIHU_HOME_URL);
	return draft;
}
