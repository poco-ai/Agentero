"use client";

import {
	CornerDownLeft,
	FileText,
	Hash,
	Highlighter,
	ScanSearch,
	TextQuote,
} from "lucide-react";
import { RangeApi } from "platejs";
import { useEditorRef } from "platejs/react";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import {
	type CompletionMenuController,
	useCompletionMenu,
} from "@/components/editor/hooks/use-completion-menu";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import {
	annotationSnippet,
	listPaperAnnotationSummaries,
	paperAbsFromSourceFile,
	paperAbsFromWikiTarget,
	paperAbsFromWorkspaceTab,
	pdfTabIdForPaper,
	truncateAnnotationPreview,
} from "@/lib/pdf/annotation-ref";
import { annotationsStore } from "@/lib/pdf/annotations-store";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import {
	resolveWikiReference,
	searchWikiLinks,
	type WikiSearchCandidate,
} from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import {
	isWikiLinkDraftText,
	isWikiLinkNode,
	parseWikiLinkMarkdown,
	wikiLinkDraftEditableBounds,
	wikiLinkToMarkdown,
} from "@/lib/wiki/wikilink-model";
import {
	addRecentWikiCandidate,
	findWikiCompletionMatch,
	isWikiCompletionSubmitKey,
	narrowExactWikiFileCandidates,
	parseWikiCompletionQuery,
	sameWikiPath,
	wikiCompletionCandidateKey,
	wikiCompletionInsert,
	wikiFileCandidateSecondaryLine,
} from "@/lib/wiki-completion";
import { getActiveTabId, workspaceStore } from "@/lib/workspace/store";

export type WikiCompletionDraft = {
	raw: string;
	embed: boolean;
	left: number;
	top: number;
};

export type WikiCompletionController = CompletionMenuController;

type WikiLinkSuggestionProps = {
	draft: WikiCompletionDraft | null;
	onClose: () => void;
	onContinue: (raw: string) => void;
	controllerRef: MutableRefObject<WikiCompletionController | null>;
};

type CandidateState = {
	requestKey: string | null;
	items: WikiSearchCandidate[];
};

/** Refinements to a Host-backed search wait for a pause in typing. */
const WIKI_SEARCH_DEBOUNCE_MS = 200;

function completionRequestKey(
	request: ReturnType<typeof parseWikiCompletionQuery>,
): string | null {
	if (!request) return null;
	return request.kind === "file"
		? `file\u0000${request.query}`
		: `${request.kind}\u0000${request.target}\u0000${request.query}`;
}

function CandidateIcon({
	kind,
	detail,
}: {
	kind: WikiSearchCandidate["kind"];
	detail?: string;
}) {
	if (kind === "alias") return null;
	// Annotation candidates: visual uses magnifier; highlight/划词 uses highlighter.
	if (kind === "annotation") {
		const visual = detail?.includes("visual");
		const Icon = visual ? ScanSearch : Highlighter;
		return (
			<Icon
				className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
				aria-hidden
			/>
		);
	}
	const Icon =
		kind === "file" ? FileText : kind === "heading" ? Hash : TextQuote;
	return (
		<Icon
			className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
			aria-hidden
		/>
	);
}

function filterAnnotationQuery(
	query: string,
	label: string,
	id: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return `${label} ${id}`.toLowerCase().includes(q);
}

/**
 * Default wikilink alias for an annotation pick: truncated comment/quote so Enter
 * fills `target@id|text` and display (link + embed chrome) never shows a bare UUID
 * when the mark has readable content.
 */
function annotationDisplayAlias(
	comment?: string | null,
	quote?: string | null,
): string | undefined {
	const preview = truncateAnnotationPreview(
		annotationSnippet({ comment, quote }),
	);
	return preview || undefined;
}

/**
 * Build annotation candidates for `@` completion.
 * Prefer the PDF tab store when the paper body is open; always fall back to
 * disk marks so NOTES-focused editing still lists ids.
 */
