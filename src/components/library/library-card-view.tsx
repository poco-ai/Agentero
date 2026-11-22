import {
	Check,
	Ellipsis,
	FileText,
	Folder,
	FolderOpen,
	MessageSquarePlus,
	Pencil,
	Trash2,
} from "lucide-react";
import {
	type MouseEvent,
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { LibraryFolder } from "@/components/library/library-folders";
import { LibraryPaperMenuItems } from "@/components/library/library-row-menu";
import {
	addedDate,
	type PaperRow,
} from "@/components/library/library-row-utils";
import {
	folderSelectionKey,
	paperSelectionKey,
} from "@/components/library/library-selection";
import { PaperTitle } from "@/components/paper/paper-title";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInView } from "@/hooks/use-in-view";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import { loadLibraryThumbnail } from "@/lib/pdf/library-thumbnail";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { revealInFileManager, revealInOsLabelKey } from "@/lib/vault/reveal";

const gridClass =
	"grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-4 gap-y-5";
const cardClass =
	"block w-full min-w-0 cursor-pointer select-none rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const cardSurfaceClass =
	"group relative isolate min-w-0 before:pointer-events-none before:absolute before:-inset-1.5 before:-z-1 before:rounded-2xl data-selected:before:bg-primary/15 motion-safe:before:transition-colors motion-safe:before:duration-(--motion-duration-fast)";
const cardControlClass =
	"absolute top-2 z-10 cursor-pointer rounded-full border-border/60 bg-popover text-popover-foreground shadow-raised hover:bg-accent focus-visible:border-ring [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 aria-checked:pointer-events-auto aria-checked:opacity-100 motion-reduce:transition-none";
const cardTitleClass = "mt-2 text-sm font-medium leading-5";
const cardCaptionClass = "mt-0.5 block text-muted-foreground text-xs";
const sectionHeadingClass = "mb-2 text-muted-foreground text-xs font-medium";
const folderStackLayouts = [
	[],
	["top-[47%] left-[51%] rotate-6 group-hover:-translate-y-1"],
	[
		"top-[53%] left-[36%] -rotate-9 group-hover:-translate-x-1.5 group-hover:-translate-y-1",
		"top-[47%] left-[54%] rotate-6 group-hover:translate-x-1 group-hover:-translate-y-0.5",
	],
	[
		"top-[56%] left-[28%] -rotate-10 group-hover:-translate-x-1.5 group-hover:-translate-y-1",
		"top-[49%] left-[44%] -rotate-2",
		"top-[54%] left-[60%] rotate-7 group-hover:translate-x-1 group-hover:-translate-y-0.5",
	],
];

function CoverFrame({
	children,
}: {
	children: (inView: boolean) => ReactNode;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { rootMargin: "160px 0px", keepAlive: false });
	return (
		<span
			ref={ref}
			aria-hidden
			className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-muted/40 group-hover:shadow-raised motion-safe:transition-shadow motion-safe:duration-(--motion-duration-fast) motion-safe:ease-(--motion-ease-out)"
		>
			{children(inView)}
			<span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-border/70 ring-inset" />
		</span>
	);
}

function PdfThumbnail({
	path,
	className,
	fallback = null,
}: {
	path: string;
	className: string;
	fallback?: ReactNode;
}) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		setUrl(null);
		const controller = new AbortController();
		let objectUrl: string | null = null;
		void loadLibraryThumbnail(path, controller.signal).then((cover) => {
			if (!cover || controller.signal.aborted) return;
			objectUrl = URL.createObjectURL(cover);
			setUrl(objectUrl);
		});
		return () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path]);

	return url ? (
		<img
			src={url}
			alt=""
			draggable={false}
			className={cn(
				"pointer-events-none absolute bg-white object-cover object-top",
				className,
			)}
		/>
	) : (
		fallback
	);
}

type SelectCard = (key: string, mods: { shift: boolean }) => void;

