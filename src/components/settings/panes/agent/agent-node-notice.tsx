import { Download, Loader2, Stethoscope, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * Compact Node.js / npm reminder at the top of Settings → Agent.
 *
 * Bundled ACP adapters and npm-installed Agents cannot run without Node.js, and
 * the actionable install buttons below would otherwise start a background
 * lifecycle that fails straight away. The notice offers the same one-click
 * install as Environment diagnostics plus a shortcut to that section for the
 * full tool report. Rendered while the host check says something is missing
 * (installable) or present but unable to run (e.g. a loader conflict, #1002);
 * the latter offers diagnostics instead of an install that cannot help.
 */
export function AgentNodeNotice({
	nodeMissing,
	npmMissing,
	nodeUnusable,
	npmUnusable,
	installing,
	onInstall,
	onOpenDiagnostics,
}: {
	nodeMissing: boolean;
	npmMissing: boolean;
	nodeUnusable: boolean;
	npmUnusable: boolean;
	installing: boolean;
	onInstall: () => void;
	onOpenDiagnostics: () => void;
}) {
	const { t } = useTranslation("settings");
	const missing = nodeMissing || npmMissing;
	if (!missing && !nodeUnusable && !npmUnusable) return null;
	const title = nodeMissing
		? t("agent.nodeNotice.title")
		: npmMissing
			? t("agent.nodeNotice.npmTitle")
			: nodeUnusable
				? t("agent.nodeNotice.unusableTitle")
				: t("agent.nodeNotice.npmUnusableTitle");
	return (
		<div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5">
			<TriangleAlert
				className="mt-0.5 size-3.5 shrink-0 text-amber-600"
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-sm leading-snug">{title}</p>
				<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
					{missing
						? t("agent.nodeNotice.description")
						: t("agent.nodeNotice.unusableDescription")}
				</p>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 self-center">
				{missing ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 gap-1 px-2 text-xs"
						disabled={installing}
						onClick={onInstall}
					>
						{installing ? (
							<Loader2 className="size-3 animate-spin" aria-hidden />
						) : (
							<Download className="size-3" aria-hidden />
						)}
						{installing
							? t("doctor.host.install.installing")
							: t("doctor.host.install.button")}
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 gap-1 px-2 text-xs"
					onClick={onOpenDiagnostics}
				>
					<Stethoscope className="size-3" aria-hidden />
					{t("agent.nodeNotice.diagnostics")}
				</Button>
			</div>
		</div>
	);
}
