import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextPathIcon } from "@/components/agent/context-path-icon";
import { PopoverContent } from "@/components/ui/popover";
import { mentionPathHasChildren } from "@/lib/agent/mention";
import { lookupPlazaMention } from "@/lib/agent/plaza-mention";
import { cn } from "@/lib/core/utils";

/** Must render inside the composer `Popover` subtree — `PopoverContent` needs its context. */
export function ComposerMentionMenu({
	mentionBrowseRoot,
	mentionOptions,
	mentionActiveIndex,
	mentionCandidates,
	directoryPathSet,
	paperPathSet,
	labelForPath,
	onLeaveMentionFolder,
	onEnterMentionFolder,
	onAttachMention,
	onMentionActiveIndexChange,
}: {
	mentionBrowseRoot: string | null;
	mentionOptions: string[];
	mentionActiveIndex: number;
	mentionCandidates: string[];
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	onLeaveMentionFolder: () => void;
	onEnterMentionFolder: (path: string) => void;
	onAttachMention: (path: string) => void;
	onMentionActiveIndexChange: (index: number) => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<PopoverContent
			id="agent-mention-menu"
			role="listbox"
			side="top"
			align="start"
			sideOffset={8}
			onOpenAutoFocus={(event) => event.preventDefault()}
			className="max-h-(--radix-popover-content-available-height) w-[min(28rem,calc(100vw-1rem))] gap-0 overflow-y-auto p-1"
		>
			{mentionBrowseRoot ? (
				<div className="mb-0.5 flex items-center gap-0.5 border-border/60 border-b px-0.5 pb-1">
					<button
						type="button"
						className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						aria-label={t("composer.mentionBack")}
						title={t("composer.mentionBack")}
						onClick={onLeaveMentionFolder}
					>
						<ChevronLeft className="size-3.5" aria-hidden />
					</button>
					<span
						className="min-w-0 flex-1 truncate pr-1 text-muted-foreground text-xs"
						title={mentionBrowseRoot}
					>
						{labelForPath(mentionBrowseRoot)}
					</span>
				</div>
			) : null}
			{mentionOptions.length === 0 ? (
				<div className="px-2 py-2 text-muted-foreground text-xs">
					{t("composer.mentionEmptyFolder")}
				</div>
			) : (
				mentionOptions.map((path, index) => {
					// Plaza rows: paper title as label, source name as the hint line.
					const plazaEntry = lookupPlazaMention(path);
					const label = plazaEntry?.title.trim() || labelForPath(path);
					const hint = plazaEntry
						? plazaEntry.sourceLabel
						: !mentionBrowseRoot && label !== path && path.includes("/")
							? path
							: null;
					const rowTitle = plazaEntry
						? `${plazaEntry.title} · ${plazaEntry.sourceLabel}`
						: path;
					const showPathHint = Boolean(hint);
					const canEnter = mentionPathHasChildren(
						path,
						mentionCandidates,
						paperPathSet,
					);
					return (
						<div
							key={path}
							className={cn(
								"flex w-full items-center gap-0.5 rounded-md text-sm",
								mentionActiveIndex === index ? "bg-muted" : "hover:bg-muted/70",
							)}
						>
							<button
								type="button"
								id={`agent-mention-option-${index}`}
								role="option"
								aria-selected={mentionActiveIndex === index}
								className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none"
								onMouseEnter={() => onMentionActiveIndexChange(index)}
								onClick={() => onAttachMention(path)}
							>
								<ContextPathIcon
									path={path}
									directoryPaths={directoryPathSet}
									paperPaths={paperPathSet}
								/>
								<span className="min-w-0 flex-1 truncate">
									<span className="block truncate" title={rowTitle}>
										{label}
									</span>
									{showPathHint ? (
										<span
											className="block truncate text-caption text-muted-foreground"
											title={rowTitle}
										>
											{hint}
										</span>
									) : null}
								</span>
							</button>
							{canEnter ? (
								<button
									type="button"
									tabIndex={-1}
									className="mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									aria-label={t("composer.mentionEnterFolder", {
										name: label,
									})}
									title={t("composer.mentionEnterFolder", {
										name: label,
									})}
									onMouseEnter={() => onMentionActiveIndexChange(index)}
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										onEnterMentionFolder(path);
									}}
								>
									<ChevronRight className="size-3.5" aria-hidden />
								</button>
							) : (
								<span className="mr-0.5 size-7 shrink-0" />
							)}
						</div>
					);
				})
			)}
		</PopoverContent>
	);
}
