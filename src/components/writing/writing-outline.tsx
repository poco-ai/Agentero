/**
 * Document structure for the open writing project. Child files merge into one
 * tree so the outline mirrors the compiled PDF; labels, figures and tables
 * hang under their section. While another file loads, the last complete tree
 * stays on screen instead of collapsing to that file's local outline.
 */

import { Image, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	FILE_TREE_ROW_SELECTED_STATE,
	FILE_TREE_ROW_STATE,
} from "@/components/sidebar/file-tree/file-tree-primitives";
import { normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { trackTexProject } from "@/lib/tex/auto-build";
import { ensureTexBuildEvents } from "@/lib/tex/build-state";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import { activeOutlineSectionId, type TexOutlineItem } from "@/lib/tex/outline";
import { normalizeTabPath } from "@/lib/workspace/tabs";
import {
	type TexOutlineSnapshot,
	texOutlineStore,
} from "@/lib/workspace/tex-outline-bridge";

const INDENT_STEP_REM = 0.75;

type StructureRow = {
	item: TexOutlineItem;
	depth: number;
};

/** Sections use their real heading rank; metadata hangs one level below. */
function buildStructure(items: readonly TexOutlineItem[]): StructureRow[] {
	const headings = items.filter((item) => item.kind === "section");
	const base =
		headings.length === 0
			? 1
			: Math.min(...headings.map((item) => item.level ?? 1));
	let sectionDepth = -1;
	const rows: StructureRow[] = [];
	for (const item of items) {
		if (item.kind === "file") continue;
		if (item.kind === "section") {
			sectionDepth = Math.max(0, (item.level ?? 1) - base);
			rows.push({ item, depth: sectionDepth });
		} else {
			rows.push({ item, depth: Math.max(0, sectionDepth + 1) });
		}
	}
	return rows;
}

export function WritingOutline({ texPath }: { texPath: string }) {
	const { t } = useTranslation("sidebar");
	const snapshot = useStore(texOutlineStore, (state) => state.snapshot);
	// A per-file snapshot (no rootPath) is not the merged tree; ignore it.
	const belongs =
		snapshot != null &&
		(snapshot.path === normalizeTabPath(texPath) ||
			normalizePath(snapshot.rootPath ?? "") === normalizePath(texPath));
	const outline = belongs ? snapshot : null;
	const rootPath = outline?.rootPath ?? texPath;

	// A file switch briefly drops the project-wide snapshot. Keep rendering the
	// last complete tree for this project until the new index arrives.
	const lastFullRef = useRef<{
		root: string;
		snapshot: TexOutlineSnapshot;
	} | null>(null);
	useEffect(() => {
		if (outline?.rootPath) {
			lastFullRef.current = {
				root: normalizePath(outline.rootPath),
				snapshot: outline,
			};
		}
	}, [outline]);
	const cached =
		lastFullRef.current?.root === normalizePath(rootPath)
			? lastFullRef.current.snapshot
			: null;
	const shown = outline ?? cached;
	const rows = useMemo(
		() => buildStructure(shown?.items ?? []),
		[shown?.items],
	);

	// Keep the clicked section highlighted while its file is opening.
	const pinnedIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (outline) pinnedIdRef.current = null;
	}, [outline]);
	const activeId =
		outline != null
			? activeOutlineSectionId(outline.items, outline.cursorLine, outline.path)
			: pinnedIdRef.current;

	useEffect(() => {
		void ensureTexBuildEvents();
		void trackTexProject(rootPath);
	}, [rootPath]);

	return (
		<nav
			aria-label={t("latexPanel.structure")}
			className="flex min-h-0 flex-1 flex-col border-t border-border/70"
		>
			<p className="text-muted-foreground shrink-0 px-3 pt-2.5 pb-1 text-[10px] font-medium tracking-wide">
				{t("latexPanel.structure")}
			</p>
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{shown == null ? null : rows.length === 0 ? (
					<p className="text-muted-foreground px-2 py-1 text-xs">
						{t("latexPanel.emptyStructure")}
					</p>
				) : (
					<ul className="flex flex-col">
						{rows.map(({ item, depth }, index) => {
							const section = item.kind === "section";
							const current = section && item.id === activeId;
							const Icon =
								item.kind === "figure"
									? Image
									: item.kind === "table"
										? Table2
										: null;
							const indent = section
								? 0.5 + depth * INDENT_STEP_REM
								: 0.5 + (depth - 0.5) * INDENT_STEP_REM;
							return (
								<li key={item.id}>
									<button
										type="button"
										aria-current={current ? "location" : undefined}
										title={item.title}
										onClick={() => {
											pinnedIdRef.current = section ? item.id : null;
											navigateTexSource(item.path ?? texPath, item.line);
										}}
										className={cn(
											"flex h-7 w-full items-center gap-1.5 rounded pr-2 text-left",
											FILE_TREE_ROW_STATE,
											section
												? depth === 0
													? "font-semibold text-[13px] text-foreground"
													: depth === 1
														? "font-medium text-muted-foreground text-xs"
														: "font-normal text-[11px] text-muted-foreground/80"
												: "font-normal text-[11px] text-muted-foreground/50",
											section && depth === 0 && index > 0 && "mt-1.5",
											current && FILE_TREE_ROW_SELECTED_STATE,
										)}
										style={{
											paddingLeft: `${indent}rem`,
										}}
									>
										{item.kind === "label" ? (
											<span
												className="text-muted-foreground/35 w-4 shrink-0 text-center"
												aria-hidden
											>
												#
											</span>
										) : null}
										{Icon ? (
											<Icon
												className="text-muted-foreground/60 size-4 shrink-0"
												aria-hidden
											/>
										) : null}
										<span className="min-w-0 flex-1 truncate">
											{item.title}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</nav>
	);
}
