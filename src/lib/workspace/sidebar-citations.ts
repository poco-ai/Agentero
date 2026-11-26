import i18n from "@/i18n";
import { resolvePdfCitation } from "@/lib/agent/api";
import {
	isAgentCitationHref,
	rewriteCitationHrefToPdf,
	splitCitationHref,
} from "@/lib/agent/citation-href";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	beginPdfNavigation,
	completePdfNavigation,
	type PdfNavigationTarget,
} from "@/lib/pdf/pending-pdf-page";
import { openOrActivateSidebarTarget } from "@/lib/shell/sidebar-tabs";
import { normalizePathKey } from "@/lib/vault/path";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import {
	readSidebarFile,
	sidebarFileTarget,
	sidebarPaperPdf,
	sidebarPdfPageCount,
	sidebarVaultRelative,
} from "@/lib/workspace/sidebar-files";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";
import {
	citationNavigationTarget,
	citationResolveFailedMessage,
	evidenceLinkFragment,
	openCitation,
} from "@/lib/workspace/viewer-actions";

let clickId = 0;
let trackedVaultGeneration = -1;
const lastOpenedClick = new Map<string, number>();

export async function openSidebarCitation(
	source: string,
	sourceVault?: string,
) {
	const href = rewriteCitationHrefToPdf(source);
	if (!href) return;
	if (/^https?:\/\//i.test(href)) {
		openCitation(href);
		return;
	}
	const vault = getVaultPath();
	if (
		!vault ||
		(sourceVault && normalizePathKey(sourceVault) !== normalizePathKey(vault))
	) {
		notifyError(i18n.t("app:errors.openVaultForLinks"));
		return;
	}
	const generation = vaultLoadGeneration();
	if (trackedVaultGeneration !== generation) {
		trackedVaultGeneration = generation;
		lastOpenedClick.clear();
	}
	const id = ++clickId;
	const sameVault = () =>
		vaultLoadGeneration() === generation && getVaultPath() === vault;
	let targetKey: string | undefined;
	const canOpen = () =>
		sameVault() && (!targetKey || id >= (lastOpenedClick.get(targetKey) ?? 0));
	try {
		let { path, fragment } = splitCitationHref(href);
		let line: unknown;
		if (href.startsWith("agentero://cite/")) {
			const evidence = await commands.agentResolveEvidence(vault, href);
			if (evidence.status === "error") throw new Error(evidence.error);
			path = evidence.data[0];
			({ fragment, line } = evidenceLinkFragment(evidence.data[1]));
		}
		if (!canOpen()) return;
		const rel = sidebarVaultRelative(
			vault,
			path.replace(/(\.html?)\?.*$/i, "$1"),
		);
		if (!rel) throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
		let target = sidebarFileTarget(vault, rel);
		let jump: PdfNavigationTarget | undefined;
		const citation = `${rel}#${fragment}`;
		if (fragment && (target?.kind === "pdf" || isAgentCitationHref(citation))) {
			const page =
				target?.kind === "pdf" ? /^page=([1-9]\d*)$/i.exec(fragment) : null;
			if (page) jump = { page: Number(page[1]) };
			else {
				const resolved = await resolvePdfCitation(vault, citation).catch(() => {
					throw new Error(citationResolveFailedMessage(href));
				});
				if (!canOpen()) return;
				jump = citationNavigationTarget(resolved);
				target =
					(await sidebarPaperPdf(vault, resolved.paperPath)) ??
					(target?.kind === "pdf" ? target : null);
			}
		} else if (!target && /^papers\//.test(rel)) {
			target = await sidebarPaperPdf(vault, rel);
		}
		if (!target) throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
		targetKey = `${target.kind}:${target.vaultRelPath}`;
		if (!canOpen()) return;
		const file = await readSidebarFile(vault, target);
		if (
			jump &&
			(!file.pdfBytes ||
				!Number.isSafeInteger(jump.page) ||
				jump.page < 1 ||
				jump.page > (await sidebarPdfPageCount(file.pdfBytes)))
		) {
			throw new Error(citationResolveFailedMessage(href));
		}
		const viewId = await openOrActivateSidebarTarget(target, {
			file,
			canOpen,
			onOpen: (viewId) => {
				if (targetKey) lastOpenedClick.set(targetKey, id);
				if (jump) completePdfNavigation(beginPdfNavigation(viewId), jump);
			},
		});
		if (!viewId || !canOpen()) return;
		if (target.kind === "notes" && typeof line === "number") {
			for (let attempt = 0; attempt < 60 && canOpen(); attempt++) {
				if (markdownEditorFor(viewId)?.revealLine?.(line)) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	} catch (error) {
		if (sameVault()) notifyError(errorText(error));
	}
}
