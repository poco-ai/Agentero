import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import {
	ArrowLeft,
	BookOpen,
	Camera,
	Check,
	ChevronDown,
	ChevronRight,
	Circle,
	FileText,
	History,
	Keyboard,
	Laptop,
	LoaderCircle,
	Search,
	X,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import agenteroLogo from "@/assets/agentero-logo.svg";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputBody,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	EdgeSwipeBack,
	useHorizontalSwipe,
} from "@/components/mobile/mobile-gestures";
import { MobileHeader as MobileHeaderPage } from "@/components/mobile/mobile-header";
import { MobileLibraryPage } from "@/components/mobile/mobile-library-page";
import { MobileNav, type MobileTab } from "@/components/mobile/mobile-nav";
import { MobileReaderPage } from "@/components/mobile/mobile-reader-page";
import { MobileSidebar } from "@/components/mobile/mobile-sidebar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
	AgentDescriptor,
	AgentListResponse,
	CatalogScanResponse,
} from "@/lib/agent/api";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import {
	type BridgeClientStatus,
	bridgeConnect,
	bridgeResume,
	bridgeRpc,
	bridgeStatus,
	listenBridgeEvent,
	listenBridgeProgress,
	listenBridgeStatus,
	listenPairPending,
	type PairPendingEvent,
} from "@/lib/bridge/client";
import { loadBridgePaperPdf } from "@/lib/bridge/pdf";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper/types";

const MobilePdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((module) => ({
		default: module.PdfViewer,
	})),
);