async function buildAnnotationCandidates(
	query: string,
	target: string,
	paperAbs: string | null,
	pathHint: string,
): Promise<WikiSearchCandidate[]> {
	if (!paperAbs) return [];
	const pdfTabId = pdfTabIdForPaper(paperAbs);
	const state = annotationsStore.getState();
	const storeHighlights = state.highlightsByTab[pdfTabId] ?? [];
	const storeVisuals = state.visualTracesByTab[pdfTabId] ?? [];
	const out: WikiSearchCandidate[] = [];

	if (storeHighlights.length || storeVisuals.length) {
		for (const h of storeHighlights) {
			const alias = annotationDisplayAlias(h.comment, h.quote);
			const preview = alias || h.id;
			if (!filterAnnotationQuery(query, preview, h.id)) continue;
			out.push({
				kind: "annotation",
				path: pathHint,
				insertText: target ? `${target}@${h.id}` : `@${h.id}`,
				label: preview,
				detail: `p.${h.page} · highlight`,
				alias,
				fragment: { kind: "annotation", id: h.id },
			});
		}
		for (const v of storeVisuals) {
			const alias = annotationDisplayAlias(v.comment, null);
			const preview = alias || v.id;
			if (!filterAnnotationQuery(query, preview, v.id)) continue;
			out.push({
				kind: "annotation",
				path: pathHint,
				insertText: target ? `${target}@${v.id}` : `@${v.id}`,
				label: preview,
				detail: `p.${v.page} · visual`,
				alias,
				fragment: { kind: "annotation", id: v.id },
			});
		}
		return out;
	}

	const summaries = await listPaperAnnotationSummaries(paperAbs);
	for (const s of summaries) {
		const alias = annotationDisplayAlias(s.comment, s.quote);
		const preview = alias || s.preview || s.id;
		if (!filterAnnotationQuery(query, preview, s.id)) continue;
		out.push({
			kind: "annotation",
			path: pathHint,
			insertText: target ? `${target}@${s.id}` : `@${s.id}`,
			label: preview,
			detail: `p.${s.page} · ${s.kind === "visual" || s.kind === "agent-trace" ? "visual" : "highlight"}`,
			alias,
			fragment: { kind: "annotation", id: s.id },
		});
	}
	return out;
}

/**
 * File and anchor suggestions are Host-backed. Alias completion is local
 * because it only wraps the already selected target with user-authored text.
 */
