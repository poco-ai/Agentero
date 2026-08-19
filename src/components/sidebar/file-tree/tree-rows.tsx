import {
	ChevronRight,
	Download,
	Globe,
	Library,
	Loader2,
	ScrollText,
	Trash2,
	Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	FileTreeActions,
	FileTreeFile,
	FileTreeFolderRow,
	FileTreeIcon,
	FileTreeName,
	useFileTree,
} from "@/components/ai-elements/file-tree";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { contextPathIcon } from "@/lib/agent/context-path-icon";
import { getPlatformOS } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import {
	PLAZA_VIRTUAL_PATH,
	type PlazaSource,
	plazaSourceLabel,
} from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import { DOWNLOAD_REASON_KEYS } from "./tree-helpers";

type PaperTreeRowProps = {
	node: FileNode;
	isCut: boolean;
	label: string;
	downloadReasons: Array<keyof typeof DOWNLOAD_REASON_KEYS>;
	isDownloading: boolean;
	isReading: boolean;
	rowBusy: boolean;
	expandable: boolean;
	expanded: boolean;
	onDownload?: () => void;
	onRead?: () => void;
};

export function PaperTreeRow({
	node,
	isCut,
	label,
	downloadReasons,
	isDownloading,
	isReading,
	rowBusy,
	expandable,
	expanded,
	onDownload,
	onRead,
}: PaperTreeRowProps) {
	const { t } = useTranslation("sidebar");
	const { togglePath } = useFileTree();
	const expandLabel = expanded
		? t("fileTree.collapseAttachments")
		: t("fileTree.expandAttachments");
	const showDownload = Boolean(onDownload) && downloadReasons.length > 0;
	const showRead = Boolean(onRead) && !showDownload;
	const reasonTip = downloadReasons.length
		? downloadReasons.map((r) => t(DOWNLOAD_REASON_KEYS[r])).join(" · ")
		: t("fileTree.downloadAssets");
	const showActions = showDownload || showRead;
	return (
		<FileTreeFile
			path={node.path}
			name={label}
			className={cn(isCut && "opacity-50")}
		>
			{expandable ? (
				<Tooltip disableHoverableContent>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-expanded={expanded}
							aria-label={expandLabel}
							className={cn(
								"flex size-5 shrink-0 items-center justify-center rounded-sm",
								"text-muted-foreground hover:bg-muted/80",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
							onClick={(e) => {
								e.stopPropagation();
								e.preventDefault();
								togglePath(node.path);
							}}
							onPointerDown={(e) => e.stopPropagation()}
							onKeyDown={(e) => e.stopPropagation()}
						>
							<ChevronRight
								className={cn(
									"size-4 transition-transform",
									expanded && "rotate-90",
								)}
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent side="right" className="select-none cursor-default">
						{expandLabel}
					</TooltipContent>
				</Tooltip>
			) : (
				<span className="size-4 shrink-0" />
			)}
			<FileTreeIcon>
				<ScrollText className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				{label}
			</FileTreeName>
			{showActions ? (
				<FileTreeActions
					// Linux (WebKitGTK) and macOS (WKWebView) draw overlay scrollbars
					// that float over content with an 8px-wide hit area; Windows
					// WebView2 uses classic scrollbars that reserve layout space.
					className={cn("shrink-0", getPlatformOS() !== "windows" && "pr-2")}
					onClick={(e) => {
						e.stopPropagation();
					}}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{showDownload ? (
						<Tooltip disableHoverableContent>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-5"
									aria-label={reasonTip}
									disabled={rowBusy}
									onClick={(e) => {
										e.stopPropagation();
										onDownload?.();
									}}
								>
									{isDownloading ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Download className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="right"
								className="max-w-xs select-none cursor-default"
							>
								<p className="font-medium">{t("fileTree.downloadAssets")}</p>
								<ul className="mt-1 list-disc space-y-0.5 pl-3 text-xs opacity-90">
									{downloadReasons.map((r) => (
										<li key={r}>{t(DOWNLOAD_REASON_KEYS[r])}</li>
									))}
								</ul>
							</TooltipContent>
						</Tooltip>
					) : null}
					{showRead ? (
						<Tooltip disableHoverableContent>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-5"
									aria-label={t("fileTree.readPaper")}
									disabled={rowBusy}
									onClick={(e) => {
										e.stopPropagation();
										onRead?.();
									}}
								>
									{isReading ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Zap className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="right"
								className="max-w-xs select-none cursor-default"
							>
								<p className="font-medium">{t("fileTree.readPaper")}</p>
							</TooltipContent>
						</Tooltip>
					) : null}
				</FileTreeActions>
			) : null}
		</FileTreeFile>
	);
}

type NodeTreeRowProps = {
	node: FileNode;
	isCut: boolean;
	pendingLoad: boolean;
	expanded: boolean;
};

export function NodeTreeRow({
	node,
	isCut,
	pendingLoad,
	expanded,
}: NodeTreeRowProps) {
	if (node.kind === "directory") {
		return (
			<div
				className={cn(
					"relative flex w-full items-center",
					isCut && "opacity-50",
				)}
			>
				<div className="min-w-0 flex-1">
					<FileTreeFolderRow path={node.path} name={node.name} />
				</div>
				{pendingLoad && expanded ? (
					<Loader2
						className="pointer-events-none absolute right-2 size-3.5 shrink-0 animate-spin text-muted-foreground"
						aria-hidden
					/>
				) : null}
			</div>
		);
	}
	const Icon = contextPathIcon(node.name);
	return (
		<FileTreeFile
			path={node.path}
			name={node.name}
			icon={<Icon className="size-4 text-muted-foreground" />}
			className={cn(isCut && "opacity-50")}
		/>
	);
}

type LibraryRowProps = {
	showDownload: boolean;
	busy: boolean;
	downloadingAll: boolean;
	onDownloadAll: () => void;
};

export function LibraryRow({
	showDownload,
	busy,
	downloadingAll,
	onDownloadAll,
}: LibraryRowProps) {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile path={LIBRARY_VIRTUAL_PATH} name={t("papersLibrary.title")}>
			<span className="size-4 shrink-0" />
			<FileTreeIcon>
				<Library className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("papersLibrary.title")}
			</FileTreeName>
			{showDownload ? (
				<FileTreeActions
					className={cn("shrink-0", getPlatformOS() !== "windows" && "pr-2")}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<Tooltip disableHoverableContent>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-5"
								aria-label={t("fileTree.downloadAllMissing")}
								disabled={busy}
								onClick={(e) => {
									e.stopPropagation();
									onDownloadAll();
								}}
							>
								{downloadingAll ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Download className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="right"
							className="max-w-xs select-none cursor-default"
						>
							{t("fileTree.downloadAllMissing")}
						</TooltipContent>
					</Tooltip>
				</FileTreeActions>
			) : null}
		</FileTreeFile>
	);
}

export function TrashRow() {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile path={TRASH_VIRTUAL_PATH} name={t("recycleBin.title")}>
			<span className="size-4 shrink-0" />
			<FileTreeIcon>
				<Trash2 className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("recycleBin.title")}
			</FileTreeName>
		</FileTreeFile>
	);
}

/** 广场 parent row — collapsible, with the discovery sources as children. */
export function PlazaRow({ expanded }: { expanded: boolean }) {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile
			path={PLAZA_VIRTUAL_PATH}
			name={t("plaza.plaza")}
			aria-expanded={expanded}
		>
			<ChevronRight
				className={cn(
					"size-4 shrink-0 text-muted-foreground transition-transform",
					expanded && "rotate-90",
				)}
			/>
			<FileTreeIcon>
				<Globe className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("plaza.plaza")}
			</FileTreeName>
		</FileTreeFile>
	);
}

export function PlazaSourceRow({ source }: { source: PlazaSource }) {
	const Icon = source.icon;
	const label = plazaSourceLabel(source);
	return (
		<FileTreeFile path={source.path} name={label}>
			<span className="size-4 shrink-0" />
			<FileTreeIcon>
				<Icon className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				{label}
			</FileTreeName>
		</FileTreeFile>
	);
}

export function LoadingRows() {
	return (
		<div className="space-y-1 px-2 py-1.5" aria-hidden>
			{["one", "two", "three", "four", "five"].map((key, index) => (
				<div key={key} className="flex h-7 items-center gap-2 rounded px-2">
					<Skeleton className="size-4 shrink-0 library-shimmer" />
					<Skeleton
						className={cn(
							"library-shimmer h-3",
							index === 0 ? "w-32" : index === 1 ? "w-24" : "w-28",
						)}
					/>
				</div>
			))}
		</div>
	);
}
