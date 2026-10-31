import {
	CheckCircle2,
	Download,
	ExternalLink,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import type { HostDoctorReport, HostToolDiagnostic } from "@/lib/doctor/api";
import { installNodeInBackground } from "@/lib/doctor/install-node";
import { NODE_DOWNLOAD_URL } from "@/lib/doctor/node-guidance";
import { DoctorSection } from "./doctor-sections";

function StatusIcon({ ok }: { ok: boolean }) {
	return ok ? (
		<CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
	) : (
		<TriangleAlert className="size-3.5 text-amber-600" aria-hidden />
	);
}

function ToolRow({ label, tool }: { label: string; tool: HostToolDiagnostic }) {
	const { t } = useTranslation("settings");
	const available = tool.status === "available";
	return (
		<div className="flex items-start gap-2.5 border-b px-3.5 py-2.5 last:border-b-0">
			<StatusIcon ok={available} />
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline justify-between gap-3">
					<p className="font-medium text-sm">{label}</p>
					<p
						className={cn(
							"shrink-0 text-xs",
							available ? "text-emerald-700" : "text-amber-700",
						)}
					>
						{t(`doctor.host.toolStatus.${tool.status}`)}
					</p>
				</div>
				{tool.version ? <p className="text-xs">{tool.version}</p> : null}
				{tool.resolvedPath ? (
					<p
						className="truncate text-muted-foreground text-xs"
						title={tool.resolvedPath}
					>
						{tool.resolvedPath}
					</p>
				) : null}
				{tool.detail ? (
					<p className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
						{tool.detail}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function DoctorHostRuntimeSection({
	report,
	error,
	onRefresh,
}: {
	report: HostDoctorReport | null;
	error?: string | null;
	onRefresh: () => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [installing, setInstalling] = useState(false);
	const [installNotice, setInstallNotice] = useState<string | null>(null);

	const nodeMissing = report ? report.node.status !== "available" : false;
	const npmMissing = report ? report.npm.status !== "available" : false;
	const showInstall = nodeMissing || npmMissing || installNotice !== null;

	const handleInstall = async () => {
		setInstalling(true);
		try {
			const result = await installNodeInBackground();
			// null = not desktop / already running / cancelled: leave the row alone.
			if (!result) return;
			if (result.outcome === "no-package-manager") {
				setInstallNotice(t("doctor.host.install.noPackageManager"));
			} else if (result.error) {
				setInstallNotice(result.error);
			} else {
				setInstallNotice(null);
				await onRefresh();
			}
		} catch (installErr) {
			setInstallNotice(
				installErr instanceof Error
					? installErr.message
					: String(installErr ?? "unknown error"),
			);
		} finally {
			setInstalling(false);
		}
	};

	const issues = error
		? 1
		: report
			? Number(report.node.status !== "available") +
				Number(report.npm.status !== "available")
			: 0;

	return (
		<DoctorSection
			title={t("doctor.sections.host")}
			description={t("doctor.sectionHints.host")}
			ok={issues === 0}
			issueCount={issues}
			action={
				showInstall ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={installing}
								onClick={() => void handleInstall()}
							>
								<Download
									className={cn("size-3.5", installing && "animate-pulse")}
								/>
								{installing
									? t("doctor.host.install.installing")
									: t("doctor.host.install.button")}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("doctor.host.install.tooltip")}</TooltipContent>
					</Tooltip>
				) : null
			}
		>
			{error ? (
				<div className="flex items-start gap-2.5 px-3.5 py-2.5">
					<TriangleAlert
						className="mt-0.5 size-3.5 shrink-0 text-amber-600"
						aria-hidden
					/>
					<p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs">
						{error}
					</p>
				</div>
			) : report ? (
				<>
					<ToolRow label="Node.js" tool={report.node} />
					<ToolRow label="npm" tool={report.npm} />
					{showInstall ? (
						<div className="space-y-2 px-3.5 py-2.5">
							{installNotice ? (
								<p className="whitespace-pre-wrap break-words text-amber-700 text-xs">
									{installNotice}
								</p>
							) : (
								<p className="text-muted-foreground text-xs">
									{t("doctor.host.install.hint")}
								</p>
							)}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => openExternalUrl(NODE_DOWNLOAD_URL)}
							>
								<ExternalLink className="size-3.5" />
								{t("doctor.host.install.download")}
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</DoctorSection>
	);
}
