"use client";

import { Link2 } from "lucide-react";
import { useEditorRef, useEditorSelector } from "platejs/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useWikiStore } from "@/hooks/use-app-stores";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { cn } from "@/lib/core/utils";
import {
	countChars,
	countWords,
	plateDocumentText,
} from "@/lib/markdown/stats";
import { isMarkdownPath } from "@/lib/vault/fs";
import { getBacklinks, type ResolvedLink } from "@/lib/wiki";
import { navigateWiki } from "@/lib/workspace/actions";

/**
 * Word/char counts walk every leaf of the document, so they must not run per
 * keystroke. The status bar is allowed to lag slightly behind typing.
 */
const STATS_DEBOUNCE_MS = 400;

type DocumentStats = { words: number; chars: number };

function computeDocumentStats(children: readonly unknown[]): DocumentStats {
	const text = plateDocumentText(children);
	return { words: countWords(text), chars: countChars(text) };
}

function fragmentLabel(link: ResolvedLink): string | null {
	const fragment = link.occurrence.fragment;
	if (!fragment) return null;
	if (fragment.kind === "block") return `^${fragment.id}`;
	if (fragment.kind === "annotation") return `@${fragment.id}`;
	return fragment.path.join(" › ");
}

type EditorStatusBarProps = {
	filePath?: string | null;
	vaultPath?: string | null;
	/** Pinned to the left edge; counts and backlinks stay right-aligned. */
	leading?: ReactNode;
};

export function EditorStatusBar({
	filePath,
	vaultPath,
	leading,
}: EditorStatusBarProps) {
	const { t } = useTranslation("editor");
	const wikiIndexRevision = useWikiStore((s) => s.wikiIndexRevision);
	const [backlinks, setBacklinks] = useState<ResolvedLink[]>([]);
	const editor = useEditorRef();

	// Cheap change signal: the children array identity changes on every edit
	// (selection-only changes keep it stable). The expensive full-document walk
	// runs debounced below, never inside the selector.
	const children = useEditorSelector((e) => e.children, []);
	const debouncedChildren = useDebouncedValue(children, STATS_DEBOUNCE_MS);
	const [{ words, chars }, setStats] = useState<DocumentStats>(() =>
		computeDocumentStats(editor.children),
	);

	useEffect(() => {
		const next = computeDocumentStats(debouncedChildren);
		setStats((prev) =>
			prev.words === next.words && prev.chars === next.chars ? prev : next,
		);
	}, [debouncedChildren]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: wikiIndexRevision is a refresh signal
	useEffect(() => {
		if (!filePath || !isMarkdownPath(filePath)) {
			setBacklinks([]);
			return;
		}
		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			getBacklinks(vaultPath ?? null, filePath)
				.then((res) => {
					if (!cancelled) setBacklinks(res.backlinks);
				})
				.catch(() => {
					if (!cancelled) setBacklinks([]);
				});
		};
		// Backlinks are chrome, not reading-critical: run after the note is
		// interactive so opening a long file and the Host query do not compete.
		const idle = window as unknown as {
			requestIdleCallback?: (
				cb: () => void,
				opts?: { timeout: number },
			) => number;
			cancelIdleCallback?: (handle: number) => void;
		};
		const handle = idle.requestIdleCallback
			? idle.requestIdleCallback(run, { timeout: 2000 })
			: window.setTimeout(run, 250);
		return () => {
			cancelled = true;
			if (idle.requestIdleCallback && idle.cancelIdleCallback) {
				idle.cancelIdleCallback(handle);
			} else {
				window.clearTimeout(handle);
			}
		};
	}, [filePath, vaultPath, wikiIndexRevision]);

	const handleNavigate = (link: ResolvedLink) => {
		const source = link.occurrence.source;
		void navigateWiki({
			targetRaw: source,
			path: source,
			status: "resolved",
		});
	};

	return (
		<div
			className={cn(
				"@container/statusbar flex h-7 shrink-0 items-center gap-3 overflow-hidden",
				"border-t border-border/80 bg-background/95 px-3",
				"whitespace-nowrap text-xs text-muted-foreground tabular-nums select-none",
			)}
		>
			{leading ? (
				<div className="flex shrink-0 items-center">{leading}</div>
			) : null}
			<div
				role="status"
				aria-label={t("statusBar.label")}
				className="ml-auto flex min-w-0 items-center justify-end gap-3"
			>
				<HoverCard openDelay={200} closeDelay={150}>
					<HoverCardTrigger asChild>
						<span className="hidden cursor-default items-center gap-1 @min-[18rem]/statusbar:inline-flex">
							<Link2 className="size-3" aria-hidden />
							{t("statusBar.backlinks", { count: backlinks.length })}
						</span>
					</HoverCardTrigger>
					<HoverCardContent
						side="top"
						align="end"
						className="w-72 overflow-hidden p-0"
					>
						<div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
							{t("statusBar.backlinksHoverTitle", {
								count: backlinks.length,
							})}
						</div>
						<div className="agentero-scroll max-h-64 overflow-y-auto p-1.5">
							{backlinks.length === 0 ? (
								<p className="px-1.5 py-2 text-xs text-muted-foreground">
									{t("statusBar.noBacklinks")}
								</p>
							) : (
								<ul className="flex flex-col gap-0.5">
									{backlinks.map((link) => {
										const source = link.occurrence.source;
										const name = source.split("/").pop() ?? source;
										const fragment = fragmentLabel(link);
										const status =
											link.status === "resolved" ? null : link.status;
										return (
											<li
												key={`${source}:${link.occurrence.sourceRange.start}`}
											>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													className="h-auto w-full justify-start px-1.5 py-1 text-left font-normal"
													title={source}
													onClick={() => handleNavigate(link)}
												>
													<span className="min-w-0 flex-1 truncate text-xs">
														<span className="font-medium text-foreground">
															{name}
														</span>
														{fragment ? (
															<span className="ml-1 text-muted-foreground">
																{fragment}
															</span>
														) : null}
														{status ? (
															<span className="ml-1.5 text-destructive">
																{t(`statusBar.backlinkStatus.${status}`)}
															</span>
														) : null}
													</span>
												</Button>
											</li>
										);
									})}
								</ul>
							)}
						</div>
					</HoverCardContent>
				</HoverCard>
				<span
					className="hidden h-3 w-px bg-border @min-[18rem]/statusbar:block"
					aria-hidden
				/>
				<span className="hidden @min-[11rem]/statusbar:inline">
					{t("statusBar.words", { count: words })}
				</span>
				<span
					className="hidden h-3 w-px bg-border @min-[11rem]/statusbar:block"
					aria-hidden
				/>
				<span>{t("statusBar.characters", { count: chars })}</span>
			</div>
		</div>
	);
}
