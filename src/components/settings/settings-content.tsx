import {
	Bot,
	CloudUpload,
	Compass,
	FlaskConical,
	Info,
	Keyboard,
	Languages,
	LayoutTemplate,
	MonitorSmartphone,
	Paintbrush,
	SlidersHorizontal,
	Stethoscope,
	Wand2,
	X,
} from "lucide-react";
import {
	Fragment,
	lazy,
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
	SettingsHostContext,
	SettingsSection,
} from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { scrollBehavior } from "@/lib/core/motion";
import { cn } from "@/lib/core/utils";
import {
	broadcastOnboardingRequest,
	broadcastTourRequest,
} from "@/lib/onboarding/api";
import type { AppSettings } from "@/lib/settings";
import { closeSettingsWindow } from "@/lib/shell/settings-window";
import {
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	remoteSessionIdFromHandle,
} from "@/lib/vault/remote/remote-vault";

// Panes load per section instead of riding along with the settings shell:
// importing them statically pulled the whole surface (agent pane + model picker
// + translate) into the first paint. The *current* section is preloaded next to
// the shell (see `preloadSettingsPane`), so only the sections you actually visit
// pay for a chunk — a lazy default pane would just move the stall after render.
const PANE_LOADERS = {
	general: () => import("@/components/settings/panes/general-pane"),
	appearance: () => import("@/components/settings/panes/appearance-pane"),
	agent: () => import("@/components/settings/panes/agent-pane"),
	translate: () => import("@/components/settings/panes/translate-pane"),
	layout: () => import("@/components/settings/panes/layout-pane"),
	experimental: () => import("@/components/settings/panes/experimental-pane"),
	doctor: () => import("@/components/settings/panes/doctor-pane"),
	keyboard: () => import("@/components/settings/panes/keyboard-pane"),
	"remote-access": () =>
		import("@/components/settings/panes/remote-access-pane"),
	sync: () => import("@/components/settings/panes/sync-pane"),
	about: () => import("@/components/settings/panes/about-pane"),
} satisfies Record<SettingsSection, () => Promise<unknown>>;

/**
 * Warm the chunk for `section` before the shell renders. Module promises are
 * cached, so the matching `lazy()` below resolves without a second request.
 */
export function preloadSettingsPane(section: string): Promise<unknown> {
	const load = PANE_LOADERS[section as SettingsSection] ?? PANE_LOADERS.general;
	return load();
}

// memo(): visited panes stay mounted across section switches; without this
// every switch re-rendered ALL mounted panes (agent pane is ~1.5k lines).
const GeneralPane = memo(
	lazy(() => PANE_LOADERS.general().then((m) => ({ default: m.GeneralPane }))),
);
const AppearancePane = memo(
	lazy(() =>
		PANE_LOADERS.appearance().then((m) => ({ default: m.AppearancePane })),
	),
);
const AgentPane = memo(
	lazy(() => PANE_LOADERS.agent().then((m) => ({ default: m.AgentPane }))),
);
const RemoteAgentPane = memo(
	lazy(() =>
		PANE_LOADERS.agent().then((m) => ({ default: m.RemoteAgentPane })),
	),
);
const TranslatePane = memo(
	lazy(() =>
		PANE_LOADERS.translate().then((m) => ({ default: m.TranslatePane })),
	),
);
const LayoutPane = memo(
	lazy(() => PANE_LOADERS.layout().then((m) => ({ default: m.LayoutPane }))),
);
const ExperimentalPane = memo(
	lazy(() =>
		PANE_LOADERS.experimental().then((m) => ({
			default: m.ExperimentalPane,
		})),
	),
);
const DoctorPane = memo(
	lazy(() => PANE_LOADERS.doctor().then((m) => ({ default: m.DoctorPane }))),
);
const KeyboardPane = memo(
	lazy(() =>
		PANE_LOADERS.keyboard().then((m) => ({ default: m.KeyboardPane })),
	),
);
const RemoteAccessPane = memo(
	lazy(() =>
		PANE_LOADERS["remote-access"]().then((m) => ({
			default: m.RemoteAccessPane,
		})),
	),
);
const SyncPane = memo(
	lazy(() => PANE_LOADERS.sync().then((m) => ({ default: m.SyncPane }))),
);
const AboutPane = memo(
	lazy(() => PANE_LOADERS.about().then((m) => ({ default: m.AboutPane }))),
);

