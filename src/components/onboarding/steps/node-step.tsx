import {
	CheckCircle2,
	Download,
	ExternalLink,
	Loader2,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useHostNodeStatus } from "@/hooks/use-host-node-status";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type { HostToolDiagnostic } from "@/lib/doctor/api";
import { NODE_DOWNLOAD_URL } from "@/lib/doctor/node-guidance";

function ToolStatus({
	label,
	tool,
}: {
	label: string;
	tool: HostToolDiagnostic | null;
}) {
	const { t } = useTranslation("onboarding");
	const available = tool?.status === "available";
	return (
		<div className="flex items-start gap-2.5 rounded-lg border bg-background p-3">
			{available ? (
				<CheckCircle2
					className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
					aria-hidden
				/>
			) : (
				<TriangleAlert
					className="mt-0.5 size-3.5 shrink-0 text-amber-600"
					aria-hidden
				/>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline justify-between gap-2">
					<p className="font-medium text-sm">{label}</p>
					<p
						className={cn(
							"shrink-0 text-xs",
							available ? "text-emerald-700" : "text-amber-700",
						)}
					>
						{available ? t("node.installed") : t("node.missing")}
					</p>
				</div>
				{tool?.version ? (
					<p
						className="truncate font-mono text-caption text-muted-foreground"
						title={tool.version}
					>
						{tool.version}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function NodeStep() {
	const { t } = useTranslation("onboarding");
	const { report, probing, installing, installProgress, refresh, installNode } =
		useHostNodeStatus();

	if (probing && !report) {
		return (
			<div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-muted-foreground text-xs">
				<Loader2 className="size-4 animate-spin" aria-hidden />
				<span>{t("node.checking")}</span>
			</div>
		);
	}

	const ready =
		report?.node.status === "available" && report.npm.status === "available";

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-3">
				<ToolStatus label="Node.js" tool={report?.node ?? null} />
				<ToolStatus label="npm" tool={report?.npm ?? null} />
			</div>

			{ready ? (
				<div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2.5">
					<CheckCircle2
						className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
						aria-hidden
					/>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm leading-snug">
							{t("node.ready")}
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
							{t("node.readyDesc")}
						</p>
					</div>
				</div>
			) : (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
					<div className="flex items-start gap-2.5">
						<TriangleAlert
							className="mt-0.5 size-3.5 shrink-0 text-amber-600"
							aria-hidden
						/>
						<div className="min-w-0 flex-1">
							<p className="font-medium text-sm leading-snug">
								{t("node.missingTitle")}
							</p>
							<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
								{t("node.missingDesc")}
							</p>
						</div>
					</div>

					{isTauri() ? (
						<div className="mt-3 space-y-2">
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={installing}
									onClick={() => void installNode()}
								>
									{installing ? (
										<Loader2 className="animate-spin" aria-hidden />
									) : (
										<Download aria-hidden />
									)}
									{installing ? t("node.installing") : t("node.install")}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => openExternalUrl(NODE_DOWNLOAD_URL)}
								>
									<ExternalLink aria-hidden />
									{t("node.download")}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={t("node.recheck")}
									title={t("node.recheck")}
									disabled={installing || probing}
									onClick={() => void refresh()}
								>
									<RefreshCw aria-hidden />
								</Button>
							</div>
							<p className="text-muted-foreground text-caption leading-snug">
								{t("node.installHint")}
							</p>
							{installing ? (
								<div className="space-y-1">
									<Progress value={installProgress ?? 0} className="h-1" />
									<p className="text-right font-mono text-caption text-muted-foreground tabular-nums">
										{installProgress == null
											? ""
											: `${Math.round(installProgress)}%`}
									</p>
								</div>
							) : null}
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
