import { Download, LoaderCircle, Wifi, X } from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import {
	catalogNeedsProbe,
	patchCatalogProbe,
} from "@/components/settings/panes/agent-catalog";
import { Progress } from "@/components/ui/progress";
import { useAgentToolLifecycle } from "@/hooks/use-agent-tool-lifecycle";
import {
	type CatalogEntry,
	type CatalogScanResponse,
	ensureCatalogAgent,
	probeCatalogAgent,
	scanCatalog,
} from "@/lib/agent/api";
import { errorText } from "@/lib/core/error";
import { cn } from "@/lib/core/utils";

/** Imperative handle so the wizard header can trigger a rescan. */
export type AgentStepHandle = {
	rescan: () => void;
};

function statusDotClass(status: CatalogEntry["acpStatus"]): string {
	switch (status) {
		case "ready":
			return "bg-emerald-500";
		case "failed":
			return "bg-destructive";
		case "not-probed":
			return "bg-muted-foreground/40";
		default:
			return "bg-muted-foreground/30";
	}
}

type StatusLabelKey =
	| "agent.ready"
	| "agent.failed"
	| "agent.notProbed"
	| "agent.missing";

function statusLabelKey(status: CatalogEntry["acpStatus"]): StatusLabelKey {
	switch (status) {
		case "ready":
			return "agent.ready";
		case "failed":
			return "agent.failed";
		case "not-probed":
			return "agent.notProbed";
		default:
			return "agent.missing";
	}
}

function isAvailable(entry: CatalogEntry): boolean {
	return (
		entry.acpStatus === "ready" ||
		Boolean(entry.registeredId) ||
		entry.acpCommandAvailable
	);
}

/**
 * Which layer is missing for an unusable entry — the host CLI (`agent`) or the
 * ACP adapter (`adapter`). Without this, dimmed cards look identical whether the
 * user never installed the agent or only lacks its ACP entrypoint.
 */
function missingLayer(entry: CatalogEntry): "agent" | "adapter" | null {
	if (entry.acpCommandAvailable) return null;
	return entry.binaryAvailable ? "adapter" : "agent";
}

function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