const NAV: {
	id: SettingsSection;
	icon: typeof Bot;
	dividerBefore?: boolean;
}[] = [
	{ id: "general", icon: SlidersHorizontal },
	{ id: "appearance", icon: Paintbrush },
	{ id: "agent", icon: Bot, dividerBefore: true },
	{ id: "translate", icon: Languages },
	{ id: "layout", icon: LayoutTemplate },
	{ id: "remote-access", icon: MonitorSmartphone },
	{ id: "sync", icon: CloudUpload },
	{ id: "experimental", icon: FlaskConical },
	{ id: "doctor", icon: Stethoscope, dividerBefore: true },
	{ id: "keyboard", icon: Keyboard },
	{ id: "about", icon: Info },
];

/** Reserves height while a pane chunk loads so the window does not jump. */
function PaneFallback() {
	return <div className="h-64" aria-hidden />;
}

type SettingsContentProps = {
	section: SettingsSection;
	onSectionChange: (section: SettingsSection) => void;
	settings: AppSettings;
	onChange: (next: AppSettings) => void;
	/** Renders a close (X) button when provided (modal mode). */
	onClose?: () => void;
	/** aria-labelledby id supplied by a dialog wrapper. */
	titleId?: string;
	/** Active vault path — remote handles switch Agent settings to the SSH host. */
	vaultPath?: string | null;
};

