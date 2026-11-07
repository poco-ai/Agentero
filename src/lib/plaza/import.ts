/**
 * Import a paper from a 广场 source into the vault.
 *
 * Two routes, because they are not equally good:
 *
 * - **arXiv rows** keep the 魔棒 path with the arxiv.org URL: the Host's native
 *   arXiv handling additionally yields `arxiv_id` and the LaTeX source.
 * - **Everything else** goes to `paper_coolpapers_import`, which reads the row's
 *   own papers.cool page. That page carries Highwire `citation_*` metadata for
 *   all 11 publisher shapes papers.cool aggregates — including the PDF URL —
 *   whereas routing the publisher URL through the Translator fails outright for
 *   several (OpenReview serves a bot challenge, AAAI OJS 500s) and never returns
 *   a PDF for any of them.
 */

import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import { enqueueTaskSettled, type TaskExecutorContext } from "@/lib/core/tasks";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import { refreshLibrary } from "@/lib/paper/library-store";
import { getVaultPath, refreshTree } from "@/lib/vault/store";

export type PlazaImportRequest = {
	/** Source-local row id, echoed back so the frame can settle that row. */
	id: string;
	/** papers.cool branch (`arxiv` / `venue`). */
	branch?: string;
	/** Upstream landing page for the row. */
	url: string;
	title: string | null;
};

/**
 * The 魔棒 import settles through `onComplete`, which this frame does not
 * await, so a failure in there never reaches our `catch`. Settle regardless
 * after this long so the row cannot stay stuck pending; the tasks panel still
 * reports the real error. A retry is harmless — the Host dedupes by id.
 */
const SETTLE_TIMEOUT_MS = 120_000;

function isArxivRow(request: PlazaImportRequest): boolean {
	if (request.branch === "arxiv") return true;
	try {
		return new URL(request.url).hostname.endsWith("arxiv.org");
	} catch {
		return false;
	}
}

/** paper id from a `paperswithcode.co/paper/<id>` row (arXiv id or catalog id). */
function pwcPaperId(request: PlazaImportRequest): string | null {
	try {
		const url = new URL(request.url);
		if (url.hostname !== "paperswithcode.co") return null;
		const match = /^\/paper\/([^/?#]+)/.exec(url.pathname);
		if (!match) return null;
		const id = decodeURIComponent(match[1]).trim();
		return id || null;
	} catch {
		return null;
	}
}

/** arXiv rows: reuse 魔棒 so `arxiv_id` and the LaTeX source come along. */
function importViaLookup(request: PlazaImportRequest): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => settle(false), SETTLE_TIMEOUT_MS);
		function settle(ok: boolean) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		}
		void lookupSubmit([request.url], {
			onComplete: (result) => settle(result.imported.length > 0),
		}).catch((error) => {
			notifyError(errorText(error));
			settle(false);
		});
	});
}

/** Everything else: read the row's papers.cool page, no Translator involved. */
async function importViaPage(
	request: PlazaImportRequest,
	vaultPath: string,
): Promise<boolean> {
	await enqueueTaskSettled({
		kind: "import",
		vaultPath,
		path: currentLookupParentDir(),
		lane: "normal",
		params: {
			mode: "plaza",
			id: request.id,
			title: request.title,
			branch: request.branch || "venue",
		},
	});
	return true;
}

/** Papers with Code rows resolve their catalog page on the Host side. */
async function importViaPwc(
	paperId: string,
	request: PlazaImportRequest,
	vaultPath: string,
): Promise<boolean> {
	await enqueueTaskSettled({
		kind: "import",
		vaultPath,
		path: currentLookupParentDir(),
		lane: "normal",
		params: {
			mode: "plaza",
			source: "pwc",
			id: paperId,
			title: request.title,
		},
	});
	return true;
}

type PlazaJobParams = {
	id?: string;
	title?: string | null;
	branch?: string;
	source?: string;
};

function plazaJobParams(params: unknown): PlazaJobParams {
	return (params && typeof params === "object" ? params : {}) as PlazaJobParams;
}

/** Executor body of a 广场 (`mode: "plaza"`) import job. */
export async function runPlazaImportJob(
	ctx: TaskExecutorContext,
): Promise<void> {
	const vaultPath = ctx.vaultPath;
	const params = plazaJobParams(ctx.params);
	const id = params.id?.trim() ?? "";
	if (!id) throw new Error("plaza import job is missing its source id");
	const label = params.title?.trim() || id;
	const result =
		params.source === "pwc"
			? await callApiResult(
					() =>
						commands.paperPwcImport({
							vaultPath,
							parentDir: currentLookupParentDir(),
							paperId: id,
							// The job id doubles as the Host progress + cancel task id.
							taskId: ctx.jobId,
						}),
					{ fallback: i18n.t("app:plazaImport.failed") },
				)
			: await callApiResult(
					() =>
						commands.paperCoolpapersImport({
							vaultPath,
							parentDir: currentLookupParentDir(),
							branch: params.branch || "venue",
							id,
							// The job id doubles as the Host progress + cancel task id.
							taskId: ctx.jobId,
						}),
					{ fallback: i18n.t("app:plazaImport.failed") },
				);

	await refreshTree(vaultPath);
	await refreshLibrary();

	if (result.status === "created") {
		const name = result.title || label;
		if (result.pdf) notifySuccess(i18n.t("app:plazaImport.imported", { name }));
		// The unit is in the library; only the PDF is missing. Say so instead of
		// reporting a clean success the user would later find untrue.
		else notifyWarning(i18n.t("app:plazaImport.importedNoPdf", { name }));
		return;
	}
	notifyWarning(
		i18n.t("app:plazaImport.duplicate", { name: result.title || label }),
	);
}

/**
 * Resolves `true` when the paper is in the library afterwards.
 *
 * Does not open the imported paper — that would pull the user out of the
 * browsing panel, which is the wrong trade while importing several in a row.
 */
export async function importPlazaPaper(
	request: PlazaImportRequest,
): Promise<boolean> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:plazaImport.needsVault"));
		return false;
	}
	if (!request.id.trim()) {
		notifyWarning(i18n.t("app:plazaImport.missingId"));
		return false;
	}

	try {
		const pwcId = pwcPaperId(request);
		if (pwcId) return await importViaPwc(pwcId, request, vaultPath);
		return isArxivRow(request)
			? await importViaLookup(request)
			: await importViaPage(request, vaultPath);
	} catch (error) {
		notifyError(errorText(error));
		return false;
	}
}

/** Feed a GitHub Skill repo into the 魔棒 discovery → install dialog. */
export async function importPlazaSkillRepo(url: string): Promise<void> {
	try {
		await lookupSubmit([url]);
	} catch (error) {
		notifyError(errorText(error));
	}
}
