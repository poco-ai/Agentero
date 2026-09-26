import { FileText, Folder, FolderOpen } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { MathText } from "@/components/ui/math-text";
import { useLibraryStore, useVaultStore } from "@/hooks/use-app-stores";
import type { PaperMetadata } from "@/lib/paper";
import { isUnderPapers } from "@/lib/paper";
import { joinVaultPath, treeFindNode, vaultRelativePath } from "@/lib/vault";
import type { FileNode } from "@/lib/vault/types";
import {
	openFolderLibrary,
	selectFileNode,
	selectLibrary,
} from "@/lib/workspace/actions";
import type { DocTab } from "@/lib/workspace/tabs";

type PaperPathBarProps = {
	tab: DocTab;
	vaultPath: string | null;
};

/** Cap the hover candidate list; large `papers/` folders are truncated. */
const MAX_CANDIDATES = 50;

/** Vault-relative paper key used by the catalog index. */
function relKey(vaultPath: string, path: string): string {
	return (vaultRelativePath(vaultPath, path) ?? path)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

function candidateLabel(
	node: FileNode,
	vaultPath: string,
	paperMetaByRelPath: ReadonlyMap<string, PaperMetadata>,
): string {
	if (node.kind === "directory") {
		const title = paperMetaByRelPath
			.get(relKey(vaultPath, node.path))
			?.title?.trim();
		if (title) return title;
	}
	return node.name;
}

function CandidateIcon({ node }: { node: FileNode }) {
	return node.kind === "directory" ? (
		<Folder className="size-4 shrink-0 text-muted-foreground" />
	) : (
		<FileText className="size-4 shrink-0 text-muted-foreground" />
	);
}

/**
 * Notion-style path bar for the active paper PDF: `papers / <paper title>`.
 * Folder segments reveal their child entries on hover (click to jump) and
 * click through to the folder's scoped Library (`papers` → full Library).
 */
export function PaperPathBar({ tab, vaultPath }: PaperPathBarProps) {
	const tree = useVaultStore((s) => s.tree);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const [openRel, setOpenRel] = useState<string | null>(null);

	const crumbs = useMemo(() => {
		if (!vaultPath) return null;
		if (tab.kind !== "paper" || tab.mode !== "pdf") return null;
		if (!isUnderPapers(tab.path)) return null;
		const rel = vaultRelativePath(vaultPath, tab.path);
		if (!rel) return null;
		const segments = rel.split("/").filter(Boolean);
		if (segments.length < 2) return null;
		const title = tab.paperMeta?.title?.trim() || tab.title;
		if (!title) return null;
		const folders = segments.slice(0, -1).map((name, index, all) => {
			const folderRel = all.slice(0, index + 1).join("/");
			const abs = joinVaultPath(vaultPath, folderRel);
			return {
				name,
				rel: folderRel,
				abs,
				children: treeFindNode(tree, abs)?.children ?? null,
			};
		});
		return { folders, title, vaultPath };
	}, [vaultPath, tree, tab.kind, tab.mode, tab.path, tab.paperMeta, tab.title]);

	if (!crumbs) return null;

	return (
		<div className="flex h-9 min-w-0 shrink-0 items-center overflow-hidden border-b border-border/50 px-3 select-none">
			<Breadcrumb className="w-full min-w-0">
				<BreadcrumbList className="min-w-0 flex-nowrap gap-1 text-xs">
					{crumbs.folders.map((folder, index) => {
						const children = folder.children ?? [];
						const isPapers = folder.rel.toLowerCase() === "papers";
						const segmentButton = (
							<button
								type="button"
								className="flex max-w-40 min-w-0 cursor-pointer items-center gap-1 truncate rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
								onClick={() => {
									setOpenRel(null);
									if (isPapers) selectLibrary();
									else openFolderLibrary(folder.abs);
								}}
							>
								{index === 0 ? (
									<FolderOpen className="size-3.5 shrink-0" />
								) : null}
								<span className="min-w-0 truncate">{folder.name}</span>
							</button>
						);

						return (
							<Fragment key={folder.rel}>
								<BreadcrumbItem className="min-w-0">
									{children.length === 0 ? (
										segmentButton
									) : (
										<HoverCard
											open={openRel === folder.rel}
											onOpenChange={(open) =>
												setOpenRel(open ? folder.rel : null)
											}
											openDelay={120}
											closeDelay={120}
										>
											<HoverCardTrigger asChild>
												{segmentButton}
											</HoverCardTrigger>
											<HoverCardContent align="start" className="w-72 p-1">
												<ul className="max-h-80 overflow-y-auto">
													{children.slice(0, MAX_CANDIDATES).map((child) => (
														<li key={child.path}>
															<button
																type="button"
																className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
																onClick={() => {
																	setOpenRel(null);
																	selectFileNode(child);
																}}
															>
																<CandidateIcon node={child} />
																<span className="min-w-0 flex-1 truncate">
																	{candidateLabel(
																		child,
																		crumbs.vaultPath,
																		paperMetaByRelPath,
																	)}
																</span>
																{child.children && child.children.length > 0 ? (
																	<span className="text-muted-foreground">
																		›
																	</span>
																) : null}
															</button>
														</li>
													))}
													{children.length > MAX_CANDIDATES ? (
														<li className="px-2 py-1.5 text-muted-foreground text-xs">
															+{children.length - MAX_CANDIDATES}
														</li>
													) : null}
												</ul>
											</HoverCardContent>
										</HoverCard>
									)}
								</BreadcrumbItem>
								<BreadcrumbSeparator className="shrink-0" />
							</Fragment>
						);
					})}
					<BreadcrumbItem className="min-w-0 flex-1">
						<BreadcrumbPage className="block w-full truncate">
							<MathText text={crumbs.title} />
						</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>
		</div>
	);
}
