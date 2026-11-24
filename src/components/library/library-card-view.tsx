import {
	Check,
	Ellipsis,
	FileText,
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
	useId,
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
const cardSurfaceClass = "group relative isolate min-w-0";
const cardIconClass =
	"cursor-pointer rounded-full border-border/60 bg-popover text-popover-foreground shadow-raised hover:bg-accent focus-visible:border-ring motion-reduce:transition-none";
const cardControlClass = cn(
	cardIconClass,
	"absolute top-2 z-10 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 aria-checked:pointer-events-auto aria-checked:opacity-100",
);
const selectedControlClass =
	"border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground";
const folderPocketClass =
	"absolute inset-x-0 bottom-0 h-(--folder-pocket-height) rounded-xl";
const folderControlVisibilityClass =
	"[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100";
const cardTitleClass = "mt-2 text-sm font-medium leading-5";
const cardCaptionClass = "mt-0.5 block text-muted-foreground text-xs";
const sectionHeadingClass = "mb-2 text-muted-foreground text-xs font-medium";
const folderStackLayouts = [
	[],
	["top-[16%] left-[13%]"],
	[
		"top-[13%] left-[15%] rotate-5 [--folder-paper-x:0.3125rem]",
		"top-[17%] left-[12%] [--folder-paper-x:-0.1875rem]",
	],
	[
		"top-[13%] left-[9%] -rotate-5 [--folder-paper-x:-0.375rem]",
		"top-[14%] left-[16%] rotate-5 [--folder-paper-x:0.375rem]",
		"top-[18%] left-[12%]",
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

function FolderArtwork({
	previews,
	vaultPath,
}: {
	previews: LibraryFolder["previews"];
	vaultPath: string | null;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { rootMargin: "160px 0px", keepAlive: false });
	return (
		<span
			aria-hidden
			className="pointer-events-none absolute inset-0 text-(--folder-fill) peer-hover/open:text-[color-mix(in_oklab,var(--folder-fill),var(--foreground)_6%)] peer-focus-visible/open:text-[color-mix(in_oklab,var(--folder-fill),var(--foreground)_12%)] motion-safe:transition-colors motion-safe:duration-(--motion-duration-fast)"
		>
			<span className="absolute inset-x-0 top-3 bottom-0 rounded-xl bg-current" />
			<span className="absolute top-0 left-0 h-6 w-[37%] rounded-tl-xl bg-current after:absolute after:inset-y-0 after:right-0 after:w-6 after:origin-top after:skew-x-[40deg] after:rounded-tr-md after:bg-current" />
			<span
				ref={ref}
				className="absolute inset-x-0 inset-y-1 overflow-hidden rounded-xl"
			>
				{vaultPath
					? previews.map(({ path, revision }, index) => (
							<span
								key={`${path}:${revision}`}
								className={cn(
									"absolute aspect-[3/4] w-3/4 overflow-hidden rounded-lg bg-card shadow-raised ring-1 ring-border/60 last:[--folder-paper-y:-0.4375rem] motion-safe:transform-[translate(0px,0px)] motion-safe:transition-[transform] motion-safe:duration-320 motion-safe:ease-[cubic-bezier(0.42,0,0.58,1)] motion-safe:group-hover:transform-[translate(var(--folder-paper-x,0px),var(--folder-paper-y,-0.25rem))]",
									folderStackLayouts[previews.length]?.[index],
								)}
							>
								{inView ? (
									<PdfThumbnail
										path={joinVaultPath(vaultPath, path)}
										className="inset-0 size-full"
									/>
								) : null}
							</span>
						))
					: null}
			</span>
			<span
				className={cn(
					folderPocketClass,
					"bg-linear-to-b from-(--folder-pocket-fill)/55 to-(--folder-pocket-fill)/95 to-70% shadow-raised ring-1 ring-border/70 ring-inset [--folder-pocket-fill:color-mix(in_oklab,var(--folder-fill),white_40%)] dark:[--folder-pocket-fill:color-mix(in_oklab,var(--folder-fill),var(--foreground)_6%)]",
				)}
			/>
		</span>
	);
}

type SelectCard = (key: string, mods: { shift: boolean }) => void;

function CardSelectionMark({ selected }: { selected: boolean }) {
	return selected ? (
		<Check className="size-4" aria-hidden />
	) : (
		<span
			className="size-3.5 rounded-full border border-muted-foreground/65"
			aria-hidden
		/>
	);
}

function CardActions({
	title,
	folder = false,
	children,
}: {
	title: string;
	folder?: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className={
						folder
							? cn(
									cardIconClass,
									folderControlVisibilityClass,
									"absolute right-3 bottom-3 z-20 [@media(hover:hover)]:pointer-events-none group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto data-[state=open]:pointer-events-auto",
								)
							: cn(cardControlClass, "right-2")
					}
					aria-label={t("papersLibrary.cardActions", { title })}
				>
					<Ellipsis aria-hidden />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="bottom"
				align={folder ? "end" : "start"}
				className="w-52"
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

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
					selected && selectedControlClass,
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
				<CardSelectionMark selected={selected} />
			</Button>
			<CardActions title={title}>{children}</CardActions>
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
			className={cn(
				cardSurfaceClass,
				"before:pointer-events-none before:absolute before:-inset-1.5 before:-z-1 before:rounded-2xl data-selected:before:bg-primary/15 motion-safe:before:transition-colors motion-safe:before:duration-(--motion-duration-fast)",
			)}
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
	const folderLabelId = useId();
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
						{folders.map(({ name, path, paperCount, previews }, index) => {
							const key = folderSelectionKey(path);
							const selected = selectedKeys.has(key);
							const absPath = vaultPath ? joinVaultPath(vaultPath, path) : null;
							const nameId = `${folderLabelId}-name-${index}`;
							const countId = `${folderLabelId}-count-${index}`;
							return (
								<li
									key={key}
									className={cn(
										cardSurfaceClass,
										"aspect-[5/6] min-h-36 self-start rounded-xl [--folder-fill:var(--muted)] [--folder-pocket-height:max(40%,3.5rem)] data-selected:[--folder-fill:color-mix(in_oklab,var(--muted),var(--primary)_16%)]",
									)}
									data-library-card
									data-selected={selected || undefined}
								>
									<button
										type="button"
										title={name}
										aria-labelledby={nameId}
										aria-describedby={countId}
										className="peer/open absolute inset-x-0 top-0 bottom-(--folder-pocket-height) z-10 w-full cursor-pointer appearance-none bg-transparent outline-none"
										onClick={() => onNavigateFolder?.(path)}
									/>
									<FolderArtwork
										previews={previews}
										vaultPath={localVaultPath}
									/>
									<input
										type="checkbox"
										checked={selected}
										aria-label={t(
											selected
												? "papersLibrary.selection.deselectItem"
												: "papersLibrary.selection.selectRow",
											{ title: name },
										)}
										aria-describedby={countId}
										className={cn(
											folderPocketClass,
											"peer z-10 w-full cursor-pointer opacity-0",
										)}
										onChange={(event) =>
											onSelect(key, {
												shift:
													event.nativeEvent instanceof globalThis.MouseEvent &&
													event.nativeEvent.shiftKey,
											})
										}
									/>
									<span
										className={cn(
											folderPocketClass,
											"pointer-events-none flex select-none items-end justify-between gap-2 py-3 pr-[2.9375rem] pl-3 text-left peer-hover:bg-foreground/4 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-inset",
										)}
									>
										<span className="min-w-0">
											<span
												id={nameId}
												className="block truncate text-sm font-medium leading-5"
											>
												{name}
											</span>
											<span id={countId} className={cardCaptionClass}>
												{t("papersLibrary.folderPaperCount", {
													count: paperCount,
												})}
											</span>
										</span>
										<span
											className={cn(
												"flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-popover text-popover-foreground shadow-raised",
												folderControlVisibilityClass,
												"motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast)",
												selected && selectedControlClass,
											)}
										>
											<CardSelectionMark selected={selected} />
										</span>
									</span>
									<CardActions title={name} folder>
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
									</CardActions>
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