export default function MobileApp() {
	const { t } = useTranslation("mobile");
	const [tab, setTab] = useState<MobileTab>("library");
	const [libraryQuery, setLibraryQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [pairingRequested, setPairingRequested] = useState(false);
	const [pendingOffer, setPendingOffer] = useState<string | null>(null);
	const [status, setStatus] = useState<BridgeClientStatus>({
		connected: false,
		paired: false,
	});
	const [papers, setPapers] = useState<PaperMetadata[]>([]);
	const [papersLoading, setPapersLoading] = useState(false);
	const [selectedPaper, setSelectedPaper] = useState<PaperMetadata | null>(
		null,
	);
	const [readerMode, setReaderMode] = useState<"pdf" | "notes">("pdf");
	const [agents, setAgents] = useState<AgentDescriptor[]>([]);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [agentsLoading, setAgentsLoading] = useState(false);
	const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
	const [pairPending, setPairPending] = useState<PairPendingEvent | null>(null);

	const swipeHandlers = useHorizontalSwipe(
		({ dx, dy, fromEdge, durationMs }) => {
			if (sidebarOpen || selectedPaper) return;
			if (durationMs > 500 || Math.abs(dy) > 60) return;
			const horizontal = Math.abs(dx) > Math.abs(dy) * 1.25;
			if (!horizontal) return;
			if (dx > 60 && fromEdge) {
				setSidebarOpen(true);
				return;
			}
			if (dx < -60 && tab === "library") {
				setTab("agent");
				return;
			}
			if (dx > 60 && tab === "agent") {
				setTab("library");
			}
		},
	);

	useEffect(() => {
		if (!isTauri()) return;
		let active = true;
		const unlisten: Array<() => void> = [];
		const resume = async () => {
			try {
				const [offStatus, offPairPending] = await Promise.all([
					listenBridgeStatus((next) => active && setStatus(next)),
					listenPairPending((next) => active && setPairPending(next)),
				]);
				if (!active) {
					offStatus();
					offPairPending();
					return;
				}
				unlisten.push(offStatus, offPairPending);
				const next = await bridgeResume().catch(() => bridgeStatus());
				if (active) setStatus(next);
			} catch {
				// Keep the pairing screen usable when the native bridge is unavailable.
			}
		};
		void resume();

		const onVisible = () => {
			if (document.visibilityState !== "visible" || !active) return;
			void bridgeStatus()
				.then((next) => {
					if (active) setStatus(next);
					if (active && next.paired && !next.connected) {
						return bridgeResume().then((resumed) => {
							if (active) setStatus(resumed);
						});
					}
					return undefined;
				})
				.catch(() => undefined);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active = false;
			document.removeEventListener("visibilitychange", onVisible);
			for (const off of unlisten) off();
		};
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		let active = true;
		const acceptOffer = (value: string) => {
			if (!isPairOfferUrl(value)) return;
			setPendingOffer(value);
			setPairingRequested(true);
		};
		void getCurrent()
			.then((urls) => urls?.forEach(acceptOffer))
			.catch(() => undefined);
		let unlisten: (() => void) | undefined;
		void onOpenUrl((urls) => urls.forEach(acceptOffer))
			.then((off) => {
				if (active) unlisten = off;
				else off();
			})
			.catch(() => undefined);
		return () => {
			active = false;
			unlisten?.();
		};
	}, []);

	const refreshPapers = useCallback(async () => {
		if (!status.paired || !status.connected) return;
		setPapersLoading(true);
		try {
			const next = await bridgeRpc<PaperMetadata[]>("paper_list");
			setPapers(next);
		} catch {
			// Keep the last successful list during a transient bridge failure.
		} finally {
			setPapersLoading(false);
		}
	}, [status.connected, status.paired]);

	useEffect(() => {
		if (!status.paired) {
			setPapers([]);
			setPapersLoading(false);
			setSelectedPaper(null);
			setAgents([]);
			setSelectedAgentId(null);
			setAgentSessionId(null);
			return;
		}
		if (!status.connected) return;

		void refreshPapers();
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") void refreshPapers();
		};
		window.addEventListener("focus", refreshWhenVisible);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible" && tab === "library") {
				void refreshPapers();
			}
		}, 10_000);

		return () => {
			window.removeEventListener("focus", refreshWhenVisible);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
			window.clearInterval(interval);
		};
	}, [refreshPapers, status.connected, status.paired, tab]);

	useEffect(() => {
		if (!status.paired || !status.connected || tab !== "agent") return;
		let active = true;
		setAgentsLoading(true);
		void Promise.all([
			bridgeRpc<AgentListResponse>("agent_list_agents"),
			bridgeRpc<CatalogScanResponse>("agent_scan_catalog"),
		])
			.then(([result, catalog]) => {
				if (!active) return;
				const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
				for (const agent of catalog.customAgents) {
					byId.set(agent.id, agent);
				}
				for (const entry of catalog.entries) {
					if (entry.acpStatus !== "ready" || !entry.registeredId) continue;
					if (byId.has(entry.registeredId)) continue;
					byId.set(entry.registeredId, {
						id: entry.registeredId,
						name: entry.acpAgentName ?? entry.name,
						template: entry.templateId as AgentDescriptor["template"],
						command: entry.command,
						args: entry.args,
						env: {},
						available: true,
						lastProbeOk: true,
					});
				}
				const nextAgents = [...byId.values()];
				setAgents(nextAgents);
				setSelectedAgentId((current) => {
					if (current && nextAgents.some((agent) => agent.id === current)) {
						return current;
					}
					return (
						result.defaultId ??
						catalog.defaultId ??
						nextAgents.find((agent) => agent.available)?.id ??
						nextAgents[0]?.id ??
						null
					);
				});
			})
			.catch(() => {
				if (active) setAgents([]);
			})
			.finally(() => {
				if (active) setAgentsLoading(false);
			});
		return () => {
			active = false;
		};
	}, [status.connected, status.paired, tab]);

	const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);

	if (!status.paired || pairingRequested) {
		return (
			<MobilePairing
				status={status}
				pending={pairPending}
				initialOffer={pendingOffer}
				onStatus={setStatus}
				onDone={() => {
					setPendingOffer(null);
					setPairingRequested(false);
				}}
			/>
		);
	}

	return (
		<div
			className="mobile-shell flex h-dvh min-h-0 overflow-hidden bg-background text-foreground"
			{...swipeHandlers}
		>
			<aside className="hidden w-20 shrink-0 flex-col items-center border-r bg-muted/25 py-6 md:flex">
				<MobileBrand />
				<MobileNav tab={tab} onTab={setTab} />
			</aside>
			<main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
				<MobileHeaderPage
					title={
						tab === "library" && selectedPaper
							? selectedPaper.title
							: t(`tabs.${tab}`)
					}
					status={status}
					statusLabel={
						status.connected ? t("settings.connected") : t("settings.offline")
					}
					brand={<MobileBrand />}
					brandButtonLabel={t("settings.menu")}
					onBrandClick={() => setSidebarOpen(true)}
					showBrand={!selectedPaper}
					leading={
						tab === "library" && selectedPaper ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("reader.back")}
								onClick={() => {
									setSelectedPaper(null);
									setReaderMode("pdf");
								}}
							>
								<ArrowLeft className="size-4" />
							</Button>
						) : undefined
					}
					trailing={
						tab === "library" && selectedPaper ? (
							<div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
								<button
									type="button"
									aria-label={t("reader.pdf")}
									aria-pressed={readerMode === "pdf"}
									onClick={() => setReaderMode("pdf")}
									className={cn(
										"grid size-9 place-items-center rounded-md",
										readerMode === "pdf" && "bg-background shadow-sm",
									)}
								>
									<BookOpen className="size-4" />
								</button>
								<button
									type="button"
									aria-label={t("reader.notes")}
									aria-pressed={readerMode === "notes"}
									onClick={() => setReaderMode("notes")}
									className={cn(
										"grid size-9 place-items-center rounded-md",
										readerMode === "notes" && "bg-background shadow-sm",
									)}
								>
									<FileText className="size-4" />
								</button>
							</div>
						) : tab === "library" ? (
							<div className="relative w-[min(10rem,38vw)] shrink-0">
								<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={libraryQuery}
									onChange={(event) => setLibraryQuery(event.target.value)}
									placeholder={t("library.search")}
									aria-label={t("library.search")}
									className="h-10 w-full pl-8 text-base md:text-sm"
								/>
							</div>
						) : tab === "agent" ? (
							<div className="flex min-w-0 items-center gap-1">
								<DropdownMenu>
									<DropdownMenuTrigger
										asChild
										disabled={agentsLoading || agents.length === 0}
									>
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="h-9 min-w-0 max-w-[min(48vw,12rem)] justify-between gap-1.5 rounded-lg px-2.5"
											aria-label={t("agent.switchBackend")}
											title={t("agent.switchBackend")}
										>
											<span className="truncate">
												{selectedAgent?.name ?? t("agent.defaultBackend")}
											</span>
											<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										{agents.map((agent) => (
											<DropdownMenuItem
												key={agent.id}
												disabled={!agent.available}
												onSelect={() => {
													if (agent.id !== selectedAgentId) {
														setSelectedAgentId(agent.id);
														setAgentSessionId(null);
													}
												}}
												className="gap-2"
											>
												<span className="min-w-0 flex-1 truncate">
													{agent.name}
												</span>
												{agent.id === selectedAgentId ? (
													<Check className="size-4 shrink-0" />
												) : null}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t("agent.history")}
									onClick={() => {
										window.dispatchEvent(
											new CustomEvent("mobile:agent-history"),
										);
									}}
								>
									<History className="size-4" />
								</Button>
							</div>
						) : undefined
					}
				/>
				<div className="h-16 shrink-0 md:hidden" aria-hidden="true" />
				<div className="min-h-0 flex-1 overflow-hidden">
					{tab === "library" ? (
						selectedPaper ? (
							<EdgeSwipeBack
								onBack={() => {
									setSelectedPaper(null);
									setReaderMode("pdf");
								}}
							>
								<MobileReaderPage paper={selectedPaper} mode={readerMode} />
							</EdgeSwipeBack>
						) : (
							<MobileLibraryPage
								papers={papers}
								loading={papersLoading}
								selected={selectedPaper}
								onSelect={setSelectedPaper}
								query={libraryQuery}
							/>
						)
					) : null}
					{tab === "agent" ? (
						<MobileAgent
							key={selectedAgentId ?? "default"}
							selectedAgentId={selectedAgentId}
							sessionId={agentSessionId}
							onSessionId={setAgentSessionId}
						/>
					) : null}
				</div>
			</main>
			<MobileSidebar
				open={sidebarOpen}
				status={status}
				onClose={() => setSidebarOpen(false)}
				onStatus={setStatus}
				onPairAnother={() => {
					setPendingOffer(null);
					setPairingRequested(true);
				}}
			/>
		</div>
	);
}

