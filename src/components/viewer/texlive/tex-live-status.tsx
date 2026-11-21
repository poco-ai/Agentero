import { useTranslation } from "react-i18next";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import {
	type TexLiveStatus,
	useTexLiveStatusStore,
} from "@/lib/tex-live/status";

const statusKeys = {
	starting: "fileTree.liveStarting",
	live: "fileTree.liveReady",
	waiting: "fileTree.liveWaiting",
	restarting: "fileTree.liveRestarting",
	failed: "fileTree.liveFailed",
} as const satisfies Record<TexLiveStatus, string>;

export function TexLiveStatusDot({ rootPath }: { rootPath: string }) {
	const { t } = useTranslation("sidebar");
	const preview = useTexLiveStatusStore((state) => state.byRoot[rootPath]);
	const status = preview?.status ?? "starting";
	const label = t(statusKeys[status]);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className="flex h-6 w-3 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
				>
					<span
						className={cn(
							"relative -top-1 size-1.5 shrink-0 rounded-full",
							status === "live"
								? "bg-emerald-500"
								: status === "failed"
									? "bg-red-500"
									: "bg-amber-500",
						)}
						aria-hidden
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				<span className="whitespace-pre-wrap break-words">
					{preview?.error ? `${label}\n${preview.error}` : label}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
