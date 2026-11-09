import { Check, Folder, FolderPlus, Library } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PopoverContent } from "@/components/ui/popover";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { usePapersOrgFolders } from "@/hooks/use-papers-org-folders";
import { normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import type { FileNode } from "@/lib/vault";

type MoveDestinationPickerProps = {
	vaultPath: string | null;
	nodes: FileNode[];
	sourcePaths: string[];
	selectedFolder: string;
	newFolder: string;
	busy: boolean;
	onNewFolderChange: (value: string) => void;
	onConfirm: (dest: string) => void | Promise<void>;
	/** Heading text; defaults to the file-tree move wording. */
	title?: string;
	/** Unique input id prefix when several pickers can exist. */
	idPrefix?: string;
	/** Popover side; the tree opens to the right, inline menus below. */
	side?: "right" | "bottom";
};

export function MoveDestinationPicker({
	vaultPath,
	nodes,
	sourcePaths,
	selectedFolder,
	newFolder,
	busy,
	onNewFolderChange,
	onConfirm,
	title,
	idPrefix = "move",
	side = "right",
}: MoveDestinationPickerProps) {
	const { t } = useTranslation("sidebar");
	const { isBlockedByIme, compositionProps } = useImeGuard();
	const folders = usePapersOrgFolders(vaultPath, nodes, sourcePaths);
	const typed = newFolder.trim();
	const dest = typed
		? normalizePath(typed.startsWith("papers") ? typed : `papers/${typed}`)
		: selectedFolder;
	const destValid = dest.startsWith("papers");
	const inputId = `${idPrefix}-new-folder`;

	const handleSelect = (folder: string) => {
		onNewFolderChange("");
		void onConfirm(folder);
	};

	return (
		<PopoverContent
			align="start"
			side={side}
			sideOffset={4}
			avoidCollisions
			className="w-56 p-2"
			onEscapeKeyDown={(e) => {
				if (isBlockedByIme(e)) e.preventDefault();
			}}
		>
			<div className="space-y-2">
				<p className="font-medium text-xs text-foreground">
					{title ?? t("fileTree.moveToFolder", { count: sourcePaths.length })}
				</p>
				<div className="rounded-md border p-1">
					<div className="agentero-scroll max-h-[min(50vh,18rem)] space-y-0.5 overflow-y-auto overscroll-contain">
						{folders.map((folder) => {
							const active = !typed && selectedFolder === folder;
							const depth = folder.split("/").length - 1;
							const label =
								folder === "papers"
									? t("fileTree.movePicker.papersRoot")
									: (folder.split("/").pop() ?? folder);
							return (
								<button
									key={folder}
									type="button"
									disabled={busy}
									title={folder}
									className={cn(
										"flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
										active && "bg-muted",
									)}
									style={{ paddingLeft: 8 + depth * 12 }}
									onClick={() => handleSelect(folder)}
								>
									{folder === "papers" ? (
										<Library
											className="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden
										/>
									) : (
										<Folder
											className="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden
										/>
									)}
									<span className="min-w-0 flex-1 truncate">{label}</span>
									{active ? (
										<Check className="size-3 shrink-0 text-primary" />
									) : null}
								</button>
							);
						})}
					</div>
				</div>
				<div className="space-y-1">
					<Label
						htmlFor={inputId}
						className="text-caption text-muted-foreground"
					>
						{t("fileTree.movePicker.newFolder")}
					</Label>
					<div className="relative">
						<FolderPlus className="-translate-y-1/2 absolute top-1/2 left-2 size-3 text-muted-foreground" />
						<Input
							id={inputId}
							value={newFolder}
							onChange={(e) => onNewFolderChange(e.target.value)}
							placeholder={t("fileTree.movePicker.newFolderHint")}
							disabled={busy}
							spellCheck={false}
							className="h-7 pl-6 text-xs font-mono"
							onKeyDown={(e) => {
								e.stopPropagation();
								if (isBlockedByIme(e)) return;
								if (e.key === "Enter" && destValid) {
									e.preventDefault();
									void onConfirm(dest);
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
			</div>
		</PopoverContent>
	);
}
