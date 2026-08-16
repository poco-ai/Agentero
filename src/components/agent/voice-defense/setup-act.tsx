import {
	AlertTriangle,
	BookOpenText,
	Check,
	ChevronDown,
	ClipboardList,
	FileText,
	Folder,
	Loader2,
	LogIn,
	LogOut,
	MessageCircleQuestion,
	Mic,
	Minus,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ThoughtBackdrop } from "@/components/agent/voice-defense/thought-backdrop";
import { MessageResponse } from "@/components/ai-elements/message";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { AnimatedCircularProgressBar } from "@/components/ui/animated-circular-progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type {
	DefensePreparationManifest,
	VoiceAuthStatus,
	VoiceDifficulty,
	VoiceScenario,
} from "@/lib/voice-defense";
import {
	clampPlannedDurationMinutes,
	PLANNED_DURATION_CHOICES,
} from "@/lib/voice-defense/preferences";
import {
	VOICE_DIFFICULTIES,
	VOICE_SCENARIOS,
} from "@/lib/voice-defense/protocol";
import type { VoiceDefenseHistoryEntry } from "@/lib/voice-defense/review";

type MaterialItem = { path: string; kind: "file" | "directory"; title: string };

type PreparationNodeStatus =
	DefensePreparationManifest["nodes"]["paper-analysis"]["status"];

/** The three committee members and the preparation node each one embodies. */
const COMMITTEE_DEFS = [
	{ node: "paper-analysis", key: "analysis", icon: BookOpenText },
	{ node: "adversarial-review", key: "review", icon: MessageCircleQuestion },
	{ node: "synthesis", key: "synthesis", icon: ClipboardList },
] as const;

const stageFade = {
	initial: { opacity: 0, y: 8 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -8 },
	transition: { duration: 0.25, ease: "easeOut" as const },
};

type CommitteeSeatStatus = "pending" | "running" | "done" | "failed";

function mapSeatStatus(
	status: PreparationNodeStatus,
	active: boolean,
): CommitteeSeatStatus {
	if (status === "succeeded" || status === "skipped") return "done";
	if (status === "failed" || status === "cancelled") return "failed";
	if (status === "running" && active) return "running";
	return "pending";
}

/**
 * The committee rail — three members light up as they finish their part of
 * the preparation. It replaces the generic stepper + progress bar + badge
 * stack with one thematic visual.
 */
function CommitteeRail({
	manifest,
	active,
}: {
	manifest: DefensePreparationManifest | null;
	active: boolean;
}) {
	const { t } = useTranslation("agent");
	const containerRef = useRef<HTMLDivElement>(null);
	const seatRef0 = useRef<HTMLDivElement>(null);
	const seatRef1 = useRef<HTMLDivElement>(null);
	const seatRef2 = useRef<HTMLDivElement>(null);
	const seatRefs = [seatRef0, seatRef1, seatRef2];
	const seats = COMMITTEE_DEFS.map(({ node, key, icon }) => ({
		key,
		icon,
		status: mapSeatStatus(manifest?.nodes[node].status ?? "pending", active),
		label: t(`voiceDefense.committee.${key}`),
	}));
	return (
		<div
			ref={containerRef}
			className="relative flex items-start justify-center gap-6 sm:gap-10"
		>
			{seats.map((seat, index) => {
				const SeatIcon = seat.icon;
				return (
					<div
						key={seat.key}
						className="flex w-24 flex-col items-center gap-2.5"
					>
						{/* Solid backing keeps the beam line from showing through. */}
						<div
							ref={seatRefs[index]}
							className="relative z-10 size-12 rounded-full bg-background"
						>
							<div
								className={cn(
									"relative flex size-full items-center justify-center rounded-full border transition-colors duration-500",
									seat.status === "pending" &&
										"border-border bg-muted/30 text-muted-foreground/50",
									seat.status === "running" &&
										"border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-300",
									seat.status === "done" &&
										"border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
									seat.status === "failed" &&
										"border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-300",
								)}
							>
								{seat.status === "running" ? (
									<span
										className="absolute -inset-1.5 animate-pulse rounded-full border border-sky-500/30"
										aria-hidden
									/>
								) : null}
								<SeatIcon className="size-5" aria-hidden />
								{seat.status === "done" ? (
									<span
										className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white"
										aria-hidden
									>
										<Check className="size-3" />
									</span>
								) : seat.status === "failed" ? (
									<span
										className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-white"
										aria-hidden
									>
										<AlertTriangle className="size-2.5" />
									</span>
								) : null}
							</div>
						</div>
						<p
							className={cn(
								"text-center text-xs leading-snug transition-colors duration-500",
								seat.status === "running"
									? "text-sky-600 dark:text-sky-300"
									: seat.status === "done"
										? "text-muted-foreground"
										: seat.status === "failed"
											? "text-red-600 dark:text-red-300"
											: "text-muted-foreground/50",
							)}
						>
							{seat.label}
						</p>
					</div>
				);
			})}
			{/* Beams between adjacent members: the travelling light only runs
			    into the member currently at work — untouched segments stay as
			    calm static hairlines. */}
			{([0, 1] as const).map((index) => {
				const source = seats[index];
				const target = seats[index + 1];
				const settled =
					source.status === "done" &&
					(target.status === "done" || target.status === "failed");
				return (
					<AnimatedBeam
						key={`${source.key}-${target.key}`}
						containerRef={containerRef}
						fromRef={seatRefs[index]}
						toRef={seatRefs[index + 1]}
						animated={target.status === "running"}
						pathColor={settled ? "#10b981" : "var(--border)"}
						pathOpacity={settled ? 0.45 : 0.9}
						pathWidth={1.5}
						gradientStartColor="#38bdf8"
						gradientStopColor="#0ea5e9"
						duration={3}
					/>
				);
			})}
		</div>
	);
}

