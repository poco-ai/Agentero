import { Check, FolderPlus, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/core/utils";

export function normalizeNewFolderInput(input: string): string {
	const trimmed = input
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return "";
	if (trimmed === "papers" || trimmed.startsWith("papers/")) return trimmed;
	return `papers/${trimmed}`;
}

export function isValidPapersParentDir(path: string): boolean {
	if (!path) return false;
	if (path !== "papers" && !path.startsWith("papers/")) return false;
	return path
		.split("/")
		.every((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * "Import into library" folder picker, shared by the References panel cards and
 * the PDF citation hover card: existing `papers/…` folders plus a new-folder
 * input; choosing either triggers the import.
 */
export function CitationImportPopover({
	citationId,
	folders,
	lastImportParentDir,
	importing,
	onImport,
	onOpenChange,
	children,
}: {
	citationId: string;
	folders: string[];
	lastImportParentDir: string;
	importing: boolean;
	onImport: (parentDir: string) => void;
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
}) {
	const { t } = useTranslation("viewer");
	const [open, setOpen] = useState(false);
	const [newFolder, setNewFolder] = useState("");

	const typed = newFolder.trim();
	const normalizedNew = typed ? normalizeNewFolderInput(typed) : "";
	const newValid = Boolean(
		normalizedNew && isValidPapersParentDir(normalizedNew),
	);

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) setNewFolder("");
		onOpenChange?.(next);
	};

	const select = (folder: string) => {
		setOpen(false);
		setNewFolder("");
		onImport(folder);
	};

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				align="end"
				side="bottom"
				sideOffset={4}
				className="w-56 p-2"
			>
				<div className="space-y-2">
					<p className="font-medium text-xs text-foreground">
						{t("references.importToFolder")}
					</p>
					<ScrollArea className="h-40 rounded-md border">
						<div className="space-y-0.5 p-1">
							{folders.map((folder) => {
								const active = folder === lastImportParentDir;
								return (
									<button
										key={folder}
										type="button"
										disabled={importing}
										className={cn(
											"flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
											active && "bg-muted",
										)}
										onClick={() => select(folder)}
									>
										<span className="flex-1 truncate font-mono">{folder}</span>
										{active ? (
											<Check className="size-3 shrink-0 text-primary" />
										) : null}
									</button>
								);
							})}
						</div>
					</ScrollArea>
					<div className="space-y-1">
						<Label
							htmlFor={`ref-new-folder-${citationId}`}
							className="text-caption text-muted-foreground"
						>
							{t("references.newFolder")}
						</Label>
						<div className="relative">
							<FolderPlus className="-translate-y-1/2 absolute top-1/2 left-2 size-3 text-muted-foreground" />
							<Input
								id={`ref-new-folder-${citationId}`}
								value={newFolder}
								onChange={(e) => setNewFolder(e.target.value)}
								placeholder={t("references.newFolderHint")}
								disabled={importing}
								spellCheck={false}
								className="h-7 pl-6 text-xs font-mono"
								onKeyDown={(e) => {
									if (e.key === "Enter" && newValid) {
										e.preventDefault();
										select(normalizedNew);
									}
								}}
							/>
						</div>
						{typed && !newValid ? (
							<p className="text-caption text-destructive">
								{t("references.invalidFolderPath")}
							</p>
						) : null}
					</div>
					{importing ? (
						<p className="flex items-center gap-1.5 text-caption text-muted-foreground">
							<Loader2 className="size-3 animate-spin" aria-hidden />
							{t("references.importing")}
						</p>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}
