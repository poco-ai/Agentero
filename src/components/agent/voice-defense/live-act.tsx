import {
	CircleStop,
	FilePlus,
	Focus,
	Mic,
	MicOff,
	PhoneOff,
	ScrollText,
	Send,
	X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FlipClock } from "@/components/ui/flip-clock";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type { VoiceCaption, VoiceConnectionStatus } from "@/lib/voice-defense";

export type LiveActPhase = "connecting" | "live" | "ending" | "error";

type StageMode = "connecting" | "listening" | "speaking" | "ending" | "error";

/** Flip-clock glyphs: minutes padded to two digits so card slots stay stable. */
function formatClock(totalSeconds: number) {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * One speaker's anchored caption slot. The height is fixed so streaming text
 * never moves the rest of the stage: content bottom-anchors and grows upward
 * out of view behind a top fade. The only animation is a short crossfade when
 * a new message replaces the previous one — token appends animate nothing.
 */
export function CaptionSlot({
	label,
	tone,
	caption,
	active,
	animate,
	placeholder,
	size,
}: {
	label: string;
	tone: "sky" | "emerald";
	caption: { id: string; text: string } | null;
	active: boolean;
	animate: boolean;
	placeholder?: string;
	size: "primary" | "secondary";
}) {
	const textClassName = cn(
		"w-full whitespace-pre-wrap text-center",
		size === "primary"
			? "text-neutral-100 text-xl leading-9"
			: "text-[15px] text-neutral-300 leading-7",
	);
	return (
		<div
			className={cn(
				"flex w-full flex-col items-center gap-1.5 transition-opacity duration-500",
				active ? "opacity-100" : "opacity-55",
			)}
		>
			<p
				className={cn(
					"rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-wider",
					tone === "sky"
						? "bg-sky-400/10 text-sky-300"
						: "bg-emerald-400/10 text-emerald-300",
				)}
			>
				{label}
			</p>
			<div
				className={cn(
					"flex w-full flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_30%)]",
					size === "primary" ? "h-[6.75rem]" : "h-14",
				)}
			>
				{caption?.text.trim() ? (
					animate ? (
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.p
								key={caption.id}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.25, ease: "easeOut" }}
								className={textClassName}
							>
								{caption.text}
							</motion.p>
						</AnimatePresence>
					) : (
						<p className={textClassName}>{caption.text}</p>
					)
				) : placeholder ? (
					<p className="animate-pulse pb-1 text-center text-[15px] text-neutral-600">
						{placeholder}
					</p>
				) : null}
			</div>
		</div>
	);
}

/**
 * The defense stage: a forced-dark, full-window room built around the session
 * clock. Captions render as a steady two-line block underneath (previous line
 * dimmed, current line prominent) so streaming updates never jump around;
 * controls float in a capsule that fades out when idle. Full history lives in
 * a side transcript drawer.
 */