/** Account status lives in a quiet corner chip, never in the main flow. */
function AccountChip({
	authStatus,
	authBusy,
	disabled,
	onConnect,
	onCancel,
	onDisconnect,
}: {
	authStatus: VoiceAuthStatus | null;
	authBusy: boolean;
	disabled: boolean;
	onConnect: () => void;
	onCancel: () => void;
	onDisconnect: () => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="gap-2 rounded-full text-muted-foreground"
					disabled={disabled}
				>
					{authBusy || authStatus?.connecting ? (
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
					) : (
						<span
							className={cn(
								"size-2 rounded-full",
								authStatus?.connected
									? "bg-emerald-500"
									: "bg-muted-foreground/40",
							)}
							aria-hidden
						/>
					)}
					{t(
						authStatus?.connected
							? "voiceDefense.auth.connected"
							: authStatus?.connecting
								? "voiceDefense.auth.connecting"
								: "voiceDefense.auth.notConnected",
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{authStatus?.connected ? (
					<DropdownMenuItem onSelect={onDisconnect}>
						<LogOut aria-hidden />
						{t("voiceDefense.auth.disconnect")}
					</DropdownMenuItem>
				) : authStatus?.connecting ? (
					<DropdownMenuItem onSelect={onCancel}>
						<X aria-hidden />
						{t("voiceDefense.auth.cancel")}
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem disabled={authStatus === null} onSelect={onConnect}>
						<LogIn aria-hidden />
						{t("voiceDefense.auth.connect")}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function SetupAct({
	title,
	authStatus,
	authBusy,
	onConnectAccount,
	onCancelAccountConnection,
	onDisconnectAccount,
	materials,
	materialOptions,
	currentMaterialPath,
	selectedMaterialPaths,
	materialSearch,
	onMaterialSearchChange,
	onToggleMaterial,
	inputsLocked,
	instruction,
	onInstructionChange,
	plannedMinutes,
	onPlannedMinutesChange,
	scenario,
	onScenarioChange,
	defenseLanguage,
	onDefenseLanguageChange,
	difficulty,
	onDifficultyChange,
	reusable,
	onUseReusable,
	history,
	onOpenHistory,
	preparation,
	preparationActive,
	preparationLoading,
	preparationStatusLabel,
	preparationReady,
	preparationFailed,
	preparationStale,
	selectionChanged,
	voiceStarting,
	startError,
	brief,
	onBriefChange,
	briefSource,
	onPrepare,
	onRetry,
	onCancelPreparation,
	onStart,
}: {
	title: string;
	authStatus: VoiceAuthStatus | null;
	authBusy: boolean;
	onConnectAccount: () => void;
	onCancelAccountConnection: () => void;
	onDisconnectAccount: () => void;
	materials: MaterialItem[];
	materialOptions: Array<{
		path: string;
		kind: "file" | "directory";
		label: string;
	}>;
	/** Paper currently open in the workspace — suggested, never auto-picked. */
	currentMaterialPath: string | null;
	selectedMaterialPaths: string[];
	materialSearch: string;
	onMaterialSearchChange: (value: string) => void;
	onToggleMaterial: (path: string) => void;
	inputsLocked: boolean;
	instruction: string;
	onInstructionChange: (value: string) => void;
	plannedMinutes: number | null;
	onPlannedMinutesChange: (minutes: number | null) => void;
	scenario: VoiceScenario;
	onScenarioChange: (scenario: VoiceScenario) => void;
	defenseLanguage: "en" | "zh-CN";
	onDefenseLanguageChange: (language: "en" | "zh-CN") => void;
	difficulty: VoiceDifficulty;
	onDifficultyChange: (difficulty: VoiceDifficulty) => void;
	reusable: {
		updatedAt: string;
		partial: boolean;
	} | null;
	onUseReusable: () => void;
	history: VoiceDefenseHistoryEntry[];
	onOpenHistory: (path: string) => void;
	preparation: DefensePreparationManifest | null;
	preparationActive: boolean;
	preparationLoading: boolean;
	preparationStatusLabel: string;
	preparationReady: boolean;
	preparationFailed: boolean;
	preparationStale: boolean;
	/** Selected materials no longer match the prepared snapshot. */
	selectionChanged: boolean;
	voiceStarting: boolean;
	startError?: string;
	brief: string;
	onBriefChange: (value: string) => void;
	briefSource: string;
	onPrepare: () => void;
	onRetry: () => void;
	onCancelPreparation: () => void;
	onStart: () => void;
}) {
	const { t } = useTranslation("agent");
	const [editingBrief, setEditingBrief] = useState(false);
	const [customDraft, setCustomDraft] = useState(() =>
		plannedMinutes !== null &&
		!PLANNED_DURATION_CHOICES.includes(
			plannedMinutes as (typeof PLANNED_DURATION_CHOICES)[number],
		)
			? String(plannedMinutes)
			: "",
	);
	const [customOpen, setCustomOpen] = useState(
		() =>
			plannedMinutes !== null &&
			!PLANNED_DURATION_CHOICES.includes(
				plannedMinutes as (typeof PLANNED_DURATION_CHOICES)[number],
			),
	);
	const macDesktop = useMemo(() => isTauri() && isMacOS(), []);
	const materialStripRef = useRef<HTMLDivElement>(null);
	const materialCountRef = useRef(materials.length);
	// Bring a freshly added chip into view; removals stay where they are.
	useEffect(() => {
		const node = materialStripRef.current;
		if (node && materials.length > materialCountRef.current) {
			node.scrollTo({ left: node.scrollWidth, behavior: "smooth" });
		}
		materialCountRef.current = materials.length;
	}, [materials.length]);
	const canEnter =
		preparationReady &&
		!preparationStale &&
		!selectionChanged &&
		Boolean(brief.trim());
	const showBrief = canEnter;
	const connected = Boolean(authStatus?.connected);
	const preparationRunning =
		preparationActive &&
		!preparationFailed &&
		!preparationStale &&
		!selectionChanged;
	const preparationWorking =
		!preparationStale &&
		!selectionChanged &&
		(preparationRunning || preparationLoading);
	// The page grows through three stages: configure → prepare → read.
	// One centred column, no reserved empty regions.
	const stage: "brief" | "working" | "config" = showBrief
		? "brief"
		: preparationWorking
			? "working"
			: "config";

	useEffect(() => {
		if (stage !== "brief") setEditingBrief(false);
	}, [stage]);

	useEffect(() => {
		const isCustom =
			plannedMinutes !== null &&
			!PLANNED_DURATION_CHOICES.includes(
				plannedMinutes as (typeof PLANNED_DURATION_CHOICES)[number],
			);
		if (isCustom) {
			setCustomOpen(true);
			setCustomDraft(String(plannedMinutes));
		}
	}, [plannedMinutes]);

	const primaryAction = preparationRunning
		? {
				key: "cancel",
				label: t("voiceDefense.preparation.cancel"),
				icon: <X aria-hidden />,
				disabled: voiceStarting,
				onClick: onCancelPreparation,
			}
		: preparationStale || selectionChanged
			? {
					key: "update",
					label: t("voiceDefense.preparation.update"),
					icon: <RefreshCw aria-hidden />,
					disabled:
						preparationLoading || voiceStarting || materials.length === 0,
					onClick: onPrepare,
				}
			: preparationReady
				? connected
					? {
							key: "start",
							label: t("voiceDefense.enter"),
							icon: voiceStarting ? (
								<Loader2 className="animate-spin" aria-hidden />
							) : (
								<Mic aria-hidden />
							),
							disabled: !brief.trim() || voiceStarting || preparationLoading,
							onClick: onStart,
						}
					: {
							key: "connect",
							label: authStatus?.connecting
								? t("voiceDefense.auth.connecting")
								: t("voiceDefense.connectFirst"),
							icon:
								authBusy || authStatus?.connecting ? (
									<Loader2 className="animate-spin" aria-hidden />
								) : (
									<LogIn aria-hidden />
								),
							disabled:
								authBusy ||
								Boolean(authStatus?.connecting) ||
								authStatus === null,
							onClick: onConnectAccount,
						}
				: preparationFailed
					? {
							key: "retry",
							label: t("voiceDefense.preparation.retryFailed"),
							icon: <RefreshCw aria-hidden />,
							disabled: voiceStarting || materials.length === 0,
							onClick: onRetry,
						}
					: reusable
						? {
								key: "reuse",
								label: t("voiceDefense.preparation.useReusable"),
								icon: <FileText aria-hidden />,
								disabled:
									preparationLoading || voiceStarting || materials.length === 0,
								onClick: onUseReusable,
							}
						: {
								key: "prepare",
								label: t("voiceDefense.preparation.prepare"),
								icon: <FileText aria-hidden />,
								disabled:
									preparationLoading || voiceStarting || materials.length === 0,
								onClick: onPrepare,
							};

	const durationLabel = (minutes: number | null) =>
		minutes === null
			? t("voiceDefense.duration.none")
			: t("voiceDefense.duration.minutes", { count: minutes });

	const selectPreset = (choice: number | null) => {
		setCustomOpen(false);
		setCustomDraft("");
		onPlannedMinutesChange(choice);
	};

	const applyCustomMinutes = (raw: string) => {
		setCustomDraft(raw);
		const parsed = clampPlannedDurationMinutes(Number(raw));
		if (parsed !== null) onPlannedMinutesChange(parsed);
	};

	// One narrative line under the committee rail carries every status the old
	// design spread across a badge, a percent, a caption and a banner.
	const runningSeat = COMMITTEE_DEFS.find(
		(seat) => preparation?.nodes[seat.node].status === "running",
	);
	const railLine = preparationLoading
		? { text: t("voiceDefense.preparation.loading"), tone: "active" as const }
		: selectionChanged
			? {
					text: t("voiceDefense.preparation.selectionChangedNotice"),
					tone: "amber" as const,
				}
			: preparationStale
				? {
						text: t("voiceDefense.preparation.staleNotice"),
						tone: "amber" as const,
					}
				: preparationFailed
					? { text: preparationStatusLabel, tone: "red" as const }
					: preparationActive
						? {
								text: runningSeat
									? t(
											`voiceDefense.preparation.narrative.${runningSeat.key}.running`,
										)
									: preparationStatusLabel,
								tone: "active" as const,
							}
						: preparation
							? { text: preparationStatusLabel, tone: "muted" as const }
							: null;

	const materialChip = (material: MaterialItem) => (
		<motion.span
			key={material.path}
			layout
			initial={{ opacity: 0, scale: 0.92 }}
			animate={{ opacity: 1, scale: 1 }}
			exit={{ opacity: 0, scale: 0.92 }}
			transition={{ duration: 0.18, ease: "easeOut" }}
			title={material.path}
			className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/40 bg-background pl-2.5 pr-1 text-sm shadow-xs"
		>
			{material.kind === "directory" ? (
				<Folder
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
			) : (
				<FileText
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
			)}
			<span className="max-w-56 truncate">{material.title}</span>
			{!inputsLocked ? (
				<button
					type="button"
					className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
					aria-label={t("voiceDefense.materials.remove", {
						name: material.title,
					})}
					disabled={voiceStarting}
					onClick={() => onToggleMaterial(material.path)}
				>
					<X className="size-3.5" aria-hidden />
				</button>
			) : (
				<span className="w-1" aria-hidden />
			)}
		</motion.span>
	);

	const materialPickerTrigger = (
		<PopoverTrigger asChild>
			<button
				type="button"
				disabled={inputsLocked || voiceStarting}
				aria-label={t("voiceDefense.setup.editMaterials")}
				className="group/add flex h-12 min-w-0 shrink-0 items-center gap-2.5 pr-1 pl-2 disabled:pointer-events-none disabled:opacity-50"
			>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-primary shadow-xs transition-colors group-hover/add:bg-accent">
					<Plus className="size-4" aria-hidden />
				</span>
				{materials.length === 0 ? (
					<span className="truncate text-muted-foreground/70 text-sm">
						{t("voiceDefense.setup.pickMaterials")}
					</span>
				) : null}
			</button>
		</PopoverTrigger>
	);

	const materialPickerContent = (
		<PopoverContent
			className="w-(--radix-popover-trigger-width) p-0"
			align="start"
			sideOffset={6}
		>
			<div className="relative border-b">
				<Search
					className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden
				/>
				<Input
					value={materialSearch}
					onChange={(event) => onMaterialSearchChange(event.target.value)}
					className="border-0 pl-9 shadow-none focus-visible:ring-0"
					placeholder={t("voiceDefense.materials.search")}
				/>
			</div>
			<div className="agentero-scroll max-h-64 overflow-y-auto p-1">
				{materialOptions.length === 0 ? (
					<p className="px-3 py-6 text-center text-muted-foreground text-sm">
						{t("voiceDefense.materials.emptyOptions")}
					</p>
				) : (
					materialOptions.map((material) => {
						const checked = selectedMaterialPaths.includes(material.path);
						return (
							<label
								key={material.path}
								className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
							>
								<input
									type="checkbox"
									checked={checked}
									onChange={() => onToggleMaterial(material.path)}
									className="sr-only"
								/>
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
										checked &&
											"border-primary bg-primary text-primary-foreground",
									)}
								>
									{checked ? <Check className="size-3" aria-hidden /> : null}
								</span>
								{material.kind === "directory" ? (
									<Folder
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								) : (
									<FileText
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								)}
								<span className="min-w-0 flex-1 truncate text-sm">
									{material.label}
								</span>
								{material.path === currentMaterialPath ? (
									<Badge variant="secondary" className="shrink-0">
										{t("voiceDefense.materials.current")}
									</Badge>
								) : null}
							</label>
						);
					})
				)}
			</div>
		</PopoverContent>
	);

	/** Full configuration form — no boxes, sections breathe through whitespace. */
	const configForm = (
		<div className="space-y-8">
			<section className="space-y-2">
				<p className="px-1 text-center font-medium text-[13px]">
					{t("voiceDefense.materials.title")}
				</p>
				{/* One fixed-height strip: the add button keeps its place, chips
				    flow beside it and overflow scrolls by hand behind an edge
				    fade — the geometry never changes, nothing ever jumps. The
				    picker popover anchors to the whole strip so both share one
				    width. */}
				<Popover>
					<PopoverAnchor asChild>
						<div className="flex h-12 items-center rounded-2xl bg-muted/40 pr-2 pl-1">
							{!inputsLocked ? (
								materialPickerTrigger
							) : (
								<span className="w-2" aria-hidden />
							)}
							{materials.length > 0 ? (
								<div
									ref={materialStripRef}
									className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2 pr-4 pl-0.5 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
								>
									<AnimatePresence initial={false}>
										{materials.map(materialChip)}
									</AnimatePresence>
								</div>
							) : !inputsLocked && currentMaterialPath ? (
								<button
									type="button"
									disabled={voiceStarting}
									className="ml-auto inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full border border-border/60 border-dashed px-3 text-muted-foreground text-sm transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
									onClick={() => onToggleMaterial(currentMaterialPath)}
								>
									<FileText className="size-3.5 shrink-0" aria-hidden />
									<span className="truncate">
										{t("voiceDefense.materials.useCurrent")}
									</span>
								</button>
							) : null}
						</div>
					</PopoverAnchor>
					{materialPickerContent}
				</Popover>
			</section>

			<section className="space-y-3">
				<label
					htmlFor="voice-defense-instruction"
					className="block text-center font-medium text-[13px]"
				>
					{t("voiceDefense.materials.instruction")}
				</label>
				<Textarea
					id="voice-defense-instruction"
					value={instruction}
					disabled={inputsLocked || voiceStarting}
					onChange={(event) => onInstructionChange(event.target.value)}
					className="min-h-24 resize-none rounded-2xl border-transparent bg-muted/40 px-4 py-3 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-ring/40 focus-visible:ring-0"
					placeholder={t("voiceDefense.materials.instructionPlaceholder")}
				/>
			</section>

			<section className="space-y-3">
				<p className="text-center font-medium text-[13px]">
					{t("voiceDefense.scenario.title")}
				</p>
				<fieldset
					className="mx-auto flex w-fit max-w-full items-center overflow-x-auto rounded-full bg-muted/60 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					aria-label={t("voiceDefense.scenario.title")}
				>
					{VOICE_SCENARIOS.map((choice) => {
						const selected = scenario === choice;
						return (
							<button
								key={choice}
								type="button"
								disabled={inputsLocked || voiceStarting}
								aria-pressed={selected}
								className={cn(
									"shrink-0 rounded-full px-3.5 py-1 text-[13px] transition-colors",
									selected
										? "bg-background font-medium shadow-sm"
										: "text-muted-foreground hover:text-foreground",
									(inputsLocked || voiceStarting) &&
										"pointer-events-none opacity-50",
								)}
								onClick={() => onScenarioChange(choice)}
							>
								{t(`voiceDefense.scenario.${choice}`)}
							</button>
						);
					})}
				</fieldset>
			</section>

			<section className="space-y-1">
				<p className="text-center font-medium text-[13px]">
					{t("voiceDefense.duration.title")}
				</p>
				{/* A circular gauge of the planned length: the ring fills toward
				    the 120-minute maximum, adjusted in 5-minute steps. */}
				<div className="flex flex-col items-center gap-5 pt-3">
					<div className="flex items-center gap-8">
						<button
							type="button"
							disabled={voiceStarting || plannedMinutes === null}
							aria-label={t("voiceDefense.duration.decrease")}
							className="flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
							onClick={() =>
								onPlannedMinutesChange(
									plannedMinutes !== null && plannedMinutes > 5
										? plannedMinutes - 5
										: null,
								)
							}
						>
							<Minus className="size-4" aria-hidden />
						</button>
						<div aria-live="polite">
							<AnimatedCircularProgressBar
								value={plannedMinutes ?? 0}
								max={120}
								gaugePrimaryColor="var(--primary)"
								gaugeSecondaryColor="var(--muted)"
								className="size-36"
							>
								{plannedMinutes === null ? (
									<span className="font-light text-4xl text-muted-foreground/60">
										∞
									</span>
								) : (
									<span className="flex flex-col items-center gap-0.5">
										<span className="font-light text-4xl tabular-nums tracking-tight">
											{plannedMinutes}
										</span>
										<span className="font-normal text-muted-foreground text-xs">
											{t("voiceDefense.duration.unit")}
										</span>
									</span>
								)}
							</AnimatedCircularProgressBar>
						</div>
						<button
							type="button"
							disabled={voiceStarting || plannedMinutes === 120}
							aria-label={t("voiceDefense.duration.increase")}
							className="flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
							onClick={() =>
								onPlannedMinutesChange(
									plannedMinutes === null
										? 5
										: Math.min(120, plannedMinutes + 5),
								)
							}
						>
							<Plus className="size-4" aria-hidden />
						</button>
					</div>
					<fieldset
						className="flex items-center rounded-full bg-muted/60 p-1"
						aria-label={t("voiceDefense.duration.title")}
					>
						{PLANNED_DURATION_CHOICES.map((choice) => {
							const selected = plannedMinutes === choice;
							return (
								<button
									key={choice ?? "none"}
									type="button"
									disabled={voiceStarting}
									aria-pressed={selected}
									aria-label={durationLabel(choice)}
									className={cn(
										"rounded-full px-3.5 py-1 text-[13px] tabular-nums transition-colors",
										selected
											? "bg-background font-medium shadow-sm"
											: "text-muted-foreground hover:text-foreground",
										voiceStarting && "pointer-events-none opacity-50",
									)}
									onClick={() => selectPreset(choice)}
								>
									{choice === null ? t("voiceDefense.duration.none") : choice}
								</button>
							);
						})}
					</fieldset>
				</div>
			</section>

			<section className="space-y-3">
				<p className="text-center font-medium text-[13px]">
					{t("voiceDefense.language.title")}
				</p>
				<fieldset
					className="mx-auto flex w-fit items-center rounded-full bg-muted/60 p-1"
					aria-label={t("voiceDefense.language.title")}
				>
					{(
						[
							["zh-CN", "zh"],
							["en", "en"],
						] as const
					).map(([value, key]) => {
						const selected = defenseLanguage === value;
						return (
							<button
								key={value}
								type="button"
								disabled={inputsLocked || voiceStarting}
								aria-pressed={selected}
								className={cn(
									"rounded-full px-3.5 py-1 text-[13px] transition-colors",
									selected
										? "bg-background font-medium shadow-sm"
										: "text-muted-foreground hover:text-foreground",
									(inputsLocked || voiceStarting) &&
										"pointer-events-none opacity-50",
								)}
								onClick={() => onDefenseLanguageChange(value)}
							>
								{t(`voiceDefense.language.${key}`)}
							</button>
						);
					})}
				</fieldset>
			</section>

			<section className="space-y-3">
				<p className="text-center font-medium text-[13px]">
					{t("voiceDefense.difficulty.title")}
				</p>
				<fieldset
					className="mx-auto flex w-fit max-w-full items-center overflow-x-auto rounded-full bg-muted/60 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					aria-label={t("voiceDefense.difficulty.title")}
				>
					{VOICE_DIFFICULTIES.map((choice) => {
						const selected = difficulty === choice;
						return (
							<button
								key={choice}
								type="button"
								disabled={inputsLocked || voiceStarting}
								aria-pressed={selected}
								className={cn(
									"shrink-0 rounded-full px-3.5 py-1 text-[13px] transition-colors",
									selected
										? "bg-background font-medium shadow-sm"
										: "text-muted-foreground hover:text-foreground",
									(inputsLocked || voiceStarting) &&
										"pointer-events-none opacity-50",
								)}
								onClick={() => onDifficultyChange(choice)}
							>
								{t(`voiceDefense.difficulty.${choice}`)}
							</button>
						);
					})}
				</fieldset>
			</section>

			{reusable ? (
				<p className="text-center text-muted-foreground text-sm">
					{t("voiceDefense.preparation.reusableHint", {
						time: new Date(reusable.updatedAt).toLocaleString(),
					})}
					{reusable.partial
						? ` · ${t("voiceDefense.preparation.reusablePartial")}`
						: ""}
				</p>
			) : null}

			{history.length > 0 ? (
				<section className="space-y-3">
					<p className="text-center font-medium text-[13px]">
						{t("voiceDefense.history.title")}
					</p>
					<div className="space-y-1.5">
						{history.map((entry) => {
							const started = new Date(entry.started);
							const label = Number.isNaN(started.getTime())
								? entry.started
								: started.toLocaleString();
							return (
								<button
									key={entry.transcriptPath}
									type="button"
									className="flex w-full flex-col items-start gap-0.5 rounded-2xl bg-muted/40 px-4 py-2.5 text-left transition-colors hover:bg-muted/70"
									aria-label={t("voiceDefense.history.open", { date: label })}
									onClick={() => onOpenHistory(entry.transcriptPath)}
								>
									<span className="text-sm">{label}</span>
									<span className="text-muted-foreground text-xs">
										{entry.coverage
											? t("voiceDefense.history.coverage", {
													asked: entry.coverage.split("/")[0],
													total: entry.coverage.split("/")[1] ?? entry.coverage,
												})
											: entry.durationSeconds !== null
												? t("voiceDefense.duration.minutes", {
														count: Math.max(
															1,
															Math.round(entry.durationSeconds / 60),
														),
													})
												: null}
										{entry.weakAreas?.[0] ? ` · ${entry.weakAreas[0]}` : ""}
									</span>
								</button>
							);
						})}
					</div>
				</section>
			) : null}
		</div>
	);

	const statusLine = railLine ? (
		<p
			className={cn(
				"flex max-w-md items-start justify-center gap-1.5 text-balance text-center text-sm leading-relaxed",
				railLine.tone === "amber" && "text-amber-600 dark:text-amber-300/90",
				railLine.tone === "red" && "text-red-600 dark:text-red-300/90",
				railLine.tone === "active" && "animate-pulse text-muted-foreground",
				railLine.tone === "muted" && "text-muted-foreground/70",
			)}
		>
			{railLine.tone === "amber" || railLine.tone === "red" ? (
				<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
			) : null}
			{railLine.text}
		</p>
	) : null;

	/** Working hero only: the config landing does not know a paper yet. */
	const hero = (
		<div className="flex flex-col items-center gap-6">
			<h1 className="line-clamp-2 max-w-lg text-balance text-center font-semibold text-xl leading-snug tracking-tight">
				{title}
			</h1>
			<CommitteeRail manifest={preparation} active={preparationActive} />
			<div className="flex min-h-5 items-center justify-center">
				{statusLine}
			</div>
		</div>
	);

	/** Compact recap on the brief page: materials · duration · state. */
	const briefMeta = (
		<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
			<div
				className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm"
				title={briefSource || undefined}
			>
				<span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 text-xs dark:text-emerald-400">
					<span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
					{t("voiceDefense.preparation.readyShort")}
				</span>
				<span className="inline-flex items-center gap-1.5">
					<FileText
						className="size-4 shrink-0 text-muted-foreground/70"
						aria-hidden
					/>
					{t("voiceDefense.materials.selected", { count: materials.length })}
				</span>
				<span className="text-muted-foreground/40" aria-hidden>
					·
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="-ml-1.5 h-7 gap-1 rounded-full px-2 font-normal text-muted-foreground"
							disabled={voiceStarting}
						>
							{durationLabel(plannedMinutes)}
							<ChevronDown className="size-3.5" aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-44">
						{PLANNED_DURATION_CHOICES.map((choice) => (
							<DropdownMenuItem
								key={choice ?? "none"}
								onSelect={() => selectPreset(choice)}
							>
								{choice === plannedMinutes && !customOpen ? (
									<Check aria-hidden />
								) : (
									<span className="size-4" aria-hidden />
								)}
								{durationLabel(choice)}
							</DropdownMenuItem>
						))}
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								setCustomOpen(true);
								if (!customDraft) {
									setCustomDraft(String(plannedMinutes ?? 15));
									onPlannedMinutesChange(plannedMinutes ?? 15);
								}
							}}
						>
							{customOpen ? (
								<Check aria-hidden />
							) : (
								<span className="size-4" aria-hidden />
							)}
							{t("voiceDefense.duration.custom")}
							{customOpen && plannedMinutes !== null
								? ` · ${durationLabel(plannedMinutes)}`
								: ""}
						</DropdownMenuItem>
						{customOpen ? (
							<div className="flex items-center gap-2 px-2 py-1.5">
								<Input
									type="number"
									min={1}
									max={240}
									inputMode="numeric"
									value={customDraft}
									onChange={(event) => applyCustomMinutes(event.target.value)}
									className="h-8 w-24 rounded-md px-2 tabular-nums"
									aria-label={t("voiceDefense.duration.customAria")}
									onClick={(event) => event.stopPropagation()}
									onKeyDown={(event) => event.stopPropagation()}
								/>
								<span className="text-muted-foreground text-xs">
									{t("voiceDefense.duration.unit")}
								</span>
							</div>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
				{preparation?.partial ? (
					<Badge variant="outline">
						{t("voiceDefense.preparation.partial")}
					</Badge>
				) : null}
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="shrink-0 rounded-full text-muted-foreground"
				disabled={voiceStarting}
				onClick={() => setEditingBrief((current) => !current)}
			>
				{editingBrief ? <Check aria-hidden /> : <Pencil aria-hidden />}
				{t(
					editingBrief ? "voiceDefense.brief.done" : "voiceDefense.brief.edit",
				)}
			</Button>
		</div>
	);

	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-background text-foreground">
			{/* Soft spotlight — only while the committee works; other stages stay flat. */}
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 hidden h-96 bg-[radial-gradient(ellipse_60%_55%_at_50%_-10%,rgba(56,189,248,0.07),transparent)] transition-opacity duration-700 dark:block",
					stage === "working" ? "opacity-100" : "opacity-0",
				)}
				aria-hidden
			/>
			{/* Live committee reasoning as an ambient wall of text behind the hero. */}
			<ThoughtBackdrop
				runId={preparationActive && preparation ? preparation.runId : null}
			/>

			{/*
			  macOS Overlay title bar: traffic lights sit in the top-left of the
			  window. Pad the header so chrome never covers the close control.
			*/}
			<header
				className={cn(
					"relative z-10 flex h-11 shrink-0 items-center justify-between gap-3 pr-3",
					macDesktop ? "pl-[92px]" : "pl-5",
				)}
			>
				<div
					className="flex min-w-0 items-center gap-2.5"
					data-tauri-drag-region
				>
					<Mic className="size-4 shrink-0 text-muted-foreground" aria-hidden />
					<p className="shrink-0 font-medium text-sm">
						{t("voiceDefense.title")}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<AccountChip
						authStatus={authStatus}
						authBusy={authBusy}
						disabled={voiceStarting}
						onConnect={onConnectAccount}
						onCancel={onCancelAccountConnection}
						onDisconnect={onDisconnectAccount}
					/>
				</div>
			</header>

			<div className="agentero-scroll relative min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 pt-4 pb-10">
					<AnimatePresence mode="wait" initial={false}>
						{stage === "brief" ? (
							<motion.div key="brief" {...stageFade} className="space-y-5">
								{briefMeta}
								{editingBrief ? (
									<Textarea
										value={brief}
										disabled={voiceStarting}
										onChange={(event) => onBriefChange(event.target.value)}
										className="min-h-[60vh] resize-y rounded-2xl border-transparent bg-muted/30 px-5 py-4 text-sm leading-relaxed focus-visible:border-ring/40 focus-visible:ring-0"
										placeholder={t("voiceDefense.preparation.briefPlaceholder")}
									/>
								) : (
									<MessageResponse className="text-[15px] leading-relaxed">
										{brief}
									</MessageResponse>
								)}
							</motion.div>
						) : stage === "working" ? (
							<motion.div
								key="working"
								{...stageFade}
								className="my-auto space-y-8 py-10"
							>
								{hero}
								<p className="text-center text-muted-foreground/70 text-sm">
									{t("voiceDefense.materials.selected", {
										count: materials.length,
									})}
									<span aria-hidden> · </span>
									{durationLabel(plannedMinutes)}
								</p>
							</motion.div>
						) : (
							<motion.div
								key="config"
								{...stageFade}
								className="my-auto space-y-10 py-10"
							>
								{statusLine ? (
									<div className="flex justify-center">{statusLine}</div>
								) : null}
								{configForm}
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			</div>

			{/* In-flow footer: the actions never cover the form. */}
			<footer className="relative z-10 shrink-0 border-border/50 border-t px-6 py-3.5">
				{startError ? (
					<p
						role="alert"
						className="mx-auto mb-2 max-w-2xl text-center text-destructive text-sm"
					>
						{startError}
					</p>
				) : null}
				<div className="mx-auto flex w-full max-w-2xl items-center justify-center gap-2">
					<Button
						type="button"
						variant={primaryAction.key === "cancel" ? "outline" : "default"}
						disabled={primaryAction.disabled}
						onClick={primaryAction.onClick}
						className={cn(
							"h-10 rounded-full px-6 text-[15px]",
							primaryAction.key === "start" &&
								"shadow-[0_0_24px] shadow-primary/35",
						)}
					>
						{primaryAction.icon}
						{primaryAction.label}
					</Button>
					{(preparationReady &&
						!preparationRunning &&
						!preparationStale &&
						!selectionChanged) ||
					(reusable &&
						!preparationReady &&
						!preparationRunning &&
						!preparationFailed) ? (
						<Button
							type="button"
							variant="ghost"
							disabled={voiceStarting || preparationLoading}
							onClick={onPrepare}
							className="h-10 rounded-full text-muted-foreground"
						>
							<RefreshCw aria-hidden />
							{t("voiceDefense.preparation.reprepare")}
						</Button>
					) : null}
				</div>
			</footer>
		</div>
	);
}
