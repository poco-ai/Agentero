import {
	ArrowUp,
	BookOpen,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ExternalLink,
	FileText,
	Flame,
	FolderInput,
	Globe,
	Languages,
	Loader2,
	MessageSquare,
	RotateCw,
	Search,
	X,
} from "lucide-react";
import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { SiGithub } from "react-icons/si";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { MoveDestinationPicker } from "@/components/sidebar/file-tree/move-destination-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLibraryStore, useVaultStore } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	currentUtcIsoWeek,
	currentUtcMonth,
	filterAndSortHuggingFacePapers,
	formatCompactCount,
	HUGGING_FACE_FEED_MODES,
	HUGGING_FACE_SORTS,
	type HuggingFaceFeedMode,
	type HuggingFaceFeedRequest,
	type HuggingFacePaper,
	type HuggingFaceSort,
	loadHuggingFacePapers,
	readHuggingFacePrefs,
	shiftIsoWeek,
	shiftUtcDate,
	shiftUtcMonth,
	todayUtcDate,
	writeHuggingFacePrefs,
} from "@/lib/plaza/huggingface";
import { importPlazaPaper } from "@/lib/plaza/import";
import { matchingImportedIds } from "@/lib/plaza/imported";
import { runTranslate } from "@/lib/translate";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type FeedState =
	| { status: "loading" | "error" }
	| {
			status: "ready";
			papers: HuggingFacePaper[];
			hasMore: boolean;
			resolvedDate?: string;
			page: number;
			loadingMore: boolean;
	  };

function currentFeed(mode: HuggingFaceFeedMode): HuggingFaceFeedRequest {
	switch (mode) {
		case "daily":
			return { mode, date: todayUtcDate(), autoFallback: true };
		case "weekly":
			return { mode, week: currentUtcIsoWeek() };
		case "monthly":
			return { mode, month: currentUtcMonth() };
		default:
			return { mode };
	}
}

