import {
	BookOpen,
	Calendar,
	ChevronRight,
	ExternalLink,
	Library,
	Pencil,
	Tag,
	Users,
} from "lucide-react";
import {
	type ComponentType,
	type KeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { SiArxiv, SiModelscope } from "react-icons/si";
import { EditablePaperTag } from "@/components/library/editable-paper-tag";
import { PaperTagRemoveButton } from "@/components/library/paper-tag-chip";
import { TagColorPalette } from "@/components/library/tag-color-palette";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { MathText } from "@/components/ui/math-text";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import { arxivUrls } from "@/lib/paper/arxiv";
import { setEditMetaDraft } from "@/lib/paper/library-store";
import { publicationDateText } from "@/lib/paper/publication-date";
import {
	coercePaperTags,
	isVisiblePaperTag,
	normalizePaperTags,
	type PaperTag,
	visiblePaperTags,
	withPaperTagColor,
} from "@/lib/paper/tags";
import { type TagColorId, tagSwatchStyle } from "@/lib/ui/tag-colors";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath } from "@/lib/vault/store";

type PaperInfoPanelProps = {
	meta: PaperMetadata | null;
	className?: string;
	/** Persist tags to catalog. Required for editing. */
	onTagsChange?: (tags: PaperTag[]) => Promise<void> | void;
};

function MetaRow({
	icon: Icon,
	label,
	children,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2 px-3 py-1.5">
			<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<span className="sr-only">{label}</span>
				<div className="text-sm leading-snug text-foreground">{children}</div>
			</div>
		</div>
	);
}