export function LegacyMobileHeader({
	title,
	status,
	statusLabel,
	leading,
	trailing,
}: {
	title: string;
	status: BridgeClientStatus;
	statusLabel: string;
	leading?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 md:px-6">
			{leading}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<div className="md:hidden">
					<MobileBrand />
				</div>
				<span className="truncate font-semibold text-sm">{title}</span>
				<Circle
					className={cn(
						"size-2 shrink-0 fill-current",
						status.connected ? "text-emerald-500" : "text-muted-foreground",
					)}
					aria-label={statusLabel}
				/>
			</div>
			{trailing}
		</header>
	);
}

function isPairOfferUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "agentero:" &&
			url.hostname === "pair" &&
			url.hash.startsWith("#offer=")
		);
	} catch {
		return false;
	}
}

function describeBridgeError(
	message: string | undefined,
	networkPermissionMessage: string,
): string | null {
	if (!message) return null;
	if (/operation not permitted/i.test(message)) {
		return networkPermissionMessage;
	}
	return message;
}

function MobileBrand() {
	return <img src={agenteroLogo} alt="Agentero" className="size-8" />;
}

function MobilePairing({
	status,
	pending,
	initialOffer,
	onStatus,
	onDone,
}: {
	status: BridgeClientStatus;
	pending: PairPendingEvent | null;
	initialOffer: string | null;
	onStatus: (status: BridgeClientStatus) => void;
	onDone: () => void;
}) {
	const { t } = useTranslation("mobile");
	const [offerUrl, setOfferUrl] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [scannerOpen, setScannerOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	useEffect(() => {
		let dispose: (() => void) | undefined;
		let active = true;
		void listenBridgeProgress((phase) => {
			if (!active) return;
			const message = t(`connect.progress.${phase}`);
			if (phase === "connected") {
				toast.success(message, { id: "bridge-progress", duration: 2500 });
			} else {
				toast.loading(message, { id: "bridge-progress" });
			}
		}).then((fn) => {
			if (active) dispose = fn;
			else fn();
		});
		return () => {
			active = false;
			dispose?.();
			toast.dismiss("bridge-progress");
		};
	}, [t]);
	const connect = useCallback(
		async (value: string) => {
			const offer = value.trim();
			if (!offer) return;
			setConnecting(true);
			setError(null);
			try {
				const next = await bridgeConnect({
					offerUrl: offer,
					deviceName: navigator.userAgent.includes("iPad") ? "iPad" : "iPhone",
				});
				setLinkOpen(false);
				onStatus(next);
				onDone();
			} catch (cause) {
				toast.dismiss("bridge-progress");
				setError(
					describeBridgeError(
						cause instanceof Error ? cause.message : undefined,
						t("errors.networkPermission"),
					) ?? t("errors.connect"),
				);
			} finally {
				setConnecting(false);
			}
		},
		[onStatus, onDone, t],
	);
	const handleScannedOffer = useCallback(
		(value: string) => {
			setScannerOpen(false);
			setOfferUrl(value);
			void connect(value);
		},
		[connect],
	);
	useEffect(() => {
		if (!initialOffer) return;
		setOfferUrl(initialOffer);
		setError(null);
		setLinkOpen(true);
	}, [initialOffer]);
	return (
		<div className="mobile-shell flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-8 sm:px-8 md:mx-auto md:max-w-md">
			<div className="flex flex-1 flex-col items-center justify-center">
				<img src={agenteroLogo} alt="Agentero" className="size-28" />
				<h1 className="mt-6 font-semibold text-2xl">{t("connect.title")}</h1>
				<div className="mt-10 w-full space-y-3">
					<Button
						className="w-full"
						size="lg"
						disabled={connecting}
						onClick={() => {
							setError(null);
							setScannerOpen(true);
						}}
					>
						{connecting ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Camera className="size-4" />
						)}
						{connecting ? t("connect.connecting") : t("connect.camera")}
					</Button>
					<Button
						type="button"
						variant="outline"
						className="w-full"
						size="lg"
						disabled={connecting}
						onClick={() => {
							setError(null);
							setLinkOpen(true);
						}}
					>
						<Keyboard className="size-4" />
						{t("connect.manual")}
					</Button>
				</div>
				{pending ? (
					<div className="mt-8 w-full border-l-2 border-foreground px-4 py-2">
						<p className="text-sm">{t("connect.pending")}</p>
						<p className="mt-1 font-mono text-2xl tabular-nums">
							{pending.verificationCode}
						</p>
					</div>
				) : null}
				{error || status.lastError ? (
					<p className="mt-4 w-full text-destructive text-sm">
						{error ??
							describeBridgeError(
								status.lastError,
								t("errors.networkPermission"),
							)}
					</p>
				) : null}
			</div>
			{scannerOpen ? (
				<MobileQrScanner
					onClose={() => setScannerOpen(false)}
					onScan={handleScannedOffer}
				/>
			) : null}
			<Dialog
				open={linkOpen}
				onOpenChange={(open) => {
					if (!open) setLinkOpen(false);
				}}
			>
				<DialogContent className="max-w-md rounded-lg">
					<DialogHeader>
						<DialogTitle>{t("connect.paste")}</DialogTitle>
					</DialogHeader>
					<Textarea
						value={offerUrl}
						onChange={(event) => setOfferUrl(event.target.value)}
						placeholder={t("connect.placeholder")}
						className="min-h-28 resize-none font-mono text-base md:text-xs"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
					{error ? <p className="text-destructive text-sm">{error}</p> : null}
					<DialogFooter>
						<Button
							disabled={connecting || !offerUrl.trim()}
							onClick={() => void connect(offerUrl)}
						>
							{connecting ? (
								<LoaderCircle className="size-4 animate-spin" />
							) : (
								<Laptop className="size-4" />
							)}
							{connecting ? t("connect.connecting") : t("connect.action")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function MobileQrScanner({
	onClose,
	onScan,
}: {
	onClose: () => void;
	onScan: (value: string) => void;
}) {
	const { t } = useTranslation("mobile");
	const videoRef = useRef<HTMLVideoElement>(null);
	const controlsRef = useRef<IScannerControls | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		let active = true;
		const reader = new BrowserQRCodeReader();
		void reader
			.decodeFromConstraints(
				{ audio: false, video: { facingMode: { ideal: "environment" } } },
				video,
				(result, _error, controls) => {
					controlsRef.current = controls;
					if (!result || !active) return;
					controls.stop();
					onScan(result.getText());
				},
			)
			.then((controls) => {
				controlsRef.current = controls;
			})
			.catch(() => active && setFailed(true));
		return () => {
			active = false;
			controlsRef.current?.stop();
		};
	}, [onScan]);

	return (
		<div
			className="fixed inset-0 z-50 flex flex-col bg-background px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			role="dialog"
			aria-modal="true"
			aria-label={t("connect.camera")}
		>
			<div className="flex items-center justify-between">
				<p className="font-medium text-sm">{t("connect.camera")}</p>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("connect.cancel")}
					onClick={onClose}
				>
					<X className="size-4" />
				</Button>
			</div>
			<div className="relative my-auto aspect-square overflow-hidden border bg-black">
				<video
					ref={videoRef}
					className="size-full object-cover"
					muted
					playsInline
				/>
				<div className="pointer-events-none absolute inset-[15%] border-2 border-white/90" />
			</div>
			<p className="mt-5 text-center text-muted-foreground text-sm">
				{failed ? t("connect.cameraUnavailable") : t("connect.cameraHint")}
			</p>
		</div>
	);
}

