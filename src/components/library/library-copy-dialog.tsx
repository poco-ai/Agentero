/**
 * "Copy to folder" dialog for the papers library: pick a folder under
 * `papers/` (or type a new one), then duplicate the selected paper folders
 * into it. A modal works better than the file tree's anchored popover here
 * because the action starts from a context menu that closes immediately.
 */
import { Check, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVaultStore } from "@/hooks/use-app-stores";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { usePapersOrgFolders } from "@/hooks/use-papers-org-folders";
import { normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import type { PaperLibraryRow } from "@/lib/paper";

const DEFAULT_FOLDER = "papers";

export function LibraryCopyDialog({
	open,
	papers,
	vaultPath,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	papers: PaperLibraryRow[];
	vaultPath: string | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (destParentRel: string) => Promise<void>;
}) {
	const { t } = useTranslation("sidebar");
	const tree = useVaultStore((s) => s.tree);
	const { isBlockedByIme, compositionProps } = useImeGuard();
	const [selectedFolder, setSelectedFolder] = useState(DEFAULT_FOLDER);
	const [newFolder, setNewFolder] = useState("");
	const [busy, setBusy] = useState(false);

	// Never offer a paper's own folder as a destination.
	const sourcePaths = papers
		.map((paper) => paper.path)
		.filter((path): path is string => Boolean(path));
	const folders = usePapersOrgFolders(vaultPath, tree, sourcePaths);

	useEffect(() => {
		if (!open) return;
		setSelectedFolder(DEFAULT_FOLDER);
		setNewFolder("");
		setBusy(false);
	}, [open]);

	const typed = newFolder.trim();
	const dest = typed
		? normalizePath(typed.startsWith("papers") ? typed : `papers/${typed}`)
		: selectedFolder;
	const destValid = dest === "papers" || dest.startsWith("papers/");

	const runCopy = async (folder: string) => {
		setBusy(true);
		try {
			await onConfirm(folder);
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && busy) return;
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle>
						{t("papersLibrary.copy.title", { count: papers.length })}
					</DialogTitle>
				</DialogHeader>

				<div className="agentero-scroll max-h-[min(50vh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain rounded-md border p-1">
					{folders.map((folder) => {
						const active = !typed && selectedFolder === folder;
						return (
							<button
								key={folder}
								type="button"
								disabled={busy}
								className={cn(
									"group flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent disabled:opacity-60",
									active && "bg-muted",
								)}
								onClick={() => void runCopy(folder)}
							>
								<span className="min-w-0 flex-1 truncate font-mono group-hover:overflow-visible group-hover:whitespace-normal group-hover:break-all">
									{folder === "papers"
										? t("fileTree.movePicker.papersRoot")
										: folder}
								</span>
								{active ? (
									<Check className="mt-0.5 size-3 shrink-0 text-primary" />
								) : null}
							</button>
						);
					})}
				</div>

				<div className="space-y-1">
					<Label
						htmlFor="copy-new-folder"
						className="text-caption text-muted-foreground"
					>
						{t("fileTree.movePicker.newFolder")}
					</Label>
					<div className="relative">
						<FolderPlus className="-translate-y-1/2 absolute top-1/2 left-2 size-3 text-muted-foreground" />
						<Input
							id="copy-new-folder"
							value={newFolder}
							onChange={(e) => setNewFolder(e.target.value)}
							placeholder={t("fileTree.movePicker.newFolderHint")}
							disabled={busy}
							spellCheck={false}
							className="h-7 pl-6 font-mono text-xs"
							onKeyDown={(e) => {
								if (isBlockedByIme(e)) return;
								if (e.key === "Enter" && destValid) {
									e.preventDefault();
									void runCopy(dest);
								}
							}}
							{...compositionProps}
						/>
					</div>
					{typed && !destValid ? (
						<p className="text-caption text-destructive">
							{t("fileTree.movePicker.invalidFolderPath")}
						</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						{t("papersLibrary.copy.cancel")}
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={busy || !destValid}
						onClick={() => void runCopy(dest)}
					>
						{busy
							? t("papersLibrary.copy.busy")
							: t("papersLibrary.copy.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
