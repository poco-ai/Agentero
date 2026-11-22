import { FileText, Folder } from "lucide-react";
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
import {
	addedDate,
	type PaperRow,
} from "@/components/library/library-row-utils";
import { paperSelectionKey } from "@/components/library/library-selection";
import { PaperTitle } from "@/components/paper/paper-title";
import { useInView } from "@/hooks/use-in-view";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import { loadLibraryThumbnail } from "@/lib/pdf/library-thumbnail";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

const gridClass =
	"grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-4 gap-y-5";
const cardClass =
	"group block w-full min-w-0 cursor-pointer select-none rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function PaperCover({ path }: { path: string | null }) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { rootMargin: "160px 0px", keepAlive: false });
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		setUrl(null);
		if (!path || !inView) return;
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
	}, [path, inView]);

	return (
		<span
			ref={ref}
			aria-hidden
			className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-muted/40"
		>
			{url ? (
				<img
					src={url}
					alt=""
					draggable={false}
					className="pointer-events-none absolute inset-0 size-full bg-white object-cover object-top"
				/>
			) : (
				<FileText className="size-8 text-muted-foreground/65" />
			)}
			<span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-border/70 ring-inset group-hover:ring-foreground/25 group-data-selected:ring-2 group-data-selected:ring-primary" />
		</span>
	);
}

const PaperCard = memo(function PaperCard({
	row,
	index,
	vaultPath,
	selected,
	selectionActive,
	dateFormat,
	onPaperClick,
}: {
	row: PaperRow;
	index: number;
	vaultPath: string | null;
	selected: boolean;
	selectionActive: boolean;
	dateFormat: Intl.DateTimeFormat;
	onPaperClick: (
		event: MouseEvent<HTMLButtonElement>,
		paper: PaperMetadata,
	) => void;
}) {
	const { t } = useTranslation("sidebar");
	const paper = row.paper;
	const date = addedDate(paper.added_at);
	const path =
		vaultPath &&
		paper.path &&
		paper.has_pdf !== false &&
		!isRemoteVaultHandle(vaultPath)
			? joinVaultPath(vaultPath, paper.path)
			: null;
	return (
		<button
			type="button"
			data-library-paper
			data-index={index}
			data-selected={selected ? "" : undefined}
			data-hint
			data-hint-priority="1"
			aria-pressed={selectionActive ? selected : undefined}
			className={cardClass}
			onClick={(event) => onPaperClick(event, paper)}
		>
			<PaperCover key={paper.updated_at} path={path} />
			<PaperTitle
				text={paper.title?.trim() || paper.id}
				className="mt-2 line-clamp-2 text-sm font-medium leading-5 group-hover:text-primary"
			/>
			{date ? (
				<time
					dateTime={date.toISOString()}
					className="mt-0.5 block text-muted-foreground text-xs"
				>
					{t("papersLibrary.addedOn", { date: dateFormat.format(date) })}
				</time>
			) : null}
		</button>
	);
});

export function LibraryCardView({
	folders,
	rows,
	vaultPath,
	selectedKeys,
	selectionActive,
	onNavigateFolder,
	onPaperClick,
	wrapPapers,
}: {
	folders: { name: string; path: string }[];
	rows: PaperRow[];
	vaultPath: string | null;
	selectedKeys: ReadonlySet<string>;
	selectionActive: boolean;
	onNavigateFolder?: (path: string) => void;
	onPaperClick: (
		event: MouseEvent<HTMLButtonElement>,
		paper: PaperMetadata,
	) => void;
	wrapPapers: (content: ReactNode) => ReactNode;
}) {
	const { t, i18n } = useTranslation("sidebar");
	const dateFormat = useMemo(
		() => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
		[i18n.language],
	);
	return (
		<div className="space-y-6 px-4 py-4 sm:px-5">
			{folders.length > 0 ? (
				<section aria-label={t("papersLibrary.folders")}>
					<h2 className="mb-2 text-muted-foreground text-xs font-medium">
						{t("papersLibrary.folders")}
					</h2>
					<ul className={cn(gridClass, "gap-y-2.5")}>
						{folders.map(({ name, path }) => (
							<li key={path} className="min-w-0">
								<button
									type="button"
									title={name}
									className={cn(
										cardClass,
										"flex items-center gap-2.5 border border-border/60 bg-muted/40 p-2.5 text-sm font-medium hover:bg-muted",
									)}
									onClick={() => onNavigateFolder?.(path)}
								>
									<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs group-hover:text-foreground">
										<Folder className="size-4" aria-hidden />
									</span>
									<span className="truncate">{name}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{rows.length > 0
				? wrapPapers(
						<ul className={gridClass} aria-label={t("papersLibrary.title")}>
							{rows.map((row, index) => (
								<li key={paperSelectionKey(row.paper)} className="min-w-0">
									<PaperCard
										row={row}
										index={index}
										vaultPath={vaultPath}
										selected={selectedKeys.has(paperSelectionKey(row.paper))}
										selectionActive={selectionActive}
										dateFormat={dateFormat}
										onPaperClick={onPaperClick}
									/>
								</li>
							))}
						</ul>,
					)
				: null}
		</div>
	);
}
