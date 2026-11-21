import { ExternalLink, FileText, Languages, RotateCw } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { MoveDestinationPicker } from "@/components/sidebar/file-tree/move-destination-picker";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useLibraryStore, useVaultStore } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	type HuggingFacePaper,
	loadHuggingFacePapers,
} from "@/lib/plaza/huggingface";
import { importPlazaPaper } from "@/lib/plaza/import";
import { matchingImportedIds } from "@/lib/plaza/imported";
import { runTranslate } from "@/lib/translate";

export function PlazaHuggingFaceView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [request, setRequest] = useState({ date: "" });
	const { date } = request;
	const reload = () => setRequest({ date });
	const [papers, setPapers] = useState<HuggingFacePaper[]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [destination, setDestination] = useState<{
		vaultPath: string | null;
		folder: string;
	} | null>(null);
	const vaultPath = useVaultStore((state) => state.vaultPath);
	const library = useLibraryStore((state) => state.papers);
	const importedIds = useMemo(
		() =>
			new Set(
				matchingImportedIds(
					papers.map((paper) => paper.arxivId),
					library,
				),
			),
		[papers, library],
	);

	useEffect(() => {
		const controller = new AbortController();
		setStatus("loading");
		loadHuggingFacePapers(request.date, controller.signal).then(
			(next) => {
				if (controller.signal.aborted) return;
				setPapers(next);
				setStatus("ready");
			},
			() => {
				if (!controller.signal.aborted) setStatus("error");
			},
		);
		return () => controller.abort();
	}, [request]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
				<Button
					type="button"
					size="sm"
					variant={date ? "ghost" : "secondary"}
					onClick={() => setRequest({ date: "" })}
				>
					{t("plaza.huggingfacePage.latest")}
				</Button>
				<Input
					type="date"
					className="h-8 w-auto"
					value={date}
					aria-label={t("plaza.huggingfacePage.editionDate")}
					onChange={(event) => setRequest({ date: event.target.value })}
				/>
				<Button
					type="button"
					className="ml-auto"
					variant="ghost"
					size="icon-sm"
					aria-label={t("plaza.reload")}
					title={t("plaza.reload")}
					disabled={status === "loading"}
					onClick={reload}
				>
					<RotateCw aria-hidden />
				</Button>
			</div>
			<div
				className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3"
				aria-busy={status === "loading"}
			>
				{status === "loading" ? (
					<EmptyState>{t("plaza.huggingfacePage.loading")}</EmptyState>
				) : status === "error" ? (
					<EmptyState className="flex flex-col gap-2">
						{t("plaza.huggingfacePage.loadFailed")}
						<Button type="button" size="sm" variant="outline" onClick={reload}>
							{t("plaza.reload")}
						</Button>
					</EmptyState>
				) : papers.length === 0 ? (
					<EmptyState>{t("plaza.huggingfacePage.empty")}</EmptyState>
				) : (
					<div className="mx-auto grid max-w-7xl grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] items-start gap-3">
						{papers.map((paper) => (
							<PaperCard
								key={`${vaultPath ?? ""}:${paper.arxivId}`}
								paper={paper}
								imported={importedIds.has(paper.arxivId)}
								vaultPath={vaultPath}
								lastFolder={
									destination?.vaultPath === vaultPath
										? destination.folder
										: null
								}
								rememberFolder={(folder) =>
									setDestination({ vaultPath, folder })
								}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function PaperCard({
	paper,
	imported,
	vaultPath,
	lastFolder,
	rememberFolder,
}: {
	paper: HuggingFacePaper;
	imported: boolean;
	vaultPath: string | null;
	lastFolder: string | null;
	rememberFolder: (folder: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const popupId = useId();
	const tree = useVaultStore((state) => state.tree);
	const [expanded, setExpanded] = useState(false);
	const [translation, setTranslation] = useState<string | null>(null);
	const [showTranslation, setShowTranslation] = useState(false);
	const [translating, setTranslating] = useState(false);
	const [importState, setImportState] = useState<"idle" | "pending" | "done">(
		"idle",
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [newFolder, setNewFolder] = useState("");
	const url = `https://huggingface.co/papers/${paper.arxivId}`;
	const isImported = imported || importState === "done";

	async function translateAbstract() {
		if (translation) {
			setShowTranslation(!showTranslation);
			setExpanded(true);
			return;
		}
		setTranslating(true);
		try {
			setTranslation(
				await runTranslate({
					text: paper.abstract,
					context: {
						surface: "huggingface-daily-papers",
						paperId: paper.arxivId,
					},
				}),
			);
			setShowTranslation(true);
			setExpanded(true);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setTranslating(false);
		}
	}

	async function importTo(folder: string) {
		setPickerOpen(false);
		setImportState("pending");
		rememberFolder(folder);
		const ok = await importPlazaPaper(
			{
				id: paper.arxivId,
				url: `https://arxiv.org/abs/${paper.arxivId}`,
				title: paper.title,
			},
			folder,
		);
		setImportState(ok ? "done" : "idle");
	}

	const importLabel = isImported
		? t("plaza.feeds.imported")
		: importState === "pending"
			? t("plaza.huggingfacePage.importing")
			: t("plaza.feeds.import");
	const importDisabled = isImported || importState === "pending" || !vaultPath;

	return (
		<article className="min-w-0 overflow-hidden rounded-lg border bg-background">
			<PaperCover key={paper.thumbnail} thumbnail={paper.thumbnail} />
			<div className="p-3">
				<h2 className="break-words font-medium text-sm leading-snug">
					{paper.title}
				</h2>
				{paper.authors.length > 0 && (
					<p
						className="mt-1 line-clamp-2 text-muted-foreground text-xs"
						title={paper.authors.join(", ")}
					>
						{paper.authors.join(", ")}
					</p>
				)}
				<div className="mt-1 flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground">
					{paper.edition && (
						<time dateTime={paper.edition}>{paper.edition}</time>
					)}
					{paper.upvotes !== undefined && (
						<span>
							{t("plaza.huggingfacePage.votes", { count: paper.upvotes })}
						</span>
					)}
				</div>
				{paper.abstract && (
					<SelectionSurface
						source={{
							sourcePath: url,
							sourceUrl: url,
							sourceTitle: paper.title,
							origin: "markdown",
							surface: "abstract",
						}}
						className={cn(
							"mt-2 whitespace-pre-wrap break-words select-text text-muted-foreground text-xs leading-relaxed",
							!expanded && "line-clamp-3",
						)}
					>
						{showTranslation ? translation : paper.abstract}
					</SelectionSurface>
				)}
				<div className="mt-2 flex flex-wrap items-center gap-1">
					{paper.abstract && (
						<>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								aria-expanded={expanded}
								onClick={() => setExpanded(!expanded)}
							>
								{t(
									expanded
										? "plaza.huggingfacePage.collapseAbstract"
										: "plaza.huggingfacePage.expandAbstract",
								)}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={translating}
								onClick={() => void translateAbstract()}
							>
								<Languages aria-hidden />
								{t(
									translating
										? "plaza.huggingfacePage.translating"
										: showTranslation
											? "plaza.huggingfacePage.showOriginal"
											: translation
												? "plaza.huggingfacePage.showTranslation"
												: "plaza.huggingfacePage.translate",
								)}
							</Button>
						</>
					)}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => openExternalUrl(url)}
					>
						<ExternalLink aria-hidden />
						{t("plaza.feeds.openOriginal")}
					</Button>
					<Popover
						open={pickerOpen}
						onOpenChange={(open) => {
							setPickerOpen(open);
							if (!open) setNewFolder("");
						}}
					>
						<PopoverTrigger asChild>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={importDisabled}
							>
								{importLabel}
							</Button>
						</PopoverTrigger>
						{pickerOpen && (
							<MoveDestinationPicker
								vaultPath={vaultPath}
								nodes={tree}
								sourcePaths={[]}
								selectedFolder={lastFolder ?? currentLookupParentDir()}
								newFolder={newFolder}
								busy={false}
								onNewFolderChange={setNewFolder}
								onConfirm={importTo}
								title={t("plaza.importToFolder")}
								idPrefix={popupId}
								side="bottom"
							/>
						)}
					</Popover>
				</div>
			</div>
		</article>
	);
}

function PaperCover({ thumbnail }: { thumbnail: string | null }) {
	const [failed, setFailed] = useState(false);
	return (
		<div
			className="relative aspect-[2/1] overflow-hidden border-b bg-muted/50"
			aria-hidden
		>
			<div className="absolute inset-0 grid place-items-center text-muted-foreground/50">
				<FileText className="size-9" />
			</div>
			{thumbnail && !failed && (
				<img
					alt=""
					src={thumbnail}
					loading="lazy"
					decoding="async"
					referrerPolicy="no-referrer"
					className="relative h-full w-full bg-muted object-contain"
					onError={() => setFailed(true)}
				/>
			)}
		</div>
	);
}