/** Settings navigation + panes; used by the native settings window and the modal fallback. */
export function SettingsContent({
	section,
	onSectionChange,
	settings,
	onChange,
	onClose,
	titleId,
	vaultPath = null,
}: SettingsContentProps) {
	const { t } = useTranslation(["settings", "common"]);
	const fallbackTitleId = useId();
	const headingId = titleId ?? fallbackTitleId;

	// Keep visited panes mounted (hidden when inactive) so switching sections
	// doesn't unmount/remount them — avoids re-running their load effects
	// (agent list, connector status, cache stats, dynamic imports) and makes
	// section switches instant instead of re-fetching on every visit.
	const [visitedSections, setVisitedSections] = useState<SettingsSection[]>([
		section,
	]);
	useEffect(() => {
		setVisitedSections((prev) =>
			prev.includes(section) ? prev : [...prev, section],
		);
	}, [section]);

	// Warm every pane chunk in the background shortly after the window opens.
	// Only the initial section is preloaded at boot; without this, the FIRST
	// click on any other section pays for its chunk fetch + evaluation right
	// on the click (seconds on a busy machine / dev server) — perceived as the
	// settings UI "freezing". Sequential + staggered so the warm-up never
	// contends with the main window.
	useEffect(() => {
		let cancelled = false;
		const sections = Object.keys(PANE_LOADERS) as SettingsSection[];
		let i = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const warmNext = () => {
			if (cancelled || i >= sections.length) return;
			const load = PANE_LOADERS[sections[i++]];
			void load().finally(() => {
				if (!cancelled) timer = setTimeout(warmNext, 120);
			});
		};
		timer = setTimeout(warmNext, 300);
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, []);
	const contentScrollRef = useRef<HTMLDivElement>(null);
	const navListRef = useRef<HTMLUListElement>(null);
	const navItemRefs = useRef<
		Partial<Record<SettingsSection, HTMLButtonElement>>
	>({});
	const [navIndicator, setNavIndicator] = useState<{
		top: number;
		height: number;
	} | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: section intentionally triggers a scroll-to-top on switch
	useEffect(() => {
		contentScrollRef.current?.scrollTo({ top: 0, behavior: scrollBehavior() });
	}, [section]);

	// Slide the sidebar highlight to the active item (motion-17).
	const measureNavIndicator = useCallback(() => {
		const list = navListRef.current;
		const btn = navItemRefs.current[section];
		if (!list || !btn) return;
		const listRect = list.getBoundingClientRect();
		const btnRect = btn.getBoundingClientRect();
		setNavIndicator({
			top: btnRect.top - listRect.top + list.scrollTop,
			height: btnRect.height,
		});
	}, [section]);

	useEffect(() => {
		measureNavIndicator();
		const list = navListRef.current;
		if (!list) return;
		const onScroll = () => measureNavIndicator();
		list.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", measureNavIndicator);
		return () => {
			list.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", measureNavIndicator);
		};
	}, [measureNavIndicator]);

	const hostContext = useMemo((): SettingsHostContext => {
		if (vaultPath && isRemoteVaultHandle(vaultPath)) {
			const sessionId = remoteSessionIdFromHandle(vaultPath);
			const meta = getRemoteSessionMeta();
			if (sessionId && meta && meta.sessionId === sessionId) {
				const label =
					meta.host.trim() ||
					meta.displayName.split(":")[0]?.trim() ||
					t("host.remote");
				return {
					kind: "remote",
					label,
					sessionId,
					host: meta.host,
					remotePath: meta.remotePath,
				};
			}
			if (sessionId) {
				return {
					kind: "remote",
					label: t("host.remote"),
					sessionId,
					host: "",
					remotePath: "",
				};
			}
		}
		return { kind: "local" };
	}, [vaultPath, t]);

	const patch = useCallback(
		(partial: Partial<AppSettings>) => onChange({ ...settings, ...partial }),
		[onChange, settings],
	);

	const selectSection = useCallback(
		(id: SettingsSection) => {
			onSectionChange(id);
		},
		[onSectionChange],
	);

	const onNavItemKeyDown = useCallback(
		(
			event: ReactKeyboardEvent<HTMLButtonElement>,
			current: SettingsSection,
		) => {
			const ids = NAV.map((item) => item.id);
			const index = ids.indexOf(current);
			if (index < 0) return;
			let next = index;
			if (event.key === "ArrowDown" || event.key === "ArrowRight") {
				next = Math.min(ids.length - 1, index + 1);
			} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
				next = Math.max(0, index - 1);
			} else if (event.key === "Home") {
				next = 0;
			} else if (event.key === "End") {
				next = ids.length - 1;
			} else {
				return;
			}
			if (next === index) return;
			event.preventDefault();
			const id = ids[next];
			selectSection(id);
			navItemRefs.current[id]?.focus();
		},
		[selectSection],
	);

	return (
		<>
			{/* Sidebar — macOS System Settings weight (heavier material). */}
			<nav
				data-settings-sidebar
				className="flex w-[11.5rem] shrink-0 select-none flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
				aria-label={t("title")}
			>
				{/* Modal fallback only: native window already shows the title in its title bar. */}
				{onClose ? (
					<div className="flex items-center justify-between gap-1 px-3 pt-3 pb-2">
						<span id={headingId} className="font-semibold text-sm leading-none">
							{t("title")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="shrink-0"
							aria-label={t("common:close")}
							onClick={onClose}
						>
							<X className="size-3.5" />
						</Button>
					</div>
				) : null}
				<ul
					ref={navListRef}
					className={cn(
						"agentero-scroll relative flex min-h-0 flex-1 flex-col gap-0.5 overscroll-y-contain px-2 pb-2",
						!onClose && "pt-3",
					)}
				>
					{navIndicator ? (
						<span
							aria-hidden
							className="pointer-events-none absolute inset-x-2 top-0 z-0 rounded-md bg-sidebar-primary shadow-sm transition-[transform,height] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-out)] motion-reduce:transition-none will-change-transform"
							style={{
								height: navIndicator.height,
								transform: `translate3d(0, ${navIndicator.top}px, 0)`,
							}}
						/>
					) : null}
					{NAV.map((item) => {
						const Icon = item.icon;
						const active = section === item.id;
						return (
							<Fragment key={item.id}>
								{item.dividerBefore ? (
									<li
										aria-hidden
										className="relative z-10 mx-1 my-1.5 border-t border-sidebar-border/80"
									/>
								) : null}
								<li className="relative z-10">
									<button
										id={`settings-nav-${item.id}`}
										ref={(el) => {
											if (el) navItemRefs.current[item.id] = el;
											else delete navItemRefs.current[item.id];
										}}
										type="button"
										aria-current={active ? "page" : undefined}
										className={cn(
											"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
											"transition-[color,background-color,transform,opacity] duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)]",
											"focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
											"active:scale-[0.98]",
											active
												? "font-medium text-sidebar-primary-foreground"
												: "text-sidebar-foreground/90 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
										)}
										onClick={() => selectSection(item.id)}
										onKeyDown={(event) => onNavItemKeyDown(event, item.id)}
									>
										<Icon
											className={cn(
												"size-3.5 shrink-0",
												active ? "opacity-100" : "opacity-75",
											)}
											aria-hidden
										/>
										<span className="truncate">{t(`nav.${item.id}`)}</span>
									</button>
								</li>
							</Fragment>
						);
					})}
				</ul>

				{/* Sidebar footer: replay the first-run wizard / feature tour. */}
				<div className="flex flex-col gap-1.5 border-t border-sidebar-border px-2 py-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full border-sidebar-border bg-sidebar/40 hover:bg-sidebar-accent"
						onClick={() => {
							broadcastOnboardingRequest();
							closeSettingsWindow();
						}}
					>
						<Wand2 data-icon="inline-start" />
						{t("nav.quickSetup")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full border-sidebar-border bg-sidebar/40 hover:bg-sidebar-accent"
						onClick={() => {
							broadcastTourRequest();
							closeSettingsWindow();
						}}
					>
						<Compass data-icon="inline-start" />
						{t("nav.featureTour")}
					</Button>
				</div>
			</nav>

			{/* Content */}
			<div
				ref={contentScrollRef}
				data-settings-content
				className="agentero-scroll min-w-0 flex-1 overscroll-y-contain bg-background"
			>
				<div className="px-6 py-5">
					{/* One boundary per pane: a section still loading must not blank out
					    the panes already visited and kept mounted next to it. */}
					{visitedSections.includes("general") && (
						<div
							data-settings-pane
							data-active={section === "general" ? "true" : "false"}
							hidden={section !== "general"}
						>
							<Suspense fallback={<PaneFallback />}>
								<GeneralPane
									settings={settings}
									patch={patch}
									hostContext={hostContext}
									vaultPath={vaultPath}
								/>
							</Suspense>
						</div>
					)}
					{visitedSections.includes("appearance") && (
						<div
							data-settings-pane
							data-active={section === "appearance" ? "true" : "false"}
							hidden={section !== "appearance"}
						>
							<Suspense fallback={<PaneFallback />}>
								<AppearancePane
									theme={settings.theme}
									uiTheme={settings.uiTheme}
									locale={settings.locale}
									uiScale={settings.uiScale}
									editorFontSize={settings.editorFontSize}
									interfaceFontFamily={settings.interfaceFontFamily}
									textFontFamily={settings.textFontFamily}
									monoFontFamily={settings.monoFontFamily}
									editorLineHeight={settings.editorLineHeight}
									showEditorToolbar={settings.showEditorToolbar}
									patch={patch}
								/>
							</Suspense>
						</div>
					)}
					{visitedSections.includes("agent") && (
						<div
							data-settings-pane
							data-active={section === "agent" ? "true" : "false"}
							hidden={section !== "agent"}
						>
							<Suspense fallback={<PaneFallback />}>
								{hostContext.kind === "remote" ? (
									<RemoteAgentPane
										settings={settings}
										patch={patch}
										hostContext={hostContext}
									/>
								) : (
									<AgentPane settings={settings} patch={patch} />
								)}
							</Suspense>
						</div>
					)}
					{visitedSections.includes("translate") && (
						<div
							data-settings-pane
							data-active={section === "translate" ? "true" : "false"}
							hidden={section !== "translate"}
						>
							<Suspense fallback={<PaneFallback />}>
								<TranslatePane
									settings={settings}
									patch={patch}
									onOpenAgentSettings={() => onSectionChange("agent")}
								/>
							</Suspense>
						</div>
					)}
					{visitedSections.includes("layout") && (
						<div
							data-settings-pane
							data-active={section === "layout" ? "true" : "false"}
							hidden={section !== "layout"}
						>
							<Suspense fallback={<PaneFallback />}>
								<LayoutPane
									settings={settings}
									patch={patch}
									vaultPath={vaultPath}
									hostContext={hostContext}
								/>
							</Suspense>
						</div>
					)}
					{visitedSections.includes("doctor") && (
						<div
							data-settings-pane
							data-active={section === "doctor" ? "true" : "false"}
							hidden={section !== "doctor"}
						>
							<Suspense fallback={<PaneFallback />}>
								<DoctorPane vaultPath={vaultPath} hostContext={hostContext} />
							</Suspense>
						</div>
					)}
					{visitedSections.includes("keyboard") && (
						<div
							data-settings-pane
							data-active={section === "keyboard" ? "true" : "false"}
							hidden={section !== "keyboard"}
						>
							<Suspense fallback={<PaneFallback />}>
								<KeyboardPane />
							</Suspense>
						</div>
					)}
					{visitedSections.includes("remote-access") && (
						<div
							data-settings-pane
							data-active={section === "remote-access" ? "true" : "false"}
							hidden={section !== "remote-access"}
						>
							<Suspense fallback={<PaneFallback />}>
								<RemoteAccessPane vaultPath={vaultPath} />
							</Suspense>
						</div>
					)}
					{visitedSections.includes("sync") && (
						<div
							data-settings-pane
							data-active={section === "sync" ? "true" : "false"}
							hidden={section !== "sync"}
						>
							<Suspense fallback={<PaneFallback />}>
								<SyncPane vaultPath={vaultPath} />
							</Suspense>
						</div>
					)}
					{visitedSections.includes("experimental") && (
						<div
							data-settings-pane
							data-active={section === "experimental" ? "true" : "false"}
							hidden={section !== "experimental"}
						>
							<Suspense fallback={<PaneFallback />}>
								<ExperimentalPane settings={settings} patch={patch} />
							</Suspense>
						</div>
					)}
					{visitedSections.includes("about") && (
						<div
							data-settings-pane
							data-active={section === "about" ? "true" : "false"}
							hidden={section !== "about"}
						>
							<Suspense fallback={<PaneFallback />}>
								<AboutPane />
							</Suspense>
						</div>
					)}
				</div>
			</div>
		</>
	);
}