export function LegacyMobileLibrary({
	papers,
	selected,
	onSelect,
}: {
	papers: PaperMetadata[];
	selected: PaperMetadata | null;
	onSelect: (paper: PaperMetadata) => void;
}) {
	const { t } = useTranslation("mobile");
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return papers;
		return papers.filter((paper) =>
			`${paper.title} ${paper.authors.join(" ")}`
				.toLowerCase()
				.includes(normalized),
		);
	}, [papers, query]);
	return (
		<section className="flex h-full min-h-0 flex-col">
			<div className="border-b px-4 py-3 md:px-6">
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("library.search")}
						className="pl-9"
					/>
				</div>
			</div>
			<div className="agentero-scroll flex-1">
				<ul className="divide-y">
					{filtered.map((paper) => (
						<li key={paper.path ?? paper.id}>
							<button
								type="button"
								onClick={() => onSelect(paper)}
								className={cn(
									"flex w-full items-center gap-3 px-4 py-4 text-left md:px-6",
									selected?.id === paper.id && "bg-muted/60",
								)}
							>
								<div className="grid size-10 shrink-0 place-items-center border bg-muted text-muted-foreground">
									<BookOpen className="size-4" />
								</div>
								<span className="min-w-0 flex-1">
									<span className="line-clamp-2 block font-medium text-sm">
										{paper.title}
									</span>
									<span className="mt-1 block truncate text-muted-foreground text-xs">
										{paper.authors.join(", ")}
										{paper.year ? ` · ${paper.year}` : ""}
									</span>
								</span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
							</button>
						</li>
					))}
				</ul>
				{filtered.length === 0 ? (
					<div className="grid h-full place-items-center text-muted-foreground text-sm">
						{t("library.empty")}
					</div>
				) : null}
			</div>
		</section>
	);
}

