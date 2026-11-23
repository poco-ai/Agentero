import { CheckCircle2, Loader2, Terminal, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isChatOnlyAgentTemplate } from "@/lib/agent/api";
import { cn } from "@/lib/core/utils";
import type { AgentAcpDiagnostic } from "@/lib/doctor/api";
import { DoctorSection } from "./doctor-sections";

function AgentCardShimmer() {
	return (
		<div className="rounded-xl border bg-card px-3.5 py-2.5" aria-hidden>
			<div className="flex items-start gap-2.5">
				<Skeleton className="library-shimmer mt-0.5 size-3.5 shrink-0 rounded-full" />
				<div className="min-w-0 flex-1 space-y-2.5">
					<Skeleton className="library-shimmer h-3.5 w-28" />
					<div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-2">
						<Skeleton className="library-shimmer h-3 w-10" />
						<div className="space-y-1">
							<Skeleton className="library-shimmer h-3 w-16" />
							<Skeleton className="library-shimmer h-3 w-full" />
						</div>
						<Skeleton className="library-shimmer h-3 w-8" />
						<div className="space-y-1">
							<Skeleton className="library-shimmer h-3 w-14" />
							<Skeleton className="library-shimmer h-3 w-5/6" />
						</div>
						<Skeleton className="library-shimmer h-3 w-8" />
						<Skeleton className="library-shimmer h-3 w-12" />
					</div>
				</div>
			</div>
		</div>
	);
}

function MetaRow({
	label,
	version,
	path,
	missingLabel,
}: {
	label: string;
	version?: string | null;
	path?: string | null;
	missingLabel: string;
}) {
	const hasVersion = Boolean(version?.trim());
	const hasPath = Boolean(path?.trim());
	if (!hasVersion && !hasPath) {
		return (
			<>
				<span className="text-foreground/70">{label}</span>
				<span className="text-muted-foreground">{missingLabel}</span>
			</>
		);
	}
	return (
		<>
			<span className="pt-px text-foreground/70">{label}</span>
			<div className="min-w-0">
				{hasVersion ? (
					<p className="truncate font-medium text-foreground text-xs tabular-nums">
						{version}
					</p>
				) : null}
				{hasPath ? (
					<p
						className="truncate text-muted-foreground"
						title={path ?? undefined}
					>
						{path}
					</p>
				) : null}
			</div>
		</>
	);
}