export function LiveAct({
	phase,
	connectionStatus,
	captions,
	muted,
	errorText,
	title,
	startedAt,
	plannedDurationSeconds,
	onTimeUp,
	onToggleMuted,
	onInterrupt,
	onSendPatch,
	onRefocus,
	onEnd,
	onCancelConnecting,
	onRetry,
	onClose,
}: {
	phase: LiveActPhase;
	connectionStatus: VoiceConnectionStatus;
	captions: VoiceCaption[];
	muted: boolean;
	errorText: string;
	title: string;
	startedAt: Date | null;
	/** Planned defense length; null keeps the count-up stopwatch. */
	plannedDurationSeconds: number | null;
	onTimeUp: () => void;
	onToggleMuted: () => void;
	onInterrupt: () => void;
	onSendPatch: (text: string) => boolean;
	onRefocus: () => boolean;
	onEnd: () => void;
	onCancelConnecting: () => void;
	onRetry: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("agent");
	const macDesktop = useMemo(() => isTauri() && isMacOS(), []);
	const reducedMotion = useReducedMotion();
	const [showTranscript, setShowTranscript] = useState(false);
	const [patchOpen, setPatchOpen] = useState(false);
	const [patchText, setPatchText] = useState("");
	const [controlsAwake, setControlsAwake] = useState(true);
	const idleTimerRef = useRef<number | null>(null);
	const transcriptPortRef = useRef<HTMLDivElement | null>(null);
	const patchInputRef = useRef<HTMLInputElement | null>(null);
	const [elapsed, setElapsed] = useState(0);

	const wake = useCallback(() => {
		setControlsAwake(true);
		if (idleTimerRef.current !== null) {
			window.clearTimeout(idleTimerRef.current);
		}
		if (patchOpen) return;
		idleTimerRef.current = window.setTimeout(
			() => setControlsAwake(false),
			3200,
		);
	}, [patchOpen]);

	const submitPatch = useCallback(() => {
		const body = patchText.trim();
		if (!body) return;
		if (onSendPatch(body)) {
			setPatchText("");
			setPatchOpen(false);
		}
	}, [onSendPatch, patchText]);

	useEffect(() => {
		wake();
		return () => {
			if (idleTimerRef.current !== null) {
				window.clearTimeout(idleTimerRef.current);
			}
		};
	}, [wake]);

	useEffect(() => {
		if (!startedAt || phase !== "live") return;
		const tick = () =>
			setElapsed(
				Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
			);
		tick();
		const id = window.setInterval(tick, 1000);
		return () => window.clearInterval(id);
	}, [phase, startedAt]);

	// Fire the time-up notice exactly once per session.
	const timeUpFiredRef = useRef(false);
	useEffect(() => {
		if (phase !== "live" || plannedDurationSeconds === null) return;
		if (timeUpFiredRef.current || elapsed < plannedDurationSeconds) return;
		timeUpFiredRef.current = true;
		onTimeUp();
	}, [elapsed, onTimeUp, phase, plannedDurationSeconds]);
	useEffect(() => {
		if (phase === "connecting") timeUpFiredRef.current = false;
	}, [phase]);

	useEffect(() => {
		if (!patchOpen) return;
		setControlsAwake(true);
		if (idleTimerRef.current !== null) {
			window.clearTimeout(idleTimerRef.current);
		}
		const focusTimer = window.setTimeout(
			() => patchInputRef.current?.focus(),
			220,
		);
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setPatchOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(focusTimer);
			window.removeEventListener("keydown", onKey);
		};
	}, [patchOpen]);

	useEffect(() => {
		const port = transcriptPortRef.current;
		if (showTranscript && port && captions.length > 0) {
			port.scrollTop = port.scrollHeight;
		}
	}, [captions, showTranscript]);

	// Each speaker owns a fixed caption slot; only their newest message shows.
	const { latestAssistant, latestUser } = useMemo(() => {
		let assistant: VoiceCaption | null = null;
		let user: VoiceCaption | null = null;
		for (let index = captions.length - 1; index >= 0; index -= 1) {
			const caption = captions[index];
			if (caption.role === "assistant" && !assistant) assistant = caption;
			if (caption.role === "user" && !user) user = caption;
			if (assistant && user) break;
		}
		return { latestAssistant: assistant, latestUser: user };
	}, [captions]);
	const speakingRole: VoiceCaption["role"] =
		captions.length > 0 ? captions[captions.length - 1].role : "assistant";
	const mode: StageMode =
		phase === "connecting"
			? "connecting"
			: phase === "ending"
				? "ending"
				: phase === "error"
					? "error"
					: connectionStatus === "speaking"
						? "speaking"
						: "listening";
	const statusLabel =
		phase === "connecting"
			? t("voiceDefense.stage.entering")
			: phase === "ending"
				? t("voiceDefense.status.ending")
				: phase === "error"
					? t("voiceDefense.status.error")
					: t(`voiceDefense.status.${connectionStatus}`);
	const statusDot =
		mode === "error"
			? "bg-red-400"
			: mode === "speaking"
				? "bg-sky-300"
				: mode === "listening"
					? "animate-pulse bg-emerald-400"
					: "animate-pulse bg-neutral-500";
	const chromeVisible =
		controlsAwake || phase !== "live" || showTranscript || patchOpen;
	const roleLabel = (role: VoiceCaption["role"]) =>
		t(
			role === "assistant"
				? "voiceDefense.role.assistant"
				: "voiceDefense.role.user",
		);
	// Timed mode counts down to the planned length, then shows overtime in red.
	const remaining =
		plannedDurationSeconds !== null ? plannedDurationSeconds - elapsed : null;
	const overtime = remaining !== null && remaining < 0;
	const urgent = remaining !== null && !overtime && remaining <= 60;
	const clockText =
		remaining !== null
			? overtime
				? `+${formatClock(-remaining)}`
				: formatClock(remaining)
			: formatClock(elapsed);
	// The countdown is deliberately red — the pressure is the point. The
	// count-up stopwatch stays neutral.
	const clockTone =
		remaining === null
			? "text-neutral-100"
			: overtime
				? "text-red-400"
				: "text-red-500";
	const clockSize =
		clockText.length <= 5
			? "text-[10rem]"
			: clockText.length <= 7
				? "text-[8rem]"
				: "text-[6rem]";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: mouse movement only wakes the idle-fading controls
		<div
			className="dark relative flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-100"
			onMouseMove={wake}
		>
			{/* The room closes in as time runs out. */}
			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-0 shadow-[inset_0_0_160px_rgba(239,68,68,0.2)] transition-opacity duration-1000",
					overtime ? "opacity-100" : urgent ? "opacity-60" : "opacity-0",
				)}
			/>
			<div
				className={cn(
					"flex shrink-0 items-center justify-between py-4 pr-5 transition-opacity duration-500",
					macDesktop ? "pl-[92px]" : "pl-5",
					chromeVisible ? "opacity-100" : "opacity-0",
				)}
			>
				<span
					className="min-w-0 max-w-96 truncate text-neutral-400 text-sm"
					data-tauri-drag-region
				>
					{title}
				</span>
				{phase === "live" || phase === "ending" ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="rounded-full text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
						aria-pressed={showTranscript}
						onClick={() => setShowTranscript((current) => !current)}
					>
						<ScrollText aria-hidden />
						{t(
							showTranscript
								? "voiceDefense.stage.hideTranscript"
								: "voiceDefense.stage.transcript",
						)}
					</Button>
				) : null}
			</div>

			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-14 px-6 pb-12">
				{/* Session clock — the centerpiece of the stage. */}
				<div className="flex flex-col items-center gap-7">
					<div className="relative">
						{/* Red pressure glow: always on while timed, escalating toward overtime. */}
						<div
							aria-hidden
							className={cn(
								"-inset-x-20 -inset-y-12 absolute rounded-full blur-3xl transition-opacity duration-1000",
								overtime
									? "bg-red-500/20"
									: urgent
										? "bg-red-500/15"
										: "bg-red-500/8",
								remaining === null
									? "opacity-0"
									: urgent || overtime
										? "opacity-90"
										: "opacity-50",
							)}
						/>
						<div
							className={cn(
								"relative transition-opacity duration-500",
								phase === "connecting" && "opacity-40",
								urgent &&
									"[animation:flip-clock-heartbeat_1.4s_ease-in-out_infinite]",
								overtime &&
									"[animation:flip-clock-heartbeat_0.9s_ease-in-out_infinite]",
							)}
						>
							<FlipClock
								value={clockText}
								className={cn(clockSize, clockTone)}
							/>
						</div>
					</div>
					<p className="flex items-center gap-2 text-neutral-400 text-sm">
						<span
							className={cn("size-1.5 rounded-full", statusDot)}
							aria-hidden
						/>
						{statusLabel}
					</p>
				</div>

				<div
					className="flex w-full max-w-2xl flex-col items-center gap-5"
					aria-live="polite"
				>
					{phase === "error" ? (
						<>
							<p className="max-w-md text-balance text-center text-[17px] text-neutral-200 leading-7">
								{errorText}
							</p>
							<div className="mt-1 flex items-center gap-2.5">
								<Button
									type="button"
									variant="ghost"
									className="rounded-full text-neutral-300 hover:bg-white/10 hover:text-neutral-100"
									onClick={onClose}
								>
									{t("voiceDefense.close")}
								</Button>
								<Button
									type="button"
									className="rounded-full"
									onClick={onRetry}
								>
									{t("voiceDefense.retry")}
								</Button>
							</div>
						</>
					) : phase === "live" ? (
						<>
							<CaptionSlot
								label={roleLabel("assistant")}
								tone="sky"
								size="primary"
								caption={latestAssistant}
								active={speakingRole === "assistant"}
								animate={!reducedMotion}
								placeholder={t("voiceDefense.waitingCaption")}
							/>
							<CaptionSlot
								label={roleLabel("user")}
								tone="emerald"
								size="secondary"
								caption={latestUser}
								active={speakingRole === "user"}
								animate={!reducedMotion}
							/>
						</>
					) : null}
				</div>
			</div>

			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 bottom-8 flex justify-center transition-opacity duration-500",
					chromeVisible ? "opacity-100" : "opacity-25",
				)}
			>
				{phase === "connecting" ? (
					<Button
						type="button"
						variant="ghost"
						className="pointer-events-auto rounded-full text-neutral-300 hover:bg-white/10 hover:text-neutral-100"
						onClick={onCancelConnecting}
					>
						<X aria-hidden />
						{t("voiceDefense.cancelConnecting")}
					</Button>
				) : phase === "live" ? (
					<motion.div
						layout
						transition={
							reducedMotion
								? { duration: 0 }
								: { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }
						}
						className="pointer-events-auto overflow-hidden rounded-full border border-white/10 bg-white/5 p-1.5 shadow-lg backdrop-blur"
					>
						<AnimatePresence mode="popLayout" initial={false}>
							{patchOpen ? (
								<motion.form
									key="patch-composer"
									layout="position"
									initial={
										reducedMotion ? false : { opacity: 0, filter: "blur(8px)" }
									}
									animate={{ opacity: 1, filter: "blur(0px)" }}
									exit={
										reducedMotion
											? { opacity: 0 }
											: { opacity: 0, filter: "blur(8px)" }
									}
									transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
									className="flex w-[min(36rem,calc(100vw-4rem))] items-center gap-1"
									onSubmit={(event) => {
										event.preventDefault();
										submitPatch();
									}}
								>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="shrink-0 rounded-full text-neutral-300 hover:bg-white/10 hover:text-neutral-50"
										aria-label={t("voiceDefense.patch.close")}
										onClick={() => setPatchOpen(false)}
									>
										<X aria-hidden />
									</Button>
									<input
										ref={patchInputRef}
										value={patchText}
										onChange={(event) => setPatchText(event.target.value)}
										placeholder={t("voiceDefense.patch.placeholder")}
										aria-label={t("voiceDefense.patch.title")}
										className="h-9 min-w-0 flex-1 bg-transparent px-1 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
									/>
									<Button
										type="submit"
										size="icon"
										className="shrink-0 rounded-full"
										disabled={!patchText.trim()}
										aria-label={t("voiceDefense.patch.send")}
									>
										<Send aria-hidden />
									</Button>
								</motion.form>
							) : (
								<motion.div
									key="live-controls"
									layout="position"
									initial={
										reducedMotion ? false : { opacity: 0, filter: "blur(8px)" }
									}
									animate={{ opacity: 1, filter: "blur(0px)" }}
									exit={
										reducedMotion
											? { opacity: 0 }
											: { opacity: 0, filter: "blur(8px)" }
									}
									transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
									className="flex items-center gap-1"
								>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className={cn(
													"rounded-full text-neutral-200 hover:bg-white/10 hover:text-neutral-50",
													muted &&
														"bg-red-500/20 text-red-300 hover:bg-red-500/25 hover:text-red-200",
												)}
												aria-label={t(
													muted ? "voiceDefense.unmute" : "voiceDefense.mute",
												)}
												aria-pressed={muted}
												onClick={onToggleMuted}
											>
												{muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t(muted ? "voiceDefense.unmute" : "voiceDefense.mute")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="rounded-full text-neutral-200 hover:bg-white/10 hover:text-neutral-50"
												aria-label={t("voiceDefense.interrupt")}
												onClick={onInterrupt}
											>
												<CircleStop aria-hidden />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("voiceDefense.interrupt")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="rounded-full text-neutral-200 hover:bg-white/10 hover:text-neutral-50"
												aria-label={t("voiceDefense.patch.title")}
												onClick={() => setPatchOpen(true)}
											>
												<FilePlus aria-hidden />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("voiceDefense.patch.title")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="rounded-full text-neutral-200 hover:bg-white/10 hover:text-neutral-50"
												aria-label={t("voiceDefense.refocus")}
												onClick={() => onRefocus()}
											>
												<Focus aria-hidden />
											</Button>
										</TooltipTrigger>
										<TooltipContent>{t("voiceDefense.refocus")}</TooltipContent>
									</Tooltip>
									<span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
									<Button
										type="button"
										variant="destructive"
										className="rounded-full px-4"
										onClick={onEnd}
									>
										<PhoneOff aria-hidden />
										{t("voiceDefense.end")}
									</Button>
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				) : null}
			</div>

			<div
				className={cn(
					"absolute inset-y-0 right-0 z-10 flex w-96 max-w-[85vw] flex-col border-white/10 border-l bg-neutral-950/95 backdrop-blur transition-transform duration-300",
					showTranscript ? "translate-x-0" : "translate-x-full",
				)}
				aria-hidden={!showTranscript}
			>
				<div className="flex shrink-0 items-center justify-between px-5 py-4">
					<p className="font-medium text-[15px] text-neutral-200">
						{t("voiceDefense.stage.transcript")}
					</p>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="rounded-full text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
						aria-label={t("voiceDefense.stage.hideTranscript")}
						tabIndex={showTranscript ? 0 : -1}
						onClick={() => setShowTranscript(false)}
					>
						<X aria-hidden />
					</Button>
				</div>
				<div
					ref={transcriptPortRef}
					role="log"
					aria-live="polite"
					className="agentero-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-6"
				>
					{captions.length === 0 ? (
						<p className="py-10 text-center text-neutral-600 text-sm">
							{t("voiceDefense.waitingCaption")}
						</p>
					) : (
						captions.map((caption) => (
							<div key={caption.id} className="space-y-1">
								<p
									className={cn(
										"text-[12px]",
										caption.role === "assistant"
											? "text-sky-300/80"
											: "text-emerald-300/80",
									)}
								>
									{roleLabel(caption.role)}
								</p>
								<p className="whitespace-pre-wrap text-[15px] text-neutral-200 leading-6">
									{caption.text}
								</p>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
