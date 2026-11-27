import { Loader2, Plus } from "lucide-react";
import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { FileTreeDisclosureIcon } from "@/components/sidebar/file-tree/file-tree-primitives";
import {
	FILE_TREE_ROW_STATE,
	TREE_ROW_INDENT_STEP_PX,
	TREE_ROW_INSET_PX,
} from "@/components/sidebar/tree-row-styles";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/core/utils";

const VISIBLE_SESSION_COUNT = 5;
const VERTICAL_REVEAL =
	"grid transition-[grid-template-rows] duration-(--motion-duration-normal) ease-(--motion-ease-out) motion-reduce:transition-none";

export const sessionRowIndentStyle = {
	paddingLeft: TREE_ROW_INSET_PX + TREE_ROW_INDENT_STEP_PX,
};

export function ZenHarnessSection<Row extends { status: string | null }>({
	name,
	template,
	loading,
	rows,
	renderRow,
	onNewSlot,
}: {
	name: string;
	template: string | null;
	loading: boolean;
	rows: Row[];
	renderRow: (row: Row) => ReactNode;
	onNewSlot: () => void;
}) {
	const { t } = useTranslation("agent");
	const [open, setOpen] = useState(true);
	const [showAll, setShowAll] = useState(false);
	const remainingId = useId();
	const firstExtraRow = useRef<HTMLDivElement>(null);
	const firstExtra = rows[VISIBLE_SESSION_COUNT];
	const remaining = rows.slice(VISIBLE_SESSION_COUNT + 1);
	useLayoutEffect(() => {
		if (!showAll) return;
		firstExtraRow.current
			?.querySelector<HTMLButtonElement>("button")
			?.focus({ preventScroll: true });
	}, [showAll]);
	return (
		<Collapsible
			asChild
			open={open}
			onOpenChange={(nextOpen) => {
				if (nextOpen) setShowAll(false);
				setOpen(nextOpen);
			}}
		>
			<section className="pb-1">
				<div
					className={cn(
						"group flex h-7 w-full items-center rounded-md pr-1 pl-2.5",
						FILE_TREE_ROW_STATE,
					)}
				>
					<CollapsibleTrigger
						type="button"
						aria-label={name}
						className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-md text-start outline-none focus-visible:ring-1 focus-visible:ring-brand"
					>
						<FileTreeDisclosureIcon
							isExpanded={open}
							icon={<AgentLogo template={template} plain className="size-4" />}
						/>
						<span className="min-w-0 flex-1 truncate font-medium text-xs">
							{name}
						</span>
						{loading ? (
							<Loader2
								className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
								aria-hidden
							/>
						) : null}
						{!open && rows.some((row) => row.status === "running") ? (
							<span
								role="img"
								aria-label={t("history.status.running")}
								className="size-1.5 shrink-0 rounded-full bg-emerald-500"
							/>
						) : null}
					</CollapsibleTrigger>
					<button
						type="button"
						aria-label={t("zen.newConversation")}
						title={t("zen.newConversation")}
						className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-brand"
						onClick={onNewSlot}
					>
						<Plus className="size-3.5" aria-hidden />
					</button>
				</div>
				<CollapsibleContent
					className="min-w-0 overflow-hidden duration-(--motion-duration-normal) ease-(--motion-ease-out) [--radix-accordion-content-height:var(--radix-collapsible-content-height)] motion-safe:data-open:animate-accordion-down motion-safe:data-closed:animate-accordion-up"
					inert={!open}
				>
					{rows.slice(0, VISIBLE_SESSION_COUNT).map(renderRow)}
					{firstExtra ? (
						<>
							<div ref={firstExtraRow} className="h-7">
								{showAll ? (
									renderRow(firstExtra)
								) : (
									<button
										type="button"
										aria-expanded={false}
										aria-controls={remainingId}
										className={cn(
											FILE_TREE_ROW_STATE,
											"flex h-7 w-full items-center rounded-md pr-1 text-start text-muted-foreground/80 text-xs focus-visible:ring-inset",
										)}
										style={sessionRowIndentStyle}
										onClick={() => setShowAll(true)}
									>
										{t("zen.showAllSessions")}
									</button>
								)}
							</div>
							<div
								id={remainingId}
								inert={!showAll}
								className={cn(
									VERTICAL_REVEAL,
									showAll ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
								)}
							>
								<div className="min-h-0 overflow-hidden">
									{showAll ? remaining.map(renderRow) : null}
								</div>
							</div>
						</>
					) : null}
				</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