export function LegacyMobileReader({ paper }: { paper: PaperMetadata | null }) {
	const { t } = useTranslation("mobile");
	const [notes, setNotes] = useState("");
	const [saving, setSaving] = useState(false);
	const [mode, setMode] = useState<"pdf" | "notes">("pdf");
	const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
	const [pdfError, setPdfError] = useState<string | null>(null);
	useEffect(() => {
		setNotes("");
		setPdfBytes(null);
		setPdfError(null);
		if (!paper?.path) return;
		let active = true;
		void bridgeRpc<string>("vault_read_text", {
			path: `${paper.path}/NOTES.md`,
		})
			.then((content) => active && setNotes(content))
			.catch(() => undefined);
		void loadBridgePaperPdf(paper.path)
			.then((blob) => blob.arrayBuffer())
			.then((bytes) => active && setPdfBytes(bytes))
			.catch((error) => {
				if (!active) return;
				setPdfError(
					error instanceof Error ? error.message : t("reader.pdfUnavailable"),
				);
			});
		return () => {
			active = false;
		};
	}, [paper?.path, t]);
	if (!paper)
		return (
			<div className="grid h-full place-items-center text-muted-foreground text-sm">
				{t("reader.empty")}
			</div>
		);
	const save = async () => {
		if (!paper.path) return;
		setSaving(true);
		try {
			await bridgeRpc("vault_write_text", {
				path: `${paper.path}/NOTES.md`,
				content: notes,
			});
		} finally {
			setSaving(false);
		}
	};
	const pdf = (
		<LegacyMobilePdfPreview
			bytes={pdfBytes}
			error={pdfError}
			docId={`bridge:${paper.id}`}
			paperPath={paper.path ?? null}
			t={t}
		/>
	);
	const notesEditor = (
		<div className="relative flex h-full min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto pb-20">
				<Textarea
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
					className="min-h-full w-full resize-none overflow-y-auto rounded-none border-0 p-4 font-mono text-base shadow-none field-sizing-fixed focus-visible:ring-0 md:px-6 md:text-sm"
					placeholder=""
				/>
			</div>
			<footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end border-t bg-background/95 px-4 py-3 backdrop-blur md:px-6">
				<Button
					size="sm"
					className="pointer-events-auto"
					disabled={saving}
					onClick={() => void save()}
				>
					{saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
					{saving ? t("reader.saving") : t("reader.save")}
				</Button>
			</footer>
		</div>
	);
	return (
		<section className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-2 md:px-6">
				<div className="flex shrink-0 border bg-muted p-0.5 md:hidden">
					<button
						type="button"
						aria-label={t("reader.pdf")}
						aria-pressed={mode === "pdf"}
						onClick={() => setMode("pdf")}
						className={cn(
							"grid size-8 place-items-center",
							mode === "pdf" && "bg-background shadow-sm",
						)}
					>
						<BookOpen className="size-4" />
					</button>
					<button
						type="button"
						aria-label={t("reader.notes")}
						aria-pressed={mode === "notes"}
						onClick={() => setMode("notes")}
						className={cn(
							"grid size-8 place-items-center",
							mode === "notes" && "bg-background shadow-sm",
						)}
					>
						<FileText className="size-4" />
					</button>
				</div>
			</div>
			<div className="h-full min-h-0 flex-1 md:hidden">
				{mode === "pdf" ? pdf : notesEditor}
			</div>
			<div className="hidden min-h-0 flex-1 md:grid md:grid-cols-2 md:divide-x">
				{pdf}
				{notesEditor}
			</div>
		</section>
	);
}

export function LegacyMobilePdfPreview({
	bytes,
	error,
	docId,
	paperPath,
	t,
}: {
	bytes: ArrayBuffer | null;
	error: string | null;
	docId: string;
	paperPath: string | null;
	t: (key: "reader.loadingPdf" | "reader.pdfUnavailable") => string;
}) {
	if (error) {
		return (
			<div className="grid h-full place-items-center p-6 text-center text-muted-foreground text-sm">
				{error || t("reader.pdfUnavailable")}
			</div>
		);
	}
	if (!bytes) {
		return (
			<div className="grid h-full place-items-center gap-2 text-muted-foreground text-sm">
				<LoaderCircle className="size-5 animate-spin" />
				{t("reader.loadingPdf")}
			</div>
		);
	}
	return (
		<div className="h-full min-h-0">
			<Suspense
				fallback={
					<div className="grid h-full place-items-center">
						<LoaderCircle className="size-5 animate-spin text-muted-foreground" />
					</div>
				}
			>
				<MobilePdfViewer
					source={null}
					sourceBytes={bytes}
					docId={docId}
					paperRelPath={paperPath}
					className="h-full"
				/>
			</Suspense>
		</div>
	);
}

type AgentStreamEvent = {
	sessionId: string;
	chunk: string;
};

type AgentResultEvent = {
	sessionId: string;
	content: string;
};

type AgentPermissionOption = {
	optionId: string;
	name: string;
	kind: string;
};

type AgentPermissionRequest = {
	requestId: string;
	sessionId: string;
	title: string;
	paths: string[];
	options: AgentPermissionOption[];
};

type AgentLine = {
	id: string;
	role: "assistant" | "user";
	text: string;
	streaming?: boolean;
};

type AcpSessionInfo = {
	sessionId: string;
	title?: string;
	updatedAt?: string;
};

type AcpListSessionsResult = {
	sessions: AcpSessionInfo[];
	supported: boolean;
};

type AcpHistoryLine = {
	id: string;
	kind: string;
	text: string;
};

type AcpLoadSessionResult = {
	sessionId: string;
	title?: string;
	lines: AcpHistoryLine[];
};

function MobileAgent({
	selectedAgentId,
	sessionId,
	onSessionId,
}: {
	selectedAgentId: string | null;
	sessionId: string | null;
	onSessionId: (sessionId: string | null) => void;
}) {
	const { t } = useTranslation("mobile");
	const [lines, setLines] = useState<AgentLine[]>([]);
	const [sending, setSending] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [permission, setPermission] = useState<AgentPermissionRequest | null>(
		null,
	);
	const sessionRef = useRef<string | null>(sessionId);
	const pendingPermissionRef = useRef<AgentPermissionRequest | null>(null);
	pendingPermissionRef.current = permission;

	const restore = useCallback(
		async (target: string) => {
			setRestoring(true);
			try {
				const history = await bridgeRpc<AcpLoadSessionResult>(
					"agent_load_session",
					{
						agentId: selectedAgentId ?? undefined,
						sessionId: target,
					},
				);
				sessionRef.current = history.sessionId;
				onSessionId(history.sessionId);
				setLines(
					history.lines.map((line) => ({
						id: line.id,
						role: line.kind === "user" ? "user" : "assistant",
						text: line.text,
					})),
				);
			} catch {
				// Session history is best-effort; keep the current timeline.
			} finally {
				setRestoring(false);
			}
		},
		[onSessionId, selectedAgentId],
	);

	useEffect(() => {
		if (sessionRef.current) void restore(sessionRef.current);
	}, [restore]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			if (sessionRef.current) void restore(sessionRef.current);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [restore]);

	useEffect(() => {
		const onHistory = () => setHistoryOpen(true);
		window.addEventListener("mobile:agent-history", onHistory);
		return () => window.removeEventListener("mobile:agent-history", onHistory);
	}, []);

	useEffect(() => {
		let active = true;
		const unlisten: Array<() => void> = [];
		void listenBridgeEvent<AgentStreamEvent>("agent:stream", (event) => {
			if (!active || event.sessionId !== sessionRef.current) return;
			setLines((current) => {
				const last = current.at(-1);
				if (last?.role === "assistant" && last.streaming) {
					return [
						...current.slice(0, -1),
						{ ...last, text: `${last.text}${event.chunk}` },
					];
				}
				return [
					...current,
					{
						id: nanoid(),
						role: "assistant",
						text: event.chunk,
						streaming: true,
					},
				];
			});
		}).then((off) => unlisten.push(off));
		void listenBridgeEvent<AgentResultEvent>("agent:completed", (event) => {
			if (!active || event.sessionId !== sessionRef.current) return;
			setSending(false);
			setLines((current) => {
				const last = current.at(-1);
				if (last?.role === "assistant" && last.streaming) {
					return [...current.slice(0, -1), { ...last, streaming: false }];
				}
				return event.content
					? [
							...current,
							{ id: nanoid(), role: "assistant", text: event.content },
						]
					: current;
			});
		}).then((off) => unlisten.push(off));
		void listenBridgeEvent<{ sessionId: string; error?: string }>(
			"agent:failed",
			(event) => {
				if (!active || event.sessionId !== sessionRef.current) return;
				setSending(false);
				setLines((current) => [
					...current,
					{
						id: nanoid(),
						role: "assistant",
						text: event.error ?? t("agent.failed"),
					},
				]);
			},
		).then((off) => unlisten.push(off));
		void listenBridgeEvent<AgentPermissionRequest>(
			"agent:permission-request",
			(event) => {
				if (!active || event.sessionId !== sessionRef.current) return;
				setPermission(event);
			},
		).then((off) => unlisten.push(off));
		return () => {
			active = false;
			for (const off of unlisten) off();
			const pending = pendingPermissionRef.current;
			if (pending) {
				void bridgeRpc("agent_respond_permission", {
					requestId: pending.requestId,
					optionId: null,
				});
			}
		};
	}, [t]);

	const respondToPermission = (optionId: string | null) => {
		const pending = permission;
		if (!pending) return;
		setPermission(null);
		void bridgeRpc("agent_respond_permission", {
			requestId: pending.requestId,
			optionId,
		});
	};

	const send = async (value: string) => {
		const next = value.trim();
		if (!next || sending) return;
		setLines((previous) => [
			...previous,
			{ id: nanoid(), role: "user", text: next },
		]);
		setSending(true);
		try {
			const accepted = await bridgeRpc<{ sessionId: string }>(
				"agent_run_once",
				{
					agentId: selectedAgentId ?? undefined,
					prompt: next,
					permissionMode: "ask",
				},
			);
			sessionRef.current = accepted.sessionId;
			onSessionId(accepted.sessionId);
		} catch (error) {
			setSending(false);
			setLines((current) => [
				...current,
				{
					id: nanoid(),
					role: "assistant",
					text: error instanceof Error ? error.message : t("agent.failed"),
				},
			]);
		}
	};

	return (
		<>
			<section className="flex h-full min-h-0 flex-col">
				<Conversation className="min-h-0 flex-1">
					<ConversationContent className="gap-5 px-4 py-5 md:px-6">
						{restoring ? (
							<p className="mb-3 flex items-center gap-2 text-muted-foreground text-sm">
								<LoaderCircle className="size-4 animate-spin" />
								{t("agent.restoring")}
							</p>
						) : null}
						{lines.length === 0 && !restoring ? (
							<ConversationEmptyState
								className="min-h-0 flex-1 p-4 text-base"
								title={t("agent.empty")}
							/>
						) : (
							lines.map((line) => (
								<Message
									key={line.id}
									from={line.role}
									className={
										line.role === "assistant" ? "max-w-full" : undefined
									}
								>
									<MessageContent
										className={cn(
											"text-[15px] leading-6",
											line.role === "user" && "rounded-lg bg-muted px-3 py-2.5",
											line.role === "assistant" && "w-full max-w-full",
										)}
									>
										{line.role === "assistant" &&
										!line.text.trim() &&
										line.streaming ? (
											<Shimmer className="text-sm">
												{t("agent.thinking")}
											</Shimmer>
										) : (
											<MessageResponse isAnimating={line.streaming}>
												{line.text}
											</MessageResponse>
										)}
									</MessageContent>
								</Message>
							))
						)}
					</ConversationContent>
					<ConversationScrollButton className="bottom-3 size-8 shadow-md" />
				</Conversation>
				<PromptInput
					className="shrink-0 rounded-none border-0 border-t bg-muted/10 p-3.5 shadow-none md:px-6"
					inputGroupClassName="overflow-visible"
					onSubmit={({ text: value }) => void send(value)}
				>
					<PromptInputBody>
						<div className="flex w-full items-center gap-1 rounded-xl border bg-background px-1.5 py-0.5">
							<PromptInputTextarea
								placeholder={t("agent.placeholder")}
								disabled={sending}
								rows={1}
								className="min-h-10 max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-base shadow-none focus-visible:ring-0 md:text-[15px]"
							/>
							<PromptInputSubmit
								status={sending ? "submitted" : "ready"}
								disabled={sending}
								className="shrink-0"
							/>
						</div>
					</PromptInputBody>
				</PromptInput>
			</section>
			<MobilePermissionDialog
				permission={permission}
				onRespond={respondToPermission}
			/>
			<MobileAgentHistoryDialog
				open={historyOpen}
				agentId={selectedAgentId}
				onClose={() => setHistoryOpen(false)}
				onPick={(target) => {
					setHistoryOpen(false);
					void restore(target);
				}}
			/>
		</>
	);
}

function MobileAgentHistoryDialog({
	open,
	agentId,
	onClose,
	onPick,
}: {
	open: boolean;
	agentId: string | null;
	onClose: () => void;
	onPick: (sessionId: string) => void;
}) {
	const { t } = useTranslation("mobile");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<AcpListSessionsResult | null>(null);
	useEffect(() => {
		if (!open) return;
		let active = true;
		setLoading(true);
		setResult(null);
		void bridgeRpc<AcpListSessionsResult>("agent_list_sessions", {
			agentId: agentId ?? undefined,
		})
			.then((next) => active && setResult(next))
			.catch(() => active && setResult({ sessions: [], supported: false }))
			.finally(() => active && setLoading(false));
		return () => {
			active = false;
		};
	}, [agentId, open]);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-w-md rounded-lg">
				<DialogHeader>
					<DialogTitle>{t("agent.history")}</DialogTitle>
				</DialogHeader>
				{loading ? (
					<div className="grid place-items-center py-6">
						<LoaderCircle className="size-5 animate-spin text-muted-foreground" />
					</div>
				) : result && !result.supported ? (
					<p className="py-2 text-muted-foreground text-sm">
						{t("agent.historyUnsupported")}
					</p>
				) : result && result.sessions.length === 0 ? (
					<p className="py-2 text-muted-foreground text-sm">
						{t("agent.historyEmpty")}
					</p>
				) : (
					<ul className="agentero-scroll max-h-80 divide-y">
						{result?.sessions.map((session) => (
							<li key={session.sessionId}>
								<button
									type="button"
									className="flex w-full flex-col gap-0.5 px-1 py-3 text-left"
									onClick={() => onPick(session.sessionId)}
								>
									<span className="line-clamp-2 text-sm">
										{displayHistoryTitle(
											session.title ?? "",
											session.sessionId.slice(0, 8),
										)}
									</span>
									{session.updatedAt ? (
										<span className="text-muted-foreground text-xs">
											{session.updatedAt}
										</span>
									) : null}
								</button>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

function MobilePermissionDialog({
	permission,
	onRespond,
}: {
	permission: AgentPermissionRequest | null;
	onRespond: (optionId: string | null) => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<Dialog
			open={permission !== null}
			onOpenChange={(open) => {
				if (!open) onRespond(null);
			}}
		>
			<DialogContent showCloseButton={false} className="max-w-md rounded-lg">
				{permission ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("permission.title")}</DialogTitle>
							<DialogDescription>{permission.title}</DialogDescription>
						</DialogHeader>
						{permission.paths.length ? (
							<div className="space-y-1">
								{permission.paths.map((path) => (
									<code
										key={path}
										className="block truncate bg-muted px-2 py-1 text-xs"
										title={path}
									>
										{path}
									</code>
								))}
							</div>
						) : null}
						<DialogFooter className="sm:flex-col">
							{permission.options.map((option) => (
								<Button
									key={option.optionId}
									variant={
										option.kind.startsWith("allow") ? "default" : "outline"
									}
									onClick={() => onRespond(option.optionId)}
								>
									{option.name || option.kind}
								</Button>
							))}
							<Button variant="ghost" onClick={() => onRespond(null)}>
								{t("permission.deny")}
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