function CardControls({
	title,
	selected,
	onToggle,
	children,
}: {
	title: string;
	selected: boolean;
	onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
	children: ReactNode;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<>
			<Button
				type="button"
				role="checkbox"
				variant="ghost"
				size="icon-sm"
				className={cn(
					cardControlClass,
					"left-2 border",
					selected &&
						"border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
				)}
				aria-label={t(
					selected
						? "papersLibrary.selection.deselectItem"
						: "papersLibrary.selection.selectRow",
					{ title },
				)}
				aria-checked={selected}
				onClick={onToggle}
			>
				{selected ? (
					<Check aria-hidden />
				) : (
					<span
						className="size-3.5 rounded-full border border-muted-foreground/65"
						aria-hidden
					/>
				)}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn(cardControlClass, "right-2")}
						aria-label={t("papersLibrary.cardActions", { title })}
					>
						<Ellipsis aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="bottom" align="start" className="w-52">
					{children}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}

const PaperCard = memo(function PaperCard({
	row,
	index,
	vaultPath,
	selected,
	dateFormat,
	onSelect,
	onPaperClick,
}: {
	row: PaperRow;
	index: number;
	vaultPath: string | null;
	selected: boolean;
	dateFormat: Intl.DateTimeFormat;
	onSelect: SelectCard;
	onPaperClick: (
		event: MouseEvent<HTMLButtonElement>,
		paper: PaperMetadata,
	) => void;
}) {
	const { t } = useTranslation("sidebar");
	const paper = row.paper;
	const title = paper.title?.trim() || paper.id;
	const date = addedDate(paper.added_at);
	const path =
		vaultPath && paper.path && paper.has_pdf !== false
			? joinVaultPath(vaultPath, paper.path)
			: null;
	const fallback = <FileText className="size-8 text-muted-foreground/65" />;
	return (
		<li
			className={cardSurfaceClass}
			data-library-card
			data-selected={selected || undefined}
			data-library-paper
			data-index={index}
		>
			<button
				type="button"
				data-hint
				data-hint-priority="1"
				className={cardClass}
				onClick={(event) => onPaperClick(event, paper)}
			>
				<CoverFrame>
					{(inView) =>
						inView && path ? (
							<PdfThumbnail
								key={paper.updated_at}
								path={path}
								className="inset-0 size-full"
								fallback={fallback}
							/>
						) : (
							fallback
						)
					}
				</CoverFrame>
				<PaperTitle
					text={title}
					className={cn(cardTitleClass, "line-clamp-2")}
				/>
				{date ? (
					<time dateTime={date.toISOString()} className={cardCaptionClass}>
						{t("papersLibrary.addedOn", { date: dateFormat.format(date) })}
					</time>
				) : null}
			</button>
			<CardControls
				title={title}
				selected={selected}
				onToggle={(event) =>
					onSelect(paperSelectionKey(paper), { shift: event.shiftKey })
				}
			>
				<LibraryPaperMenuItems row={row} mode="dropdown" />
			</CardControls>
		</li>
	);
});