export function PlazaHuggingFaceView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [prefs] = useState(readHuggingFacePrefs);
	const [request, setRequest] = useState(() => currentFeed(prefs.mode));
	const [sort, setSort] = useState(prefs.sort);
	const [codeOnly, setCodeOnly] = useState(prefs.codeOnly);
	const [query, setQuery] = useState("");
	const [feed, setFeed] = useState<FeedState>({ status: "loading" });
	const [destinations, setDestinations] = useState(
		() => new Map<string, string>(),
	);
	const controllerRef = useRef<AbortController | null>(null);
	const generation = useRef(0);
	const vaultPath = useVaultStore((state) => state.vaultPath);
	const library = useLibraryStore((state) => state.papers);
	const mode = request.mode;
	const papers = feed.status === "ready" ? feed.papers : null;
	const visiblePapers = useMemo(
		() =>
			filterAndSortHuggingFacePapers(papers ?? [], { sort, query, codeOnly }),
		[papers, sort, query, codeOnly],
	);
	const importedIds = useMemo(
		() =>
			new Set(
				matchingImportedIds(
					papers?.map((paper) => paper.arxivId) ?? [],
					library,
				),
			),
		[papers, library],
	);

	useEffect(() => {
		writeHuggingFacePrefs({ mode, sort, codeOnly });
	}, [mode, sort, codeOnly]);

	useEffect(() => {
		const controller = new AbortController();
		controllerRef.current = controller;
		const requestGeneration = ++generation.current;
		const isCurrent = () =>
			requestGeneration === generation.current && !controller.signal.aborted;
		loadHuggingFacePapers(request, controller.signal).then(
			(next) => {
				if (isCurrent())
					setFeed({ ...next, status: "ready", page: 0, loadingMore: false });
			},
			() => {
				if (isCurrent()) setFeed({ status: "error" });
			},
		);
		return () => controller.abort();
	}, [request]);

	const editionRequest: HuggingFaceFeedRequest =
		mode === "daily" && feed.status === "ready" && feed.resolvedDate
			? { mode, date: feed.resolvedDate }
			: request;

	function startRequest(next: HuggingFaceFeedRequest) {
		controllerRef.current?.abort();
		setFeed({ status: "loading" });
		setRequest({ ...next });
	}

	const reload = () => startRequest(editionRequest);

	async function loadMore() {
		if (feed.status !== "ready" || !feed.hasMore || feed.loadingMore) return;
		const signal = controllerRef.current?.signal;
		if (!signal || signal.aborted) return;
		const requestGeneration = generation.current;
		const isCurrent = () =>
			requestGeneration === generation.current && !signal.aborted;
		const page = feed.page + 1;
		setFeed({ ...feed, loadingMore: true });
		try {
			const next = await loadHuggingFacePapers(
				{ ...editionRequest, page },
				signal,
			);
			if (!isCurrent()) return;
			const known = new Set(feed.papers.map((paper) => paper.arxivId));
			const added = next.papers.filter((paper) => !known.has(paper.arxivId));
			setFeed({
				...feed,
				papers: [...feed.papers, ...added],
				page,
				hasMore: next.hasMore && added.length > 0,
				loadingMore: false,
			});
		} catch (error) {
			if (!isCurrent()) return;
			setFeed({ ...feed, loadingMore: false });
			notifyError(errorText(error));
		}
	}

	const loading =
		feed.status === "loading" || (feed.status === "ready" && feed.loadingMore);
	const loadMoreButton = feed.status === "ready" && feed.hasMore && (
		<Button
			type="button"
			size="sm"
			variant="outline"
			disabled={feed.loadingMore}
			onClick={() => void loadMore()}
		>
			{feed.loadingMore && (
				<Loader2 aria-hidden className="motion-safe:animate-spin" />
			)}
			{t("plaza.huggingfacePage.loadMore")}
		</Button>
	);

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
				<fieldset className="inline-flex min-w-0 flex-wrap items-center gap-0.5 rounded-lg border p-0.5">
					<legend className="sr-only">
						{t("plaza.huggingfacePage.feedMode")}
					</legend>
					{HUGGING_FACE_FEED_MODES.map((option) => (
						<Button
							key={option}
							type="button"
							size="sm"
							variant={mode === option ? "secondary" : "ghost"}
							aria-pressed={mode === option}
							onClick={() => {
								if (mode !== option) startRequest(currentFeed(option));
							}}
						>
							{option === "trending" && <Flame aria-hidden />}
							{t(`plaza.huggingfacePage.modes.${option}`)}
						</Button>
					))}
				</fieldset>
				{editionRequest.mode !== "trending" && (
					<PeriodControls request={editionRequest} onChange={startRequest} />
				)}
				<div className="ml-auto flex flex-wrap items-center gap-1">
					<div className="relative w-44 max-w-full">
						<Search
							aria-hidden
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							value={query}
							className="h-8 pr-8 pl-8"
							aria-label={t("plaza.huggingfacePage.search")}
							placeholder={t("plaza.huggingfacePage.search")}
							onChange={(event) => setQuery(event.target.value)}
						/>
						{query && (
							<ActionButton
								className="absolute top-1/2 right-0.5 -translate-y-1/2"
								label={t("plaza.huggingfacePage.clearSearch")}
								onClick={() => setQuery("")}
							>
								<X aria-hidden />
							</ActionButton>
						)}
					</div>
					<ActionButton
						label={t("plaza.huggingfacePage.codeOnly")}
						aria-pressed={codeOnly}
						variant={codeOnly ? "secondary" : "ghost"}
						onClick={() => setCodeOnly(!codeOnly)}
					>
						<SiGithub aria-hidden />
					</ActionButton>
					<Select
						value={sort}
						onValueChange={(value: HuggingFaceSort) => setSort(value)}
					>
						<SelectTrigger aria-label={t("plaza.huggingfacePage.sortBy")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{HUGGING_FACE_SORTS.map((option) => (
								<SelectItem key={option} value={option}>
									{t(`plaza.huggingfacePage.sorts.${option}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<ActionButton
						label={t("plaza.reload")}
						disabled={feed.status === "loading"}
						onClick={reload}
					>
						<RotateCw
							aria-hidden
							className={cn(loading && "motion-safe:animate-spin")}
						/>
					</ActionButton>
				</div>
			</div>
			<div
				className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3"
				aria-busy={loading}
			>
				{feed.status === "loading" && (
					<EmptyState>{t("plaza.huggingfacePage.loading")}</EmptyState>
				)}
				{feed.status === "error" && (
					<EmptyState className="flex flex-col gap-2">
						{t("plaza.huggingfacePage.loadFailed")}
						<Button type="button" size="sm" variant="outline" onClick={reload}>
							{t("plaza.arxivRec.retry")}
						</Button>
					</EmptyState>
				)}
				{feed.status === "ready" && (
					<>
						{feed.papers.length === 0 ? (
							<EmptyState className="flex flex-col gap-2">
								{t("plaza.huggingfacePage.empty")}
								{editionRequest.mode === "daily" && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={editionRequest.date <= FIRST_DAILY_DATE}
										onClick={() =>
											startRequest({
												mode: "daily",
												date: shiftUtcDate(editionRequest.date, -1),
											})
										}
									>
										{t("plaza.huggingfacePage.previousDay")}
									</Button>
								)}
							</EmptyState>
						) : visiblePapers.length === 0 ? (
							<EmptyState className="flex flex-col gap-2">
								{t("plaza.huggingfacePage.noMatches")}
								<div className="flex flex-wrap justify-center gap-2">
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => {
											setQuery("");
											setCodeOnly(false);
										}}
									>
										{t("plaza.huggingfacePage.clearFilters")}
									</Button>
									{loadMoreButton}
								</div>
							</EmptyState>
						) : (
							<div className="mx-auto grid max-w-7xl grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] items-start gap-4">
								{visiblePapers.map((paper) => (
									<PaperCard
										key={`${vaultPath ?? ""}:${paper.arxivId}`}
										paper={paper}
										imported={importedIds.has(paper.arxivId)}
										vaultPath={vaultPath}
										lastFolder={
											vaultPath ? (destinations.get(vaultPath) ?? null) : null
										}
										rememberFolder={(folder) => {
											if (vaultPath)
												setDestinations((prev) =>
													new Map(prev).set(vaultPath, folder),
												);
										}}
										activeKeyword={query.trim().toLowerCase()}
										onKeywordClick={(keyword) =>
											setQuery(
												query.trim().toLowerCase() === keyword.toLowerCase()
													? ""
													: keyword,
											)
										}
									/>
								))}
							</div>
						)}
						{visiblePapers.length > 0 && loadMoreButton && (
							<div className="mt-3 flex justify-center">{loadMoreButton}</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

type PeriodRequest = Exclude<HuggingFaceFeedRequest, { mode: "trending" }>;
const FIRST_DAILY_DATE = "2023-01-01";

function PeriodControls({
	request,
	onChange,
}: {
	request: PeriodRequest;
	onChange: (request: HuggingFaceFeedRequest) => void;
}) {
	const { t } = useTranslation("sidebar");
	const dailyDate = request.mode === "daily" ? request.date : "";
	const [draftDate, setDraftDate] = useState(dailyDate);
	useEffect(() => setDraftDate(dailyDate), [dailyDate]);
	const now = new Date();
	const today = todayUtcDate(now);
	const current = {
		daily: today,
		weekly: currentUtcIsoWeek(now),
		monthly: currentUtcMonth(now),
	};
	const value =
		request.mode === "daily"
			? request.date
			: request.mode === "weekly"
				? request.week
				: request.month;
	const currentValue = current[request.mode];

	function step(delta: number) {
		switch (request.mode) {
			case "daily":
				onChange({ mode: "daily", date: shiftUtcDate(request.date, delta) });
				break;
			case "weekly":
				onChange({ mode: "weekly", week: shiftIsoWeek(request.week, delta) });
				break;
			case "monthly":
				onChange({
					mode: "monthly",
					month: shiftUtcMonth(request.month, delta),
				});
				break;
		}
	}

	return (
		<div className="inline-flex items-center gap-0.5">
			<ActionButton
				label={t("plaza.huggingfacePage.previousPeriod")}
				disabled={request.mode === "daily" && request.date <= FIRST_DAILY_DATE}
				onClick={() => step(-1)}
			>
				<ChevronLeft aria-hidden />
			</ActionButton>
			{request.mode === "daily" ? (
				<Input
					type="date"
					className="h-8 w-auto tabular-nums"
					value={draftDate}
					min={FIRST_DAILY_DATE}
					max={today}
					aria-label={t("plaza.huggingfacePage.editionDate")}
					onChange={(event) => {
						const { value } = event.currentTarget;
						setDraftDate(value);
						if (
							/^\d{4}-\d{2}-\d{2}$/.test(value) &&
							value >= FIRST_DAILY_DATE &&
							value <= today
						) {
							onChange({ mode: "daily", date: value });
						}
					}}
					onBlur={() => {
						if (draftDate !== request.date) setDraftDate(request.date);
					}}
				/>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="tabular-nums disabled:opacity-100"
							disabled={value === currentValue}
							onClick={() => onChange(currentFeed(request.mode))}
						>
							{value}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{t("plaza.huggingfacePage.currentPeriod")}
					</TooltipContent>
				</Tooltip>
			)}
			<ActionButton
				label={t("plaza.huggingfacePage.nextPeriod")}
				disabled={value >= currentValue}
				onClick={() => step(1)}
			>
				<ChevronRight aria-hidden />
			</ActionButton>
		</div>
	);
}

function ActionButton({
	label,
	size = "icon-sm",
	variant = "ghost",
	children,
	...props
}: ComponentProps<typeof Button> & { label: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size={size}
					variant={variant}
					aria-label={label}
					{...props}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function PaperCard({
	paper,
	imported,
	vaultPath,
	lastFolder,
	rememberFolder,
	activeKeyword,
	onKeywordClick,
}: {
	paper: HuggingFacePaper;
	imported: boolean;
	vaultPath: string | null;
	lastFolder: string | null;
	rememberFolder: (folder: string) => void;
	activeKeyword: string;
	onKeywordClick: (keyword: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const popupId = useId();
	const tree = useVaultStore((state) => state.tree);
	const [expanded, setExpanded] = useState(false);
	const [translation, setTranslation] = useState<string | null>(null);
	const [showTranslation, setShowTranslation] = useState(false);
	const [translating, setTranslating] = useState(false);
	const mountedRef = useRef(true);
	const collapsedWhileTranslatingRef = useRef(false);
	const [importState, setImportState] = useState<"idle" | "pending" | "done">(
		"idle",
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [newFolder, setNewFolder] = useState("");
	const url = `https://huggingface.co/papers/${paper.arxivId}`;
	const arxivUrl = `https://arxiv.org/abs/${paper.arxivId}`;
	const fullText = paper.abstract || paper.aiSummary;
	const summary = paper.aiSummary || paper.abstract;
	const displayDate = paper.edition ?? paper.publishedDate;
	const authors = paper.authors.join(", ");
	const isImported = imported || importState === "done";

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	async function translateAbstract() {
		if (!fullText || translating) return;
		if (translation !== null) {
			setShowTranslation(!showTranslation);
			setExpanded(true);
			return;
		}
		collapsedWhileTranslatingRef.current = false;
		setTranslating(true);
		try {
			const result = await runTranslate({
				text: fullText,
				context: {
					surface: "huggingface-daily-papers",
					paperId: paper.arxivId,
				},
			});
			if (!mountedRef.current) return;
			setTranslation(result);
			if (!collapsedWhileTranslatingRef.current) {
				setShowTranslation(true);
				setExpanded(true);
			}
		} catch (error) {
			if (mountedRef.current) notifyError(errorText(error));
		} finally {
			if (mountedRef.current) setTranslating(false);
		}
	}

	async function importTo(folder: string) {
		setPickerOpen(false);
		setImportState("pending");
		rememberFolder(folder);
		const ok = await importPlazaPaper(
			{ id: paper.arxivId, url: arxivUrl, title: paper.title },
			folder,
		);
		if (mountedRef.current) setImportState(ok ? "done" : "idle");
	}

	const importLabel = isImported
		? t("plaza.feeds.imported")
		: importState === "pending"
			? t("plaza.huggingfacePage.importing")
			: t("plaza.feeds.import");
	const importDisabled = isImported || importState === "pending" || !vaultPath;
	const { upvotes, numComments, githubRepo, githubStars, projectPage } = paper;
	const displayKeywords = paper.aiKeywords.slice(0, 4);
	const visibleKeywords = expanded
		? displayKeywords
		: displayKeywords.slice(0, 2);
	const hiddenKeywordCount = expanded
		? 0
		: Math.max(0, displayKeywords.length - visibleKeywords.length);

	return (
		<article className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-background transition-[border-color,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:border-foreground/15 hover:shadow-raised motion-reduce:transition-none">
			<div className="relative">
				<PaperCover key={paper.thumbnail} thumbnail={paper.thumbnail} />
				<div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-background/85 p-0.5 shadow-raised backdrop-blur-md [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-(--motion-ease-out) motion-reduce:transition-none">
					{projectPage && (
						<ActionButton
							label={t("plaza.huggingfacePage.projectPage")}
							className="size-7 rounded-full"
							onClick={() => openExternalUrl(projectPage)}
						>
							<Globe aria-hidden className="size-3.5" />
						</ActionButton>
					)}
					<ActionButton
						label={t("plaza.huggingfacePage.openHuggingFace")}
						className="size-7 rounded-full"
						onClick={() => openExternalUrl(url)}
					>
						<ExternalLink aria-hidden className="size-3.5" />
					</ActionButton>
				</div>
			</div>
			<div className="flex flex-1 flex-col p-3.5">
				<h2
					className="line-clamp-2 min-h-[2.5rem] break-words font-medium text-sm leading-5 tracking-[-0.01em]"
					title={paper.title}
				>
					{paper.title}
				</h2>
				<p
					className="mt-1 h-4 truncate text-muted-foreground text-xs leading-4"
					title={
						[paper.organization, authors].filter(Boolean).join(" · ") ||
						undefined
					}
				>
					{paper.organization && (
						<span className="font-medium text-foreground/80">
							{paper.organization}
						</span>
					)}
					{paper.organization && authors && " · "}
					{authors}
				</p>
				<div className="mt-2 flex h-6 items-center gap-x-2.5 overflow-hidden text-caption text-muted-foreground tabular-nums">
					{upvotes !== undefined && (
						<PaperMetric
							label={t("plaza.huggingfacePage.metricCount", {
								metric: t("plaza.huggingfacePage.sorts.upvotes"),
								count: upvotes,
							})}
						>
							<ArrowUp aria-hidden className="size-3.5 shrink-0" />
							{formatCompactCount(upvotes)}
						</PaperMetric>
					)}
					{githubRepo && (
						<ActionButton
							label={
								githubStars === undefined
									? t("plaza.huggingfacePage.repository")
									: t("plaza.huggingfacePage.repositoryStars", {
											count: githubStars,
										})
							}
							size="sm"
							className="h-6 shrink-0 gap-1 rounded-md px-1 text-caption text-muted-foreground hover:text-foreground"
							onClick={() => openExternalUrl(githubRepo)}
						>
							<SiGithub aria-hidden className="size-3.5 shrink-0" />
							{githubStars !== undefined && formatCompactCount(githubStars)}
						</ActionButton>
					)}
					{numComments !== undefined && numComments > 0 && (
						<PaperMetric
							label={t("plaza.huggingfacePage.metricCount", {
								metric: t("plaza.huggingfacePage.sorts.comments"),
								count: numComments,
							})}
						>
							<MessageSquare aria-hidden className="size-3.5 shrink-0" />
							{formatCompactCount(numComments)}
						</PaperMetric>
					)}
					{displayDate && (
						<span className="ml-auto shrink-0">
							{paper.edition &&
							paper.publishedDate &&
							paper.edition !== paper.publishedDate ? (
								<Tooltip>
									<TooltipTrigger asChild>
										{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Focus opens the publication date tooltip. */}
										<time dateTime={displayDate} tabIndex={0}>
											{displayDate}
										</time>
									</TooltipTrigger>
									<TooltipContent>
										{t("plaza.huggingfacePage.publishedDate", {
											date: paper.publishedDate,
										})}
									</TooltipContent>
								</Tooltip>
							) : (
								<time dateTime={displayDate}>{displayDate}</time>
							)}
						</span>
					)}
				</div>
				{fullText ? (
					<SelectionSurface
						source={{
							sourcePath: url,
							sourceUrl: url,
							sourceTitle: paper.title,
							origin: "markdown",
							surface: "abstract",
						}}
						className={cn(
							"mt-2 whitespace-pre-wrap break-words select-text text-muted-foreground text-xs leading-5",
							!expanded && "line-clamp-3 h-[3.75rem]",
						)}
					>
						{showTranslation ? translation : expanded ? fullText : summary}
					</SelectionSurface>
				) : (
					!expanded && <div className="mt-2 h-[3.75rem]" aria-hidden />
				)}
				{(!expanded || visibleKeywords.length > 0) && (
					<div
						className={cn(
							"mt-2.5 flex items-center gap-1.5",
							expanded ? "flex-wrap" : "h-5 overflow-hidden",
						)}
					>
						{visibleKeywords.map((keyword) => (
							<Badge
								key={keyword}
								variant="secondary"
								asChild
								className={cn(
									"min-w-0 hover:bg-accent focus-visible:outline-2 aria-pressed:bg-primary aria-pressed:text-primary-foreground",
									expanded ? "max-w-full" : "max-w-[10.5rem] shrink",
								)}
							>
								<button
									type="button"
									aria-pressed={activeKeyword === keyword.toLowerCase()}
									onClick={() => onKeywordClick(keyword)}
								>
									<span className="truncate" title={keyword}>
										{keyword}
									</span>
								</button>
							</Badge>
						))}
						{hiddenKeywordCount > 0 && (
							<span className="shrink-0 text-caption text-muted-foreground tabular-nums">
								+{hiddenKeywordCount}
							</span>
						)}
					</div>
				)}
				<div className="mt-3 flex items-center gap-1 border-t border-border/60 pt-2.5">
					{fullText && (
						<div className="flex items-center gap-0.5 text-muted-foreground">
							<ActionButton
								label={t(
									expanded
										? "plaza.huggingfacePage.collapseAbstract"
										: "plaza.huggingfacePage.expandAbstract",
								)}
								aria-expanded={expanded}
								className="size-7 text-muted-foreground hover:text-foreground"
								onClick={() => {
									if (expanded) {
										if (translating)
											collapsedWhileTranslatingRef.current = true;
										setShowTranslation(false);
									}
									setExpanded(!expanded);
								}}
							>
								{expanded ? (
									<ChevronUp aria-hidden />
								) : (
									<ChevronDown aria-hidden />
								)}
							</ActionButton>
							<ActionButton
								label={t(
									translating
										? "plaza.huggingfacePage.translating"
										: showTranslation
											? "plaza.huggingfacePage.showOriginal"
											: translation !== null
												? "plaza.huggingfacePage.showTranslation"
												: "plaza.huggingfacePage.translate",
								)}
								disabled={translating}
								className={cn(
									"size-7 text-muted-foreground hover:text-foreground",
									showTranslation && "bg-secondary text-foreground",
								)}
								onClick={() => void translateAbstract()}
							>
								{translating ? (
									<Loader2 aria-hidden className="motion-safe:animate-spin" />
								) : (
									<Languages aria-hidden />
								)}
							</ActionButton>
						</div>
					)}
					<div className="ml-auto flex items-center gap-1.5">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 gap-1 px-2 text-xs active:scale-[0.98] motion-reduce:active:scale-100"
							onClick={() =>
								openRemoteArxivPaper({
									arxivId: paper.arxivId,
									title: paper.title,
									abstract: fullText || undefined,
									url: arxivUrl,
								})
							}
						>
							<BookOpen aria-hidden className="size-3.5" />
							{t("plaza.arxivRec.read")}
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
									variant={isImported ? "ghost" : "secondary"}
									className="h-7 gap-1 px-2.5 text-xs active:scale-[0.98] motion-reduce:active:scale-100"
									disabled={importDisabled}
								>
									{isImported ? (
										<Check aria-hidden className="size-3.5" />
									) : importState === "pending" ? (
										<Loader2
											aria-hidden
											className="size-3.5 motion-safe:animate-spin"
										/>
									) : (
										<FolderInput aria-hidden className="size-3.5" />
									)}
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
			</div>
		</article>
	);
}

function PaperMetric({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex items-center gap-1">
					<span className="sr-only">{label}</span>
					<span aria-hidden className="inline-flex items-center gap-1">
						{children}
					</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function PaperCover({ thumbnail }: { thumbnail: string | null }) {
	const [failed, setFailed] = useState(false);
	return (
		<div
			className="relative aspect-[2/1] overflow-hidden border-b border-border/60 bg-muted/40"
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