function AgentCard({
	agent,
	onLogin,
}: {
	agent: AgentAcpDiagnostic;
	onLogin?: (templateId: string) => void;
}) {
	const { t } = useTranslation("settings");
	const category = agent.failureCategory ?? "unknown";
	const authStatus = agent.authStatus ?? "unknown";
	// Claude/Codex ACP adapters ship bundled with the app, so the ACP row would
	// only ever report a meaningless PATH probe. (#686)
	const showAcp =
		agent.template !== "claude-acp" && agent.template !== "codex-acp";
	// Built-in chat-only agents (Zhihu) have neither a host CLI nor an ACP
	// entrypoint, so both tool rows are inapplicable. (#1233)
	const showTools = !isChatOnlyAgentTemplate(agent.template);
	const canLogin =
		authStatus === "unauthenticated" &&
		Boolean(agent.loginCommand?.trim()) &&
		Boolean(onLogin);
	return (
		<div className="rounded-xl border bg-card px-3.5 py-2.5">
			<div className="flex items-start gap-2.5">
				{agent.ok ? (
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
					<div className="flex items-baseline justify-between gap-3">
						<p className="truncate font-medium text-sm" title={agent.name}>
							{agent.name}
							{agent.template !== "custom" ? (
								<span className="ml-1.5 font-normal text-muted-foreground text-xs">
									{agent.template}
								</span>
							) : null}
						</p>
						{!agent.ok ? (
							<p className="shrink-0 text-amber-700 text-xs">
								{t(`doctor.agent.categories.${category}`)}
							</p>
						) : null}
					</div>
					<div className="mt-2 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs leading-snug">
						{showTools ? (
							<MetaRow
								label="Agent"
								version={agent.agentVersion}
								path={agent.agentPath}
								missingLabel={t("doctor.agent.locationMissing")}
							/>
						) : null}
						{showTools && showAcp ? (
							<MetaRow
								label="ACP"
								version={agent.acpVersion}
								path={agent.resolvedPath}
								missingLabel={t("doctor.agent.locationMissing")}
							/>
						) : null}
						<span className="text-foreground/70">
							{t("doctor.agent.authLabel")}
						</span>
						<span
							className={cn(
								authStatus === "authenticated" && "text-emerald-700",
								authStatus === "unauthenticated" && "text-amber-700",
								authStatus !== "authenticated" &&
									authStatus !== "unauthenticated" &&
									"text-muted-foreground",
							)}
						>
							{t(`doctor.agent.authStatus.${authStatus}`)}
						</span>
					</div>
					{!agent.ok ? (
						<div className="mt-2 flex items-start justify-between gap-2 border-border/50 border-t pt-2">
							<div className="min-w-0 space-y-0.5">
								{agent.error ? (
									<p className="whitespace-pre-wrap break-words text-xs">
										{agent.error}
									</p>
								) : null}
								<p className="text-muted-foreground text-xs">
									{t(`doctor.agent.hints.${category}`)}
								</p>
							</div>
							{canLogin ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="h-7 shrink-0 gap-1 px-2 text-xs"
									aria-label={t("doctor.agent.loginAria", {
										name: agent.name,
									})}
									title={t("doctor.agent.loginTitle", {
										command: agent.loginCommand,
									})}
									onClick={() => onLogin?.(agent.template)}
								>
									<Terminal className="size-3" />
									{t("doctor.agent.login")}
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

export function DoctorAgentSection({
	report,
	loading,
	error,
	onLogin,
}: {
	report: AgentAcpDiagnostic[] | null;
	loading: boolean;
	error?: string | null;
	onLogin?: (templateId: string) => void;
}) {
	const { t } = useTranslation("settings");
	const failed = error ? 1 : (report?.filter((agent) => !agent.ok).length ?? 0);
	const hasAgents = Boolean(report && report.length > 0);
	// While probing with nothing useful to show, prefer shimmer over "none".
	const showShimmer = loading && !error && !hasAgents;
	return (
		<DoctorSection
			title={t("doctor.sections.agents")}
			description={t("doctor.sectionHints.agents")}
			ok={failed === 0}
			issueCount={failed}
			framed={false}
			action={
				loading && hasAgents ? (
					<Loader2
						className="size-3.5 animate-spin text-muted-foreground"
						aria-hidden
					/>
				) : undefined
			}
		>
			{error ? (
				<div className="rounded-xl border bg-card px-3.5 py-2.5">
					<div className="flex items-start gap-2.5">
						<TriangleAlert
							className="mt-0.5 size-3.5 shrink-0 text-amber-600"
							aria-hidden
						/>
						<p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs">
							{error}
						</p>
					</div>
				</div>
			) : showShimmer ? (
				<div
					className="flex flex-col gap-2"
					role="status"
					aria-busy="true"
					aria-label={t("doctor.agent.probing")}
				>
					<AgentCardShimmer />
					<AgentCardShimmer />
				</div>
			) : hasAgents ? (
				<div className="flex flex-col gap-2">
					{report?.map((agent) => (
						<AgentCard key={agent.agentId} agent={agent} onLogin={onLogin} />
					))}
				</div>
			) : (
				<div className="rounded-xl border bg-card px-3.5 py-2.5">
					<p className="text-muted-foreground text-xs">
						{t("doctor.agent.none")}
					</p>
				</div>
			)}
		</DoctorSection>
	);
}