export function LibraryCardView({
	folders,
	rows,
	vaultPath,
	visible,
	selectedKeys,
	selectionActive,
	onSelect,
	onNavigateFolder,
	onRenameFolder,
	onDeleteFolder,
	onPaperClick,
}: {
	folders: LibraryFolder[];
	rows: PaperRow[];
	vaultPath: string | null;
	visible: boolean;
	selectedKeys: ReadonlySet<string>;
	selectionActive: boolean;
	onSelect: SelectCard;
	onNavigateFolder?: (path: string) => void;
	onRenameFolder?: (absPath: string, name: string) => void;
	onDeleteFolder?: (absPath: string) => void;
	onPaperClick: (
		event: MouseEvent<HTMLButtonElement>,
		paper: PaperMetadata,
	) => void;
}) {
	const { t, i18n } = useTranslation("sidebar");
	const dateFormat = useMemo(
		() => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
		[i18n.language],
	);
	const localVaultPath =
		visible && vaultPath && !isRemoteVaultHandle(vaultPath) ? vaultPath : null;
	return (
		<div className="space-y-6 px-6 py-4 sm:px-7">
			{folders.length > 0 ? (
				<section aria-label={t("papersLibrary.folders")}>
					<h2 className={sectionHeadingClass}>{t("papersLibrary.folders")}</h2>
					<ul className={gridClass}>
						{folders.map(({ name, path, paperCount, previews }) => {
							const key = folderSelectionKey(path);
							const selected = selectedKeys.has(key);
							const absPath = vaultPath ? joinVaultPath(vaultPath, path) : null;
							return (
								<li
									key={key}
									className={cardSurfaceClass}
									data-library-card
									data-selected={selected || undefined}
								>
									<button
										type="button"
										title={name}
										className={cardClass}
										onClick={(event) => {
											if (
												selectionActive ||
												event.shiftKey ||
												event.metaKey ||
												event.ctrlKey
											) {
												onSelect(key, { shift: event.shiftKey });
											} else {
												onNavigateFolder?.(path);
											}
										}}
									>
										<CoverFrame>
											{(inView) => (
												<>
													{paperCount === 0 ? (
														<Folder className="size-8 text-muted-foreground/65" />
													) : (
														<span className="absolute top-2 left-2 flex size-7 items-center justify-center rounded-lg bg-foreground/65 text-background group-data-selected:opacity-0 group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 [@media(hover:none)]:opacity-0">
															<Folder className="size-4" />
														</span>
													)}
													{inView && localVaultPath
														? previews.map((preview, index) => (
																<PdfThumbnail
																	key={`${preview.path}:${preview.revision}`}
																	path={joinVaultPath(
																		localVaultPath,
																		preview.path,
																	)}
																	className={cn(
																		"aspect-[3/4] w-[34%] rounded-md shadow-raised ring-1 ring-black/10 motion-safe:transition-transform motion-safe:duration-(--motion-duration-normal) motion-safe:ease-(--motion-ease-out) motion-reduce:translate-none",
																		folderStackLayouts[previews.length]?.[
																			index
																		],
																	)}
																/>
															))
														: null}
												</>
											)}
										</CoverFrame>
										<span className={cn(cardTitleClass, "block truncate")}>
											{name}
										</span>
										<span className={cardCaptionClass}>
											{t("papersLibrary.folderPaperCount", {
												count: paperCount,
											})}
										</span>
									</button>
									<CardControls
										title={name}
										selected={selected}
										onToggle={(event) =>
											onSelect(key, { shift: event.shiftKey })
										}
									>
										<DropdownMenuItem onSelect={() => onNavigateFolder?.(path)}>
											<FolderOpen className="size-3.5" />
											{t("papersLibrary.rowOpen")}
										</DropdownMenuItem>
										{absPath ? (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													onSelect={() => {
														broadcastAgentAttachContext([absPath]);
														presentAgentComposer();
													}}
												>
													<MessageSquarePlus className="size-3.5" />
													{t("fileTree.addToChat")}
												</DropdownMenuItem>
												{vaultPath && !isRemoteVaultHandle(vaultPath) ? (
													<DropdownMenuItem
														onSelect={() =>
															void revealInFileManager(absPath).catch(() =>
																notifyError(t("fileTree.revealFailed")),
															)
														}
													>
														<FolderOpen className="size-3.5" />
														{t(revealInOsLabelKey())}
													</DropdownMenuItem>
												) : null}
												{onRenameFolder || onDeleteFolder ? (
													<DropdownMenuSeparator />
												) : null}
												{onRenameFolder ? (
													<DropdownMenuItem
														onSelect={() => onRenameFolder(absPath, name)}
													>
														<Pencil className="size-3.5" />
														{t("fileTree.rename")}
													</DropdownMenuItem>
												) : null}
												{onDeleteFolder ? (
													<DropdownMenuItem
														variant="destructive"
														onSelect={() => onDeleteFolder(absPath)}
													>
														<Trash2 className="size-3.5" />
														{t("fileTree.delete")}
													</DropdownMenuItem>
												) : null}
											</>
										) : null}
									</CardControls>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
			{rows.length > 0 ? (
				<section aria-label={t("papersLibrary.papers")}>
					<h2 className={sectionHeadingClass}>{t("papersLibrary.papers")}</h2>
					<ul className={gridClass}>
						{rows.map((row, index) => (
							<PaperCard
								key={paperSelectionKey(row.paper)}
								row={row}
								index={index}
								vaultPath={localVaultPath}
								selected={selectedKeys.has(paperSelectionKey(row.paper))}
								onSelect={onSelect}
								dateFormat={dateFormat}
								onPaperClick={onPaperClick}
							/>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