export const AgentStep = forwardRef<AgentStepHandle>(
	function AgentStep(_props, ref) {
		const { t } = useTranslation(["onboarding", "common"]);
		const [state, setState] = useState<CatalogScanResponse | null>(null);
		const [scanning, setScanning] = useState(false);
		const [error, setError] = useState<string | null>(null);
		const [busyId, setBusyId] = useState<string | null>(null);
		const mountedRef = useRef(true);

		useEffect(() => {
			mountedRef.current = true;
			return () => {
				mountedRef.current = false;
			};
		}, []);

		const runScan = useCallback(async () => {
			setScanning(true);
			setError(null);
			try {
				const res = await scanCatalog();
				if (mountedRef.current) setState(res);
				return res;
			} catch {
				if (mountedRef.current) setError(t("agent.scanFailed"));
				return null;
			} finally {
				if (mountedRef.current) setScanning(false);
			}
		}, [t]);

		const probeInstalled = useCallback(
			async (scan: CatalogScanResponse, force: boolean) => {
				const candidates = scan.entries.filter((entry) =>
					catalogNeedsProbe(entry, force),
				);
				if (candidates.length === 0) return;

				await Promise.allSettled(
					candidates.map(async (entry) => {
						try {
							const result = await probeCatalogAgent(entry.templateId);
							if (!mountedRef.current) return;
							setState((prev) =>
								prev ? patchCatalogProbe(prev, entry.templateId, result) : prev,
							);
						} catch (e) {
							if (!mountedRef.current) return;
							setState((prev) =>
								prev
									? patchCatalogProbe(prev, entry.templateId, {
											agentId: entry.registeredId ?? entry.templateId,
											available: false,
											error: errorText(e),
										})
									: prev,
							);
						}
					}),
				);
			},
			[],
		);

		const {
			lifecycleBusyIds,
			lifecycleProgress,
			runToolLifecycle: runLifecycle,
			cancelToolLifecycle,
		} = useAgentToolLifecycle({
			scanOnce: runScan,
			probeInstalled,
			onError: (message) => {
				if (mountedRef.current) setError(message);
			},
		});

		useEffect(() => {
			void runScan();
		}, [runScan]);

		useImperativeHandle(
			ref,
			() => ({
				rescan: () => {
					void runScan();
				},
			}),
			[runScan],
		);

		const onSetDefault = async (entry: CatalogEntry) => {
			setBusyId(entry.templateId);
			try {
				await ensureCatalogAgent(entry.templateId, true);
				await runScan();
			} finally {
				if (mountedRef.current) setBusyId(null);
			}
		};

		const onInstall = async (entry: CatalogEntry) => {
			setError(null);
			await runLifecycle(entry, "install");
		};

		const entries = sortEntries(state?.entries ?? []);

		return (
			<div className="space-y-4">
				{error ? <p className="text-destructive text-xs">{error}</p> : null}

				{entries.length === 0 ? (
					<div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-muted-foreground text-xs">
						<Wifi className="size-4 shrink-0" />
						<span>{scanning ? t("agent.scanning") : t("agent.none")}</span>
					</div>
				) : (
					<ul className="grid grid-cols-4 gap-3">
						{entries.map((entry) => {
							const available = isAvailable(entry);
							const layer = available ? null : missingLayer(entry);
							const adapterOnly = layer === "adapter";
							const isDefault =
								entry.isDefault || entry.registeredId === state?.defaultId;
							const settingDefault = busyId === entry.templateId;
							const installing = lifecycleBusyIds.has(entry.templateId);
							const busy = settingDefault || installing;
							const rowLifecycle = lifecycleProgress[entry.templateId];
							const cardClassName = cn(
								"group relative flex w-full flex-col items-center gap-2 rounded-xl border bg-background p-3 text-center outline-none transition-colors hover:border-primary/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
								isDefault && "border-primary bg-primary/5",
								!available && "opacity-60",
							);
							const cardContent = (
								<>
									{/* Top-right: "default" tag, status dot, or install icon. */}
									{isDefault ? (
										<span className="absolute top-2 right-2 rounded bg-primary px-1 py-0.5 text-caption leading-none font-medium text-primary-foreground">
											{t("agent.default")}
										</span>
									) : available ? (
										<span
											role="status"
											aria-label={t(statusLabelKey(entry.acpStatus))}
											className={cn(
												"absolute top-2 right-2 size-1.5 rounded-full",
												statusDotClass(entry.acpStatus),
											)}
										/>
									) : entry.canInstall ? (
										<button
											type="button"
											disabled={busy}
											aria-label={
												adapterOnly
													? t("agent.installAdapterAria", {
															name: entry.name,
														})
													: t("agent.installAgentAria", {
															name: entry.name,
														})
											}
											title={
												adapterOnly
													? t("agent.installAdapterTitle")
													: t("agent.installAgentTitle")
											}
											onClick={(e) => {
												e.stopPropagation();
												void onInstall(entry);
											}}
											className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground transition-colors opacity-80 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
										>
											{busy ? (
												<LoaderCircle className="size-3.5 animate-spin" />
											) : (
												<Download className="size-3.5" />
											)}
										</button>
									) : (
										<span
											role="status"
											aria-label={t(statusLabelKey(entry.acpStatus))}
											className="absolute top-2 right-2 size-1.5 rounded-full bg-muted-foreground/30"
										/>
									)}

									<div className="flex size-14 items-center justify-center">
										{settingDefault ? (
											<LoaderCircle className="size-6 animate-spin" />
										) : (
											<AgentLogo
												template={entry.templateId}
												className="size-12 rounded-none border-0 bg-transparent shadow-none"
												iconClassName="size-7"
											/>
										)}
									</div>
									<p className="w-full truncate text-sm font-medium">
										{entry.name}
									</p>
									{layer && !rowLifecycle ? (
										<p className="w-full text-caption text-muted-foreground leading-tight">
											{adapterOnly
												? t("agent.adapterMissing")
												: t("agent.agentMissing")}
										</p>
									) : null}
									{rowLifecycle ? (
										<div
											role="status"
											aria-live="polite"
											className="flex w-full flex-col gap-1"
										>
											<div className="grid grid-cols-[minmax(0,1fr)_2rem_1rem] items-center gap-1.5">
												<span className="truncate text-caption text-muted-foreground">
													{rowLifecycle.detail}
												</span>
												<span className="text-right font-mono text-caption text-muted-foreground tabular-nums">
													{rowLifecycle.progress == null
														? ""
														: `${Math.round(rowLifecycle.progress)}%`}
												</span>
												<button
													type="button"
													aria-label={t("common:cancel")}
													title={t("common:cancel")}
													onClick={(e) => {
														e.stopPropagation();
														cancelToolLifecycle(entry.templateId);
													}}
													className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
												>
													<X className="size-3" aria-hidden />
												</button>
											</div>
											<Progress
												value={rowLifecycle.progress ?? 0}
												className="h-1"
											/>
										</div>
									) : null}
								</>
							);
							return (
								<li key={entry.templateId}>
									{available ? (
										<button
											type="button"
											aria-pressed={isDefault}
											aria-label={`${entry.name} — ${t(statusLabelKey(entry.acpStatus))}`}
											disabled={busy}
											onClick={() => {
												void onSetDefault(entry);
											}}
											className={cardClassName}
										>
											{cardContent}
										</button>
									) : (
										<div className={cardClassName}>{cardContent}</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		);
	},
);
