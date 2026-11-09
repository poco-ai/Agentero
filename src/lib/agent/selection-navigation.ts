import i18n from "@/i18n";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { toVaultRelative } from "@/lib/core/path";
import { joinVaultPath } from "@/lib/vault/path";
import { vaultStore } from "@/lib/vault/store";
import { agentSessionStore, getActiveLines } from "./agent-session-store";
import { selectionNavigationStore } from "./selection-navigation-state";
import { matchesChatSource, resolveSelectionRange } from "./selection-source";
import type { SelectionContext } from "./selection-store";

let navigation = 0;
let clearFlash: (() => void) | undefined;
function reveal(range: Range) {
	const element =
		range.startContainer instanceof Element
			? range.startContainer
			: range.startContainer.parentElement;
	element?.scrollIntoView({ block: "center", inline: "nearest" });
	clearFlash?.();
	if (typeof Highlight !== "undefined") {
		const highlight = new Highlight(range);
		CSS.highlights.set("agentero-annotation-navigation", highlight);
		clearFlash = () => {
			if (CSS.highlights.get("agentero-annotation-navigation") === highlight)
				CSS.highlights.delete("agentero-annotation-navigation");
		};
		window.setTimeout(clearFlash, 2400);
	}
}
/** A failed/ambiguous quote never falls back to the first matching sentence. */
export async function navigateToSelection(
	selection: SelectionContext,
): Promise<void> {
	const nonce = ++navigation;
	const vaultPath = vaultStore.getState().vaultPath;
	try {
		const live = resolveSelectionRange(selection);
		if (live) {
			reveal(live);
			return;
		}
		if (selection.sourceUrl && /^https?:\/\//i.test(selection.sourceUrl)) {
			openExternalUrl(selection.sourceUrl);
			return;
		}
		const { openVaultRel, openPaper, scheduleCitationJump } = await import(
			"@/lib/workspace/actions"
		);
		if (selection.origin === "pdf" && selection.page) {
			const paper =
				selection.paperAbsPath ||
				(vaultPath ? joinVaultPath(vaultPath, selection.sourcePath) : null);
			if (!paper) throw new Error("missing source");
			const rects = selection.rects ?? [];
			const x = rects.length ? Math.min(...rects.map((r) => r.x)) : 0;
			const y = rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
			const w = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) - x : 1;
			const h = rects.length ? Math.max(...rects.map((r) => r.y + r.h)) - y : 1;
			openPaper(paper);
			scheduleCitationJump(paper, {
				paperPath: toVaultRelative(vaultPath, paper),
				path: selection.sourcePath,
				fragment: `page=${selection.page}`,
				pageIndex: selection.page - 1,
				bbox: { x, y, w, h },
				regionId: `selection-${selection.id}`,
				title: null,
			});
			return;
		}
		if (selection.origin === "chat") {
			if (!selection.messageId) throw new Error("missing message");
			const state = agentSessionStore.getState();
			if (
				!matchesChatSource(selection, `Chat ${state.activeTabId}`) ||
				!getActiveLines(
					state.sessions,
					state.activeTabId,
					state.draftLines,
				).some((line) => line.id === selection.messageId)
			) {
				const source = state.sessions.find(
					(session) =>
						matchesChatSource(selection, `Chat ${session.id}`) &&
						session.lines.some((line) => line.id === selection.messageId),
				);
				if (!source) throw new Error("source conversation unavailable");
				state.setActiveTabId(source.id);
			}
			selectionNavigationStore.setState({
				messageId: selection.messageId,
				tabId: agentSessionStore.getState().activeTabId,
				nonce,
			});
		} else openVaultRel(selection.sourcePath);
		const range = await new Promise<Range | null>((resolve) => {
			const observer = new MutationObserver(check);
			const timeout = window.setTimeout(() => finish(null), 6000);
			function finish(found: Range | null) {
				observer.disconnect();
				window.clearTimeout(timeout);
				resolve(found);
			}
			function check() {
				if (
					nonce !== navigation ||
					vaultPath !== vaultStore.getState().vaultPath
				) {
					finish(null);
					return;
				}
				const found = resolveSelectionRange(selection);
				if (found) finish(found);
			}
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			check();
		});
		if (nonce !== navigation || vaultPath !== vaultStore.getState().vaultPath)
			return;
		if (!range) throw new Error("quote missing or ambiguous");
		reveal(range);
	} catch {
		if (nonce === navigation && vaultPath === vaultStore.getState().vaultPath)
			notifyError(i18n.t("viewer:selection.sourceUnavailable"));
	} finally {
		if (selectionNavigationStore.getState().nonce === nonce)
			selectionNavigationStore.setState({ messageId: null });
	}
}
