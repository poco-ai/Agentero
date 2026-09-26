import { FolderOpen } from "lucide-react";
import { Fragment, useMemo } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { MathText } from "@/components/ui/math-text";
import { isUnderPapers } from "@/lib/paper";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault";
import { setTreeSelectedPath } from "@/lib/vault/store";
import type { DocTab } from "@/lib/workspace/tabs";

type PaperPathBarProps = {
	tab: DocTab;
	vaultPath: string | null;
};

/**
 * Notion-style path bar for the active paper PDF: `papers / <paper title>`.
 * The catalog id segment is replaced by the paper title; folder segments
 * reveal the folder in the left file tree.
 */
export function PaperPathBar({ tab, vaultPath }: PaperPathBarProps) {
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
		return { folders: segments.slice(0, -1), title, vaultPath };
	}, [vaultPath, tab.kind, tab.mode, tab.path, tab.paperMeta, tab.title]);

	if (!crumbs) return null;

	return (
		<div className="flex h-8 shrink-0 items-center border-b border-border/50 px-3 select-none">
			<Breadcrumb>
				<BreadcrumbList className="flex-nowrap gap-1 text-xs">
					{crumbs.folders.map((folder, index) => {
						const folderRel = crumbs.folders.slice(0, index + 1).join("/");
						return (
							<Fragment key={folderRel}>
								<BreadcrumbItem className="min-w-0">
									<BreadcrumbLink asChild>
										<button
											type="button"
											className="flex max-w-40 items-center gap-1 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
											onClick={() =>
												setTreeSelectedPath(
													joinVaultPath(crumbs.vaultPath, folderRel),
												)
											}
										>
											{index === 0 ? (
												<FolderOpen className="size-3.5 shrink-0" />
											) : null}
											<span className="truncate">{folder}</span>
										</button>
									</BreadcrumbLink>
								</BreadcrumbItem>
								<BreadcrumbSeparator className="shrink-0" />
							</Fragment>
						);
					})}
					<BreadcrumbItem className="min-w-0 flex-1">
						<BreadcrumbPage className="block max-w-full truncate">
							<MathText text={crumbs.title} />
						</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>
		</div>
	);
}