export function WikiLinkSuggestion({
	draft,
	onClose,
	onContinue,
	controllerRef,
}: WikiLinkSuggestionProps) {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const { filePath } = useMarkdownDoc();
	const wikiNav = useWikiNav();
	// Depend on raw text only — draft position updates must not recreate the
	// request object or we re-fetch and snap selection back to 0.
	const draftRaw = draft?.raw ?? null;
	const request = useMemo(
		() => (draftRaw != null ? parseWikiCompletionQuery(draftRaw) : null),
		[draftRaw],
	);
	const requestKey = completionRequestKey(request);
	/**
	 * Host-backed searches (file / heading / annotation) are debounced so a
	 * keystroke burst fires one `wiki_search` instead of one per key. The
	 * initial trigger (empty query) and local alias completion stay immediate
	 * so the menu opens without lag.
	 */
	const [fetchRequest, setFetchRequest] = useState(request);
	useEffect(() => {
		if (!request || request.kind === "alias" || request.query === "") {
			setFetchRequest(request);
			return;
		}
		const timer = window.setTimeout(
			() => setFetchRequest(request),
			WIKI_SEARCH_DEBOUNCE_MS,
		);
		return () => window.clearTimeout(timer);
	}, [request]);
	const fetchRequestKey = completionRequestKey(fetchRequest);
	/** True while a debounced refinement has not been fetched yet. */
	const fetchPending = requestKey !== fetchRequestKey;
	const [candidateState, setCandidateState] = useState<CandidateState>({
		requestKey: null,
		items: [],
	});
	const candidates =
		candidateState.requestKey === fetchRequestKey ? candidateState.items : [];
	const candidatesRef = useRef(candidates);
	candidatesRef.current = candidates;
	const [recentCandidates, setRecentCandidates] = useState<
		WikiSearchCandidate[]
	>([]);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!fetchRequest) {
			setCandidateState({ requestKey: null, items: [] });
			setLoading(false);
			return;
		}
		if (fetchRequest.kind === "alias") {
			setCandidateState({
				requestKey: fetchRequestKey,
				items: [
					{
						kind: "alias",
						path: fetchRequest.target,
						insertText: fetchRequest.target,
						label: fetchRequest.query,
						detail: fetchRequest.target,
						alias: fetchRequest.query || undefined,
					},
				],
			});
			setLoading(false);
			return;
		}
		const vaultPath = wikiNav?.vaultPath;
		if (!vaultPath || !filePath) {
			setCandidateState({ requestKey: null, items: [] });
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		void (async () => {
			try {
				if (fetchRequest.kind === "file") {
					const results = await searchWikiLinks(vaultPath, fetchRequest.query, {
						kind: "file",
					});
					if (!cancelled) {
						const matching = narrowExactWikiFileCandidates(
							results.filter((candidate) => candidate.kind === "file"),
							fetchRequest.query,
						);
						if (!fetchRequest.query) {
							const byKey = new Map(
								matching.map((candidate) => [
									wikiCompletionCandidateKey(candidate),
									candidate,
								]),
							);
							const recent = recentCandidates.flatMap((candidate) => {
								const current = byKey.get(
									wikiCompletionCandidateKey(candidate),
								);
								return current ? [current] : [];
							});
							setCandidateState({
								requestKey: fetchRequestKey,
								items: recent.length ? recent : matching,
							});
							return;
						}
						setCandidateState({ requestKey: fetchRequestKey, items: matching });
					}
					return;
				}
				// Annotation completion is frontend-backed (marks live outside the
				// Markdown wiki index). Resolve paper from target or NOTES path,
				// then list from PDF-tab store or disk.
				if (fetchRequest.kind === "annotation") {
					let paperAbs: string | null = null;
					let pathHint = filePath;
					if (fetchRequest.target) {
						const resolved = await resolveWikiReference(
							vaultPath,
							filePath,
							fetchRequest.target,
						);
						if (resolved?.targetPath) {
							pathHint = resolved.targetPath;
							paperAbs = paperAbsFromWikiTarget(vaultPath, resolved.targetPath);
						}
					}
					if (!paperAbs) {
						paperAbs = paperAbsFromSourceFile(
							filePath,
							vaultStore.getState().paperFolders,
						);
					}
					if (!paperAbs) {
						const tab = workspaceStore
							.getState()
							.tabs.find((item) => item.id === getActiveTabId());
						paperAbs = paperAbsFromWorkspaceTab(
							tab ?? null,
							getVaultPath(),
							vaultStore.getState().paperFolders,
						);
						if (tab?.paperMeta?.path) pathHint = tab.paperMeta.path;
					}
					const items = await buildAnnotationCandidates(
						fetchRequest.query,
						fetchRequest.target,
						paperAbs,
						pathHint,
					);
					if (!cancelled) {
						setCandidateState({ requestKey: fetchRequestKey, items });
					}
					return;
				}

				// Resolve only the file portion before searching its anchors.
				// An empty target intentionally resolves to the source document, so
				// the initial `[[#` / `[[^` trigger can list every local anchor.
				const resolved = await resolveWikiReference(
					vaultPath,
					filePath,
					fetchRequest.target,
				);
				if (
					cancelled ||
					!resolved?.targetPath ||
					resolved.status === "ambiguous"
				) {
					if (!cancelled) {
						setCandidateState({ requestKey: fetchRequestKey, items: [] });
					}
					return;
				}
				const results = await searchWikiLinks(vaultPath, fetchRequest.query, {
					path: resolved.targetPath,
					kind: fetchRequest.kind,
				});
				if (!cancelled) {
					setCandidateState({
						requestKey: fetchRequestKey,
						items: results.filter(
							(candidate) =>
								candidate.kind === fetchRequest.kind &&
								sameWikiPath(candidate.path, resolved.targetPath ?? ""),
						),
					});
				}
			} catch {
				if (!cancelled)
					setCandidateState({ requestKey: fetchRequestKey, items: [] });
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		filePath,
		recentCandidates,
		fetchRequest,
		fetchRequestKey,
		wikiNav?.vaultPath,
	]);

	const selectCandidateRef = useRef<
		(candidate: WikiSearchCandidate, submitKey: "Enter" | "Tab") => boolean
	>(() => false);

	const { selectedIndex, setSelectedIndex, listRef } = useCompletionMenu({
		items: candidates,
		open: Boolean(draft),
		resetKey: requestKey,
		onClose,
		controllerRef,
		onSubmitKey: (event, candidate) => {
			if (!isWikiCompletionSubmitKey(event.key) || !candidate) return false;
			if (
				selectCandidateRef.current(
					candidate,
					event.key === "Tab" ? "Tab" : "Enter",
				)
			) {
				event.preventDefault();
				return true;
			}
			// An alias trigger with an empty query has nothing to confirm, but the
			// key must not reach the editor and split the token.
			if (request?.kind === "alias" && !request.query) {
				event.preventDefault();
				return true;
			}
			return false;
		},
	});

	const selectCandidate = useCallback(
		(candidate: WikiSearchCandidate, submitKey: "Enter" | "Tab" = "Enter") => {
			if (!draft || !request || candidate.kind !== request.kind) return false;
			if (request.kind === "alias" && !request.query) return false;
			const selection = editor.selection;
			if (!selection || !RangeApi.isCollapsed(selection)) return false;
			const entry = editor.api.node(selection.anchor.path);
			const leaf = entry?.[0];
			if (!leaf || typeof (leaf as { text?: unknown }).text !== "string") {
				return false;
			}
			const match = findWikiCompletionMatch(
				(leaf as { text: string }).text,
				selection.anchor.offset,
				draft.raw,
				draft.embed,
			);
			if (!match) return false;
			const start = {
				path: selection.anchor.path,
				offset: match.start,
			};
			const end = {
				path: selection.anchor.path,
				offset: match.end,
			};
			const insert = wikiCompletionInsert(candidate, request);
			const markdown = wikiLinkToMarkdown({
				value: insert.target,
				heading: insert.heading,
				alias: insert.alias,
				embed: draft.embed,
			});
			const link =
				submitKey === "Enter" ? parseWikiLinkMarkdown(markdown) : null;
			if (submitKey === "Enter" && !link) return false;
			const parentEntry = editor.api.parent(selection.anchor.path);
			const stableLinkPath =
				parentEntry && isWikiLinkNode(parentEntry[0]) ? parentEntry[1] : null;
			// Do not null controllerRef here. The layout effect only binds once
			// (stable identity); clearing it permanently kills ↑/↓/Enter until
			// remount. Closed menus are ignored via draftRef.current === null.
			editor.tf.delete({ at: { anchor: start, focus: end } });
			if (stableLinkPath) {
				const parsed = parseWikiLinkMarkdown(markdown);
				if (!parsed) return false;
				editor.tf.withoutNormalizing(() => {
					editor.tf.insertText(markdown);
					editor.tf.setNodes(
						{
							value: parsed.value,
							heading: parsed.heading,
							alias: parsed.alias ?? undefined,
							embed: parsed.embed === true ? true : undefined,
						},
						{ at: stableLinkPath },
					);
				});
				if (submitKey === "Tab") {
					const point = {
						path: selection.anchor.path,
						offset: wikiLinkDraftEditableBounds(markdown).end,
					};
					editor.tf.select({ anchor: point, focus: point });
					const bounds = wikiLinkDraftEditableBounds(markdown);
					const nextRaw = markdown.slice(bounds.start, bounds.end);
					const nextRequest = parseWikiCompletionQuery(nextRaw);
					if (nextRequest && candidate.kind === nextRequest.kind) {
						setCandidateState({
							requestKey: completionRequestKey(nextRequest),
							items: [candidate],
						});
						setSelectedIndex(0);
						onContinue(nextRaw);
					} else {
						onClose();
					}
				} else {
					const after = editor.api.after(stableLinkPath);
					if (after) editor.tf.select(after);
					onClose();
				}
				setRecentCandidates((recent) =>
					addRecentWikiCandidate(recent, candidate),
				);
				return true;
			}
			const remainder = editor.api.node(start.path);
			if (remainder && isWikiLinkDraftText(remainder[0])) {
				editor.tf.unsetNodes("wikiLinkDraft", { at: remainder[1] });
			}
			if (submitKey === "Tab") {
				editor.tf.insertNodes({ text: markdown, wikiLinkDraft: true });
				editor.tf.move({ distance: 2, reverse: true });
				const bounds = wikiLinkDraftEditableBounds(markdown);
				const nextRaw = markdown.slice(bounds.start, bounds.end);
				const nextRequest = parseWikiCompletionQuery(nextRaw);
				if (nextRequest && candidate.kind === nextRequest.kind) {
					setCandidateState({
						requestKey: completionRequestKey(nextRequest),
						items: [candidate],
					});
					setSelectedIndex(0);
					onContinue(nextRaw);
				} else {
					onClose();
				}
			} else {
				if (!link) return false;
				editor.tf.insertNodes([link, { text: "" }]);
				onClose();
			}
			setRecentCandidates((recent) =>
				addRecentWikiCandidate(recent, candidate),
			);
			return true;
		},
		[draft, editor, onClose, onContinue, request, setSelectedIndex],
	);
	selectCandidateRef.current = selectCandidate;

	if (!draft || !request) return null;
	return (
		<ViewportFloating
			point={{ x: draft.left, y: draft.top }}
			className="z-50 flex w-96 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
			data-editor-completion="wiki"
		>
			<div
				ref={listRef}
				className="max-h-56 overflow-y-auto p-1"
				role="listbox"
				aria-label={t("wikiCompletion.label")}
			>
				{loading || fetchPending ? (
					<p className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("wikiCompletion.loading")}
					</p>
				) : null}
				{!loading && !fetchPending && !candidates.length ? (
					<p className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("wikiCompletion.empty")}
					</p>
				) : null}
				{candidates.map((candidate, index) => {
					// File hits (basename or frontmatter alias): secondary line is path.
					// Other kinds use host `detail`.
					const detail = wikiFileCandidateSecondaryLine(candidate);
					const isAliasPlaceholder =
						candidate.kind === "alias" && !candidate.label;
					return (
						<button
							key={`${candidate.kind}:${candidate.path}:${candidate.insertText}:${candidate.alias ?? ""}`}
							type="button"
							role="option"
							tabIndex={-1}
							aria-selected={index === selectedIndex}
							className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs outline-none ${
								index === selectedIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-accent/60"
							}`}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => selectCandidate(candidate)}
						>
							<CandidateIcon kind={candidate.kind} detail={candidate.detail} />
							<span className="min-w-0 flex-1">
								<span
									className={`block truncate font-medium ${
										isAliasPlaceholder ? "text-muted-foreground" : ""
									}`}
								>
									{isAliasPlaceholder
										? t("wikiCompletion.displayName")
										: candidate.label}
								</span>
								{detail ? (
									<span
										className="block truncate text-muted-foreground"
										title={detail}
									>
										{detail}
									</span>
								) : null}
							</span>
							{candidate.kind === "alias" ? (
								<CornerDownLeft
									className="mt-2 size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							) : null}
						</button>
					);
				})}
			</div>
			<p className="shrink-0 border-t px-2 py-1.5 text-[11px] text-muted-foreground text-center leading-4">
				{t("wikiCompletion.syntaxHint")}
			</p>
		</ViewportFloating>
	);
}