/** Single-click-to-copy value control, same interaction as Library cells. */
function CopyValue({
	text,
	label,
	className,
	onCopy,
}: {
	text: string;
	label: string;
	className?: string;
	onCopy: (text: string, label: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const hint = t("paperInfo.copyHint", { label });
	return (
		<button
			type="button"
			title={hint}
			aria-label={hint}
			onClick={() => onCopy(text, label)}
			className={cn(
				"block w-full cursor-pointer select-text rounded-sm text-left",
				"hover:bg-muted/60 hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			)}
		>
			{/* No `block` here: it sorts after line-clamp-* and would override display:-webkit-box. */}
			<MathText text={text} className={cn("w-full", className)} />
		</button>
	);
}

function LinkChip({
	href,
	label,
	icon,
}: {
	href: string;
	label: string;
	icon?: ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			aria-label={label}
			title={label}
			className={cn(
				"inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5",
				"h-6 min-w-0 flex-1 justify-center text-caption leading-none text-muted-foreground transition-colors",
				"hover:bg-muted hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			)}
		>
			{icon}
			<span className="min-w-0 truncate @max-[18rem]/paper-links:hidden">
				{label}
			</span>
			<ExternalLink
				className="size-2.5 shrink-0 opacity-70 @max-[18rem]/paper-links:hidden"
				aria-hidden
			/>
		</a>
	);
}

function AlphaXivIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
			<title>alphaXiv</title>
			<path
				d="M2.8 10.2 8 5c1.3-1.3 3.5-1.2 4.7.2l3 3.3"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
			<path
				d="M12.2 8.4 7.7 13c-1.2 1.2-1.2 3.1 0 4.3 1.2 1.2 3.2 1.1 4.3-.1L21 8.1"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
			<path
				d="m16.9 14.2 4.2 4.2"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
			/>
		</svg>
	);
}

function ServiceLinkChip({
	href,
	label,
	icon,
}: {
	href: string;
	label: string;
	icon: ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			aria-label={label}
			title={label}
			className={cn(
				"inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border bg-background px-1.5",
				"text-caption leading-none text-muted-foreground transition-colors",
				"hover:bg-muted hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			)}
		>
			{icon}
			<span className="min-w-0 truncate @max-[18rem]/paper-links:hidden">
				{label}
			</span>
			<ExternalLink
				className="size-2.5 shrink-0 opacity-70 @max-[18rem]/paper-links:hidden"
				aria-hidden
			/>
		</a>
	);
}

function TagsEditor({
	tags,
	disabled,
	onChange,
}: {
	tags: PaperTag[] | unknown;
	disabled?: boolean;
	onChange: (tags: PaperTag[]) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [draft, setDraft] = useState("");
	const [draftColor, setDraftColor] = useState<TagColorId | null>(null);
	const [colorOpen, setColorOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const allTags = coercePaperTags(tags);
	const list = visiblePaperTags(allTags);

	const commit = async (next: PaperTag[]) => {
		const hidden = allTags.filter((tag) => !isVisiblePaperTag(tag));
		const normalized = normalizePaperTags([...hidden, ...next]);
		setBusy(true);
		try {
			await onChange(normalized);
		} finally {
			setBusy(false);
		}
	};

	const addTag = () => {
		const value = draft.trim();
		if (!value || busy || disabled) return;
		setDraft("");
		const next: PaperTag = draftColor
			? { name: value, color: draftColor }
			: { name: value };
		// Keep selected color for consecutive tags of the same theme.
		void commit([...list, next]);
	};

	const removeTag = (name: string) => {
		if (busy || disabled) return;
		void commit(
			list.filter(
				(x) => x.name.toLocaleLowerCase() !== name.toLocaleLowerCase(),
			),
		);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addTag();
		} else if (e.key === "Backspace" && !draft && list.length > 0) {
			const last = list[list.length - 1];
			if (last) removeTag(last.name);
		}
	};

	const draftSwatch = tagSwatchStyle(draftColor);

	return (
		<div className="flex flex-col gap-1.5">
			{/* Input first so Zotero papers with many imported tags still show "Add tag…" without scrolling past chips. */}
			{disabled ? null : (
				<div className="relative">
					<Input
						ref={inputRef}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder={t("paperInfo.addTag")}
						aria-label={t("paperInfo.addTag")}
						disabled={busy}
						className="h-6 border-dashed py-0 pr-7 pl-1.5 text-caption"
					/>
					<Popover open={colorOpen} onOpenChange={setColorOpen}>
						<PopoverTrigger asChild>
							<button
								type="button"
								data-tag-color-picker
								disabled={busy}
								className={cn(
									"absolute top-1/2 right-1 flex size-4 -translate-y-1/2 items-center justify-center",
									"overflow-hidden rounded-full bg-background ring-1 ring-border/70 transition-colors",
									"hover:ring-foreground/30",
									"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									"disabled:pointer-events-none disabled:opacity-50",
								)}
								style={draftSwatch}
								aria-label={t("paperInfo.tagColor")}
								title={t("paperInfo.tagColor")}
							>
								{draftColor == null ? (
									<span
										className="pointer-events-none absolute top-1/2 left-[-20%] h-px w-[140%] -translate-y-1/2 rotate-45 bg-red-500"
										aria-hidden
									/>
								) : null}
								<span className="sr-only">{t("paperInfo.tagColor")}</span>
							</button>
						</PopoverTrigger>
						<PopoverContent
							data-tag-color-picker
							side="top"
							align="end"
							sideOffset={6}
							className="w-auto p-2"
							onOpenAutoFocus={(e) => e.preventDefault()}
						>
							<TagColorPalette
								color={draftColor}
								onChange={(color) => {
									setDraftColor(color);
									setColorOpen(false);
									inputRef.current?.focus();
								}}
							/>
						</PopoverContent>
					</Popover>
				</div>
			)}
			{list.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{list.map((tag) => (
						<EditablePaperTag
							key={tag.name}
							tag={tag}
							disabled={disabled || busy}
							onColorChange={(color) =>
								commit(withPaperTagColor(list, tag.name, color))
							}
							trailing={
								disabled ? null : (
									<PaperTagRemoveButton
										tagName={tag.name}
										label={t("paperInfo.removeTag", { tag: tag.name })}
										disabled={busy}
										onRemove={removeTag}
									/>
								)
							}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

const HEIGHT_STORAGE_KEY = "agentero.paperInfoHeight";
const MIN_CONTENT_HEIGHT = 120;
const DEFAULT_CONTENT_HEIGHT = 320;
const HEADER_HEIGHT = 32;

function clampHeight(value: number) {
	return Math.max(MIN_CONTENT_HEIGHT, value);
}

function loadStoredHeight(): number {
	// Stored as a bare integer string; JSON numbers round-trip identically.
	const parsed = readJsonStorage<number>(HEIGHT_STORAGE_KEY, Number.NaN);
	if (Number.isFinite(parsed)) return clampHeight(parsed);
	return DEFAULT_CONTENT_HEIGHT;
}

export function PaperInfoPanel({
	meta,
	className,
	onTagsChange,
}: PaperInfoPanelProps) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(Boolean(meta));
	const [contentHeight, setContentHeight] = useState(loadStoredHeight);
	/** Disable height transition while the user is dragging the resize handle. */
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{
		startY: number;
		startHeight: number;
		collapseOnRelease: boolean;
	} | null>(null);

	const persistHeight = (value: number) => {
		writeJsonStorage(HEIGHT_STORAGE_KEY, Math.round(value));
	};

	const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		dragRef.current = {
			startY: e.clientY,
			startHeight: contentHeight,
			collapseOnRelease: false,
		};
		setIsDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		// Dragging up grows the panel.
		const next = drag.startHeight + (drag.startY - e.clientY);
		drag.collapseOnRelease = next <= MIN_CONTENT_HEIGHT;
		setContentHeight(clampHeight(next));
	};

	const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		setIsDragging(false);
		e.currentTarget.releasePointerCapture(e.pointerId);
		setContentHeight((h) => {
			persistHeight(h);
			return h;
		});
		// Collapse after releasing drag so height can ease closed.
		if (drag.collapseOnRelease) setOpen(false);
	};

	const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 48 : 16;
		let next: number | null = null;
		if (e.key === "ArrowUp") next = clampHeight(contentHeight + step);
		else if (e.key === "ArrowDown") next = clampHeight(contentHeight - step);
		if (next == null) return;
		e.preventDefault();
		if (e.key === "ArrowDown" && contentHeight <= MIN_CONTENT_HEIGHT) {
			setOpen(false);
			return;
		}
		setContentHeight(next);
		persistHeight(next);
	};

	// Open when a paper is selected; collapse when none.
	useEffect(() => {
		if (!meta) {
			setOpen(false);
			return;
		}
		setOpen(true);
	}, [meta]);

	const resizable = open && Boolean(meta);
	const vaultPath = getVaultPath();
	const canEditMeta =
		Boolean(meta) && !!vaultPath && !isRemoteVaultHandle(vaultPath);
	const arxivId = meta?.arxiv_id ? arxivUrls(meta.arxiv_id)?.id : null;
	const modelScopeUrl = arxivId
		? `https://modelscope.cn/papers/${arxivId}/overview`
		: null;
	const alphaXivUrl = arxivId
		? `https://www.alphaxiv.org/abs/${arxivId}`
		: null;

	const copyField = async (text: string | null | undefined, label: string) => {
		const value = text?.trim();
		if (!value) return;
		await copyTextToClipboard(value, {
			successMessage: t("paperInfo.copied", { label }),
			errorMessage: t("paperInfo.copyFailed"),
			successNotify: {
				duration: 1500,
				id: "paper-info-copied",
			},
		});
	};

	return (
		<div
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col overflow-hidden border-t",
				// Match rail collapse: 200ms ease-out. Skip while resizing.
				!isDragging &&
					"transition-[height] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)]",
				className,
			)}
			style={{ height: open ? contentHeight + HEADER_HEIGHT : HEADER_HEIGHT }}
		>
			{resizable ? (
				// biome-ignore lint/a11y/useSemanticElements: a focusable drag separator cannot be a native <hr>
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label={t("paperInfo.resize")}
					aria-valuenow={Math.round(contentHeight)}
					aria-valuemin={MIN_CONTENT_HEIGHT}
					title={t("paperInfo.resize")}
					tabIndex={0}
					onPointerDown={onHandlePointerDown}
					onPointerMove={onHandlePointerMove}
					onPointerUp={onHandlePointerUp}
					onPointerCancel={onHandlePointerUp}
					onLostPointerCapture={() => {
						if (!dragRef.current) return;
						dragRef.current = null;
						setIsDragging(false);
					}}
					onKeyDown={onHandleKeyDown}
					className={cn(
						// Sits on the panel's top border; wider invisible hit area.
						"absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize outline-none",
						"after:absolute after:inset-x-0 after:top-[3px] after:h-px after:content-['']",
						"hover:after:bg-foreground/25 focus-visible:after:bg-foreground/35",
					)}
				/>
			) : null}
			<Collapsible
				open={open}
				onOpenChange={setOpen}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="flex h-8 min-h-8 shrink-0 items-center pr-1.5">
					<CollapsibleTrigger
						className={cn(
							"flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none",
							"text-muted-foreground text-sm font-medium",
							"hover:text-foreground",
							"focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						<ChevronRight
							className={cn(
								"size-3.5 shrink-0 transition-transform",
								open && "rotate-90",
							)}
							aria-hidden
						/>
						<span className="truncate">{t("paperInfo.info")}</span>
					</CollapsibleTrigger>
					{arxivId ? (
						<button
							type="button"
							title={t("paperInfo.copyHint", {
								label: t("paperInfo.arxivId"),
							})}
							aria-label={t("paperInfo.copyHint", {
								label: t("paperInfo.arxivId"),
							})}
							onClick={() => void copyField(arxivId, t("paperInfo.arxivId"))}
							className={cn(
								"min-w-0 max-w-[55%] shrink truncate px-1",
								"text-caption text-muted-foreground tabular-nums transition-colors",
								"hover:text-foreground",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
						>
							{arxivId}
						</button>
					) : null}
				</div>
				{/* forceMount: keep body mounted so the outer height transition
				    can clip it closed instead of unmounting on the first frame. */}
				<CollapsibleContent
					forceMount
					className={cn(
						"flex min-h-0 flex-1 flex-col",
						!open && "pointer-events-none",
					)}
					aria-hidden={!open}
				>
					{!meta ? (
						<p className="px-3 pb-3 text-muted-foreground text-xs leading-snug">
							{t("paperInfo.selectPrompt")}
						</p>
					) : (
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
							<MetaRow icon={BookOpen} label={t("paperInfo.title")}>
								<CopyValue
									text={meta.title}
									label={t("paperInfo.title")}
									onCopy={copyField}
									className="line-clamp-2"
								/>
							</MetaRow>
							{meta.authors?.length ? (
								<MetaRow icon={Users} label={t("paperInfo.authors")}>
									<CopyValue
										text={meta.authors.join(", ")}
										label={t("paperInfo.authors")}
										onCopy={copyField}
										className="line-clamp-2"
									/>
								</MetaRow>
							) : null}
							{publicationDateText(meta) ? (
								<MetaRow icon={Calendar} label={t("paperInfo.date")}>
									{publicationDateText(meta)}
								</MetaRow>
							) : null}
							<MetaRow icon={Library} label={t("paperInfo.publication")}>
								{meta.publication ? (
									<CopyValue
										text={meta.publication}
										label={t("paperInfo.publication")}
										onCopy={copyField}
										className="line-clamp-2"
									/>
								) : (
									<span className="text-muted-foreground">-</span>
								)}
							</MetaRow>
							<MetaRow icon={Tag} label={t("paperInfo.tags")}>
								<TagsEditor
									tags={meta.tags ?? []}
									// Editable whenever parent can persist; path is resolved in App
									// Prefer catalog path; else open paper folder.
									disabled={!onTagsChange}
									onChange={async (tags) => {
										if (onTagsChange) await onTagsChange(tags);
									}}
								/>
							</MetaRow>
							{meta.pdf_url || meta.arxiv_id || modelScopeUrl || alphaXivUrl ? (
								<div className="@container/paper-links flex flex-nowrap items-center gap-1.5 overflow-hidden px-3 pt-1.5">
									{meta.pdf_url || meta.arxiv_id ? (
										<LinkChip
											href={
												meta.pdf_url ?? `https://arxiv.org/pdf/${meta.arxiv_id}`
											}
											label={t("paperInfo.pdf")}
											icon={
												<SiArxiv
													className="size-3.5 shrink-0 text-[#B31B1B]"
													aria-hidden
												/>
											}
										/>
									) : null}
									{modelScopeUrl ? (
										<ServiceLinkChip
											href={modelScopeUrl}
											label={t("paperInfo.modelscopeInterpretation")}
											icon={
												<SiModelscope
													className="size-3.5 shrink-0 text-[#624AFF]"
													aria-hidden
												/>
											}
										/>
									) : null}
									{alphaXivUrl ? (
										<ServiceLinkChip
											href={alphaXivUrl}
											label={t("paperInfo.alphaXiv")}
											icon={
												<AlphaXivIcon className="size-3.5 shrink-0 text-[#B33131]" />
											}
										/>
									) : null}
								</div>
							) : null}
							{canEditMeta ? (
								<div className="px-3 pt-2">
									<button
										type="button"
										onClick={() => setEditMetaDraft(meta)}
										className={cn(
											"flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border bg-background px-2",
											"text-xs leading-none text-muted-foreground transition-colors",
											"hover:bg-muted hover:text-foreground",
											"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
										)}
									>
										<Pencil className="size-3.5 shrink-0" aria-hidden />
										<span className="truncate">
											{t("paperInfo.editMeta.title")}
										</span>
									</button>
								</div>
							) : null}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
