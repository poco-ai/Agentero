import { logger } from "@/lib/core/logger";
import {
	createVoiceSession,
	getVoiceConfig,
	releaseVoiceSession,
} from "@/lib/voice-defense/api";
import {
	microphoneCaptureError,
	VoiceDefenseError,
	voiceTransportErrorCode,
} from "@/lib/voice-defense/errors";
import {
	applyVoiceCaptionDelta,
	buildDefenseOpeningTrigger,
	buildVoiceInterruptEvent,
	buildVoiceRelayEvent,
	createVoiceOpeningState,
	encodeVoiceEvent,
	isCanonicalDefenseAnnouncementCaption,
	isDefenseAnnouncementCaption,
	isDefenseOpeningCaption,
	isDefenseRestartCaption,
	isFirstQuestionReaskCaption,
	isNoiseUserCaption,
	isOpeningFillerCaption,
	isSubstantialUserCaption,
	reduceVoiceOpening,
	type VoiceCaption,
	type VoiceOpeningState,
	visibleAssistantCaptionDuringOpening,
	visibleVoiceCaption,
	voiceStateFromMessage,
} from "@/lib/voice-defense/protocol";

export type VoiceConnectionStatus =
	| "connecting"
	| "listening"
	| "speaking"
	| "live"
	| "ended"
	| "error";

export type VoiceDefenseClientEvents = {
	onStatus: (status: VoiceConnectionStatus) => void;
	onCaption: (caption: VoiceCaption) => void;
	onRemoteStream: (stream: MediaStream) => void;
	onCommitteePlayback?: (enabled: boolean) => void;
	onError: (error: Error) => void;
};

// Voice state can return to `listening` before the final assistant transcript
// reaches the DataChannel. Give that transcript a short settlement window so
// a direct opening can cancel the phase-two trigger before it is sent.
const OPENING_CAPTION_SETTLE_MS = 1_000;
const OPENING_RECOVERY_TIMEOUT_MS = 20_000;
/** Wait for committee audio tail / AEC to settle before unmuting. */
const MICROPHONE_OPEN_SETTLE_MS = 400;
const WIRE_TEXT_PREFIX = 40;

type WireDropReason =
	| "awaiting-user"
	| "internal"
	| "restart"
	| "noise"
	| "filler"
	| "preamble";

function wireTextPrefix(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, WIRE_TEXT_PREFIX);
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
	if (peer.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = window.setTimeout(done, 2_500);
		function done() {
			window.clearTimeout(timeout);
			peer.removeEventListener("icegatheringstatechange", onChange);
			resolve();
		}
		function onChange() {
			if (peer.iceGatheringState === "complete") done();
		}
		peer.addEventListener("icegatheringstatechange", onChange);
	});
}

function waitForDataChannel(channel: RTCDataChannel): Promise<void> {
	if (channel.readyState === "open") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			cleanup();
			reject(new VoiceDefenseError("dataChannelTimeout"));
		}, 12_000);
		function cleanup() {
			window.clearTimeout(timeout);
			channel.removeEventListener("open", onOpen);
			channel.removeEventListener("error", onError);
			channel.removeEventListener("close", onClose);
		}
		function onOpen() {
			cleanup();
			resolve();
		}
		function onError() {
			cleanup();
			reject(new VoiceDefenseError("dataChannelFailed"));
		}
		function onClose() {
			cleanup();
			reject(new Error("Voice connection cancelled"));
		}
		channel.addEventListener("open", onOpen);
		channel.addEventListener("error", onError);
		channel.addEventListener("close", onClose);
	});
}

export class VoiceDefenseClient {
	private peer: RTCPeerConnection | null = null;
	private channel: RTCDataChannel | null = null;
	private localStream: MediaStream | null = null;
	private remoteStream: MediaStream | null = null;
	private voiceSessionId: string | null = null;
	private streamingCaption: VoiceCaption | null = null;
	private internalCaptionMessageIds = new Set<string>();
	private internalCaptionTexts: string[] = [];
	private userMuted = false;
	private opening: VoiceOpeningState = createVoiceOpeningState();
	private openingLanguage: "en" | "zh-CN" = "zh-CN";
	private openingTriggerSent = false;
	private openingTriggerTimer: number | null = null;
	private assistantTurnSeen = false;
	private openingAssistantCaption: VoiceCaption | null = null;
	private openingCaptionShown = false;
	private openingAnnouncementId: string | null = null;
	private emittedCaptionIds = new Set<string>();
	private suppressedAssistantMessageIds = new Set<string>();
	private initialAssistantTimer: number | null = null;
	private closing = false;
	private terminalError = false;
	private disconnectTimer: number | null = null;
	private protocolMessageCount = 0;
	private protocolRecognizedCount = 0;
	private protocolDriftReported = false;
	private heardSubstantialUserAnswer = false;
	private microphoneSettled = false;
	private microphoneOpenTimer: number | null = null;
	private committeePlaybackEnabled = false;
	private interruptedPreambleIds = new Set<string>();
	private wireStartedAt = 0;
	private openingOpenedAt: number | null = null;
	private unmuteDelayMs: number | null = null;
	private firstUserCaptionPrefix: string | null = null;
	private noiseDroppedCount = 0;
	private restartSuppressedCount = 0;
	private readonly onOffline = () => {
		this.scheduleConnectionFailure("networkOffline", 1_500);
	};
	private readonly onOnline = () => {
		this.clearDisconnectTimer();
		if (this.peer?.connectionState === "disconnected") {
			this.scheduleConnectionFailure("connectionLost", 5_000);
		}
	};

	constructor(private readonly events: VoiceDefenseClientEvents) {}

	async connect(
		bootstrap: string,
		options?: { language?: "en" | "zh-CN" },
	): Promise<void> {
		this.closing = false;
		this.terminalError = false;
		this.userMuted = false;
		this.opening = createVoiceOpeningState();
		this.openingLanguage = options?.language ?? "zh-CN";
		this.openingTriggerSent = false;
		this.clearOpeningTriggerTimer();
		this.assistantTurnSeen = false;
		this.openingAssistantCaption = null;
		this.openingCaptionShown = false;
		this.openingAnnouncementId = null;
		this.emittedCaptionIds.clear();
		this.suppressedAssistantMessageIds.clear();
		this.clearInitialAssistantTimer();
		this.resetWireSession();
		this.internalCaptionMessageIds.clear();
		this.internalCaptionTexts = [];
		this.events.onStatus("connecting");
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				throw new VoiceDefenseError("microphoneUnavailable");
			}
			const config = await getVoiceConfig();
			this.assertActive();
			let localStream: MediaStream;
			try {
				// Explicit voice-processing constraints: without echo cancellation
				// the committee's own playback re-enters the microphone, upstream
				// treats it as the user speaking, and the conversation "jumps" to a
				// context nobody asked for.
				localStream = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
					video: false,
				});
			} catch (error) {
				throw microphoneCaptureError(error);
			}
			if (this.closing) {
				for (const track of localStream.getTracks()) track.stop();
				throw new Error("Voice connection cancelled");
			}
			this.localStream = localStream;
			this.applyMicrophoneState();
			const peer = new RTCPeerConnection({
				iceServers: config.webrtc?.ice_servers ?? [],
				bundlePolicy: "max-bundle",
			});
			this.peer = peer;
			const channelConfig = config.webrtc?.data_channel;
			const channel = peer.createDataChannel(
				channelConfig?.label || "oai-events",
				{
					negotiated: channelConfig?.negotiated !== false,
					id: Number.isInteger(channelConfig?.id) ? channelConfig.id : 0,
				},
			);
			this.channel = channel;
			channel.addEventListener("message", (event) =>
				this.onDataMessage(event.data),
			);
			channel.addEventListener("close", () => {
				this.fail(new VoiceDefenseError("connectionLost"));
			});
			channel.addEventListener("error", () => {
				this.fail(new VoiceDefenseError("dataChannelFailed"));
			});

			localStream.getTracks().forEach((track) => {
				peer.addTrack(track, localStream);
			});
			peer.addEventListener("track", (event) => {
				const stream =
					event.streams[0] ?? this.remoteStream ?? new MediaStream();
				if (!event.streams[0]) stream.addTrack(event.track);
				this.remoteStream = stream;
				this.applyRemotePlaybackState();
				this.events.onRemoteStream(stream);
			});
			peer.addEventListener("connectionstatechange", () => {
				if (this.closing) return;
				const failureCode = voiceTransportErrorCode(
					peer.connectionState,
					navigator.onLine !== false,
				);
				switch (peer.connectionState) {
					case "connected":
						this.clearDisconnectTimer();
						this.events.onStatus("live");
						break;
					case "disconnected":
						this.scheduleConnectionFailure(
							failureCode === "networkOffline"
								? "networkOffline"
								: "connectionLost",
							5_000,
						);
						break;
					case "failed":
						this.fail(new VoiceDefenseError(failureCode ?? "webrtcFailed"));
						break;
					case "closed":
						this.fail(new VoiceDefenseError(failureCode ?? "connectionLost"));
						break;
				}
			});
			window.addEventListener("offline", this.onOffline);
			window.addEventListener("online", this.onOnline);

			const offer = await peer.createOffer({ offerToReceiveAudio: true });
			await peer.setLocalDescription(offer);
			await waitForIceGathering(peer);
			const offerSdp = peer.localDescription?.sdp;
			if (!offerSdp) throw new Error("Voice WebRTC offer is empty");
			const session = await createVoiceSession({
				offerSdp,
				voice: config.defaults?.voice || "cove",
				voiceMode: config.defaults?.voice_mode || "wingman",
				languageCode:
					this.openingLanguage === "zh-CN"
						? "zh"
						: this.openingLanguage === "en"
							? "en"
							: config.defaults?.language_code || "auto",
			});
			if (this.closing) {
				await releaseVoiceSession(session.voiceSessionId).catch(
					() => undefined,
				);
				throw new Error("Voice connection cancelled");
			}
			this.voiceSessionId = session.voiceSessionId;
			await peer.setRemoteDescription({
				type: "answer",
				sdp: session.answerSdp,
			});
			await waitForDataChannel(channel);
			const bootstrapMessageId = crypto.randomUUID();
			this.internalCaptionMessageIds.add(bootstrapMessageId);
			this.internalCaptionTexts.push(bootstrap);
			channel.send(
				encodeVoiceEvent(buildVoiceRelayEvent(bootstrap, bootstrapMessageId)),
			);
			this.logWire({
				dir: "out",
				kind: "relay",
				drop: "internal",
				textLen: bootstrap.length,
			});
			// Recovery watchdog only. Elapsed time never opens the playback gate:
			// it interrupts a noncanonical turn and requests the exact opening.
			this.initialAssistantTimer = window.setTimeout(() => {
				this.initialAssistantTimer = null;
				this.handleOpeningTimeout();
			}, OPENING_RECOVERY_TIMEOUT_MS);
			this.events.onStatus("listening");
		} catch (error) {
			this.events.onStatus("error");
			await this.close();
			throw error;
		}
	}

	setMuted(muted: boolean): void {
		this.userMuted = muted;
		this.applyMicrophoneState();
	}

	interrupt(): void {
		if (this.channel?.readyState !== "open") return;
		this.channel.send(encodeVoiceEvent(buildVoiceInterruptEvent()));
		this.logWire({ dir: "out", kind: "interrupt" });
	}

	/**
	 * Inject a control/user text turn that must not appear on stage or in the
	 * transcript (same treatment as the bootstrap and opening trigger).
	 * Refused while the opening gate is still closed.
	 */
	sendUserText(text: string): boolean {
		const body = text.trim();
		if (!body) return false;
		if (this.opening.phase !== "open") return false;
		if (this.channel?.readyState !== "open") return false;
		const messageId = crypto.randomUUID();
		this.internalCaptionMessageIds.add(messageId);
		this.internalCaptionTexts.push(body);
		this.channel.send(encodeVoiceEvent(buildVoiceRelayEvent(body, messageId)));
		this.logWire({
			dir: "out",
			kind: "relay",
			drop: "internal",
			captionId: messageId,
			role: "user",
			text: body,
		});
		return true;
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.logWireSummary();
		this.clearDisconnectTimer();
		this.clearInitialAssistantTimer();
		this.clearMicrophoneOpenTimer();
		window.removeEventListener("offline", this.onOffline);
		window.removeEventListener("online", this.onOnline);
		const sessionId = this.voiceSessionId;
		this.voiceSessionId = null;
		this.channel?.close();
		this.channel = null;
		this.peer?.close();
		this.peer = null;
		for (const track of this.localStream?.getTracks() ?? []) track.stop();
		for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
		this.localStream = null;
		this.remoteStream = null;
		this.streamingCaption = null;
		this.opening = createVoiceOpeningState();
		this.openingTriggerSent = false;
		this.clearOpeningTriggerTimer();
		this.assistantTurnSeen = false;
		this.openingAssistantCaption = null;
		this.openingCaptionShown = false;
		this.openingAnnouncementId = null;
		this.emittedCaptionIds.clear();
		this.suppressedAssistantMessageIds.clear();
		this.heardSubstantialUserAnswer = false;
		this.microphoneSettled = false;
		this.committeePlaybackEnabled = false;
		this.interruptedPreambleIds.clear();
		this.internalCaptionMessageIds.clear();
		this.internalCaptionTexts = [];
		if (sessionId) {
			try {
				await releaseVoiceSession(sessionId);
			} catch {
				// Local media teardown must not depend on sidecar availability.
			}
		}
		this.events.onStatus("ended");
	}

	private onDataMessage(raw: unknown): void {
		const state = voiceStateFromMessage(raw);
		if (state) {
			if (state === "speaking" || state === "responding") {
				this.assistantTurnSeen = true;
			}
			this.applyOpening(
				reduceVoiceOpening(this.opening, { type: "voice-state", state }),
			);
			this.logWire({ dir: "in", kind: "voice-state", state });
			if (state === "listening" || state === "idle") {
				this.scheduleOpeningTrigger();
			} else if (state === "speaking" || state === "responding") {
				this.clearOpeningTriggerTimer();
			}
		}
		if (state === "listening" || state === "idle")
			this.events.onStatus("listening");
		if (state === "speaking" || state === "responding")
			this.events.onStatus("speaking");
		const caption = applyVoiceCaptionDelta(this.streamingCaption, raw);
		this.trackProtocolRecognition(
			state !== null || (caption !== null && caption !== this.streamingCaption),
		);
		if (caption && caption !== this.streamingCaption) {
			this.streamingCaption = caption;
			const visible = visibleVoiceCaption(caption, {
				messageIds: this.internalCaptionMessageIds,
				texts: this.internalCaptionTexts,
			});
			if (this.opening.phase === "awaiting") {
				// Drop every user caption until the first real question has
				// finished. Bootstrap acknowledgments are not that question.
				if (visible?.role === "user") {
					this.logWire({
						dir: "in",
						kind: "caption",
						captionId: visible.id,
						role: "user",
						text: visible.text,
						drop: "awaiting-user",
					});
					return;
				}
				if (!visible && caption.role === "user") {
					this.logWire({
						dir: "in",
						kind: "caption",
						captionId: caption.id,
						role: "user",
						text: caption.text,
						drop: "internal",
					});
					return;
				}
				if (visible?.role === "assistant" && visible.text) {
					this.assistantTurnSeen = true;
					this.openingAssistantCaption = visible;
					this.applyOpening(
						reduceVoiceOpening(this.opening, {
							type: "assistant-text",
							text: visible.text,
						}),
					);
					// A transcript may arrive after `listening`. Restart the
					// settlement window for every delta; a late direct opening
					// cancels the pending phase-two trigger via `heardOpening`.
					this.scheduleOpeningTrigger();
					this.maybeInterruptPreamble(visible);
					const deduped = this.assistantCaptionForStage(visible);
					const shown = deduped
						? this.stageAssistantCaptionDuringOpening(deduped)
						: null;
					if (shown?.text) {
						this.openingCaptionShown = true;
						this.enableCommitteePlayback("announcement");
						const playable = this.captionForPlayback(shown);
						if (playable?.text) {
							this.logWire({
								dir: "in",
								kind: "caption",
								captionId: playable.id,
								role: "assistant",
								text: playable.text,
							});
							this.emitCaption(playable);
						}
					} else if (deduped) {
						this.logWire({
							dir: "in",
							kind: "caption",
							captionId: deduped.id,
							role: "assistant",
							text: deduped.text,
							drop: isDefenseOpeningCaption(deduped.text)
								? "preamble"
								: "filler",
						});
					} else {
						this.logWire({
							dir: "in",
							kind: "caption",
							captionId: visible.id,
							role: "assistant",
							text: visible.text,
							drop: "restart",
						});
					}
				}
				return;
			}
			if (!visible) {
				if (caption.role === "user") {
					this.logWire({
						dir: "in",
						kind: "caption",
						captionId: caption.id,
						role: "user",
						text: caption.text,
						drop: "internal",
					});
				}
				return;
			}
			if (!visible.text) return;
			if (visible.role === "user") {
				this.noteUserCaption(visible);
				if (
					!this.heardSubstantialUserAnswer &&
					isNoiseUserCaption(visible.text)
				) {
					this.noiseDroppedCount += 1;
					this.logWire({
						dir: "in",
						kind: "caption",
						captionId: visible.id,
						role: "user",
						text: visible.text,
						drop: "noise",
					});
					logger.info(
						`[viva] wire noise user caption dropped text=${JSON.stringify(wireTextPrefix(visible.text))}`,
					);
					return;
				}
				if (isSubstantialUserCaption(visible.text)) {
					this.heardSubstantialUserAnswer = true;
				}
				this.logWire({
					dir: "in",
					kind: "caption",
					captionId: visible.id,
					role: "user",
					text: visible.text,
				});
				this.emitCaption(visible);
				return;
			}
			const finalCaption = this.assistantCaptionForStage(visible);
			if (finalCaption?.text) {
				const playable = this.captionForPlayback(finalCaption);
				if (playable?.text) {
					this.logWire({
						dir: "in",
						kind: "caption",
						captionId: playable.id,
						role: "assistant",
						text: playable.text,
					});
					this.emitCaption(playable);
				}
			} else {
				this.logWire({
					dir: "in",
					kind: "caption",
					captionId: visible.id,
					role: "assistant",
					text: visible.text,
					drop: "restart",
				});
			}
		}
	}

	/**
	 * Duplicate-opening guard. The model sometimes answers the injected
	 * bootstrap twice: a rambling hybrid first, then a second message that
	 * re-announces the defense with a fresh question. Once an opening exists,
	 * any later message that re-announces gets its audio interrupted and its
	 * caption suppressed from the stage and the transcript.
	 */
	private assistantCaptionForStage(visible: VoiceCaption): VoiceCaption | null {
		if (this.suppressedAssistantMessageIds.has(visible.id)) return null;
		if (
			this.openingAnnouncementId !== null &&
			visible.id !== this.openingAnnouncementId &&
			(isDefenseRestartCaption(visible.text) ||
				(!this.heardSubstantialUserAnswer &&
					isFirstQuestionReaskCaption(visible.text)))
		) {
			this.suppressedAssistantMessageIds.add(visible.id);
			this.restartSuppressedCount += 1;
			logger.warn(
				"[viva] duplicate defense-opening announcement suppressed; interrupting committee audio",
			);
			this.interrupt();
			this.retractCaption(visible.id);
			return null;
		}
		if (
			this.openingAnnouncementId === null &&
			isCanonicalDefenseAnnouncementCaption(visible.text)
		) {
			this.openingAnnouncementId = visible.id;
			this.enableCommitteePlayback("announcement");
		}
		return visible;
	}

	private emitCaption(caption: VoiceCaption): void {
		this.emittedCaptionIds.add(caption.id);
		this.events.onCaption(caption);
	}

	private retractCaption(id: string): void {
		if (!this.emittedCaptionIds.has(id)) return;
		this.emittedCaptionIds.delete(id);
		this.events.onCaption({ id, role: "assistant", text: "" });
	}

	/**
	 * Recovery path for an unexpected acknowledgment-only first turn. The
	 * bootstrap normally asks the committee to open directly; when it ignores
	 * that rule, wait for the filler caption to settle before asking it to begin.
	 */
	private scheduleOpeningTrigger(): void {
		this.clearOpeningTriggerTimer();
		if (this.opening.phase !== "awaiting") return;
		if (this.opening.heardOpening || this.openingCaptionShown) return;
		if (this.openingTriggerSent || !this.assistantTurnSeen) return;
		if (
			!this.openingAssistantCaption?.text ||
			isCanonicalDefenseAnnouncementCaption(this.openingAssistantCaption.text)
		)
			return;
		if (
			this.opening.voiceState !== "listening" &&
			this.opening.voiceState !== "idle"
		)
			return;
		if (this.channel?.readyState !== "open") return;
		this.openingTriggerTimer = window.setTimeout(() => {
			this.openingTriggerTimer = null;
			this.maybeSendOpeningTrigger();
		}, OPENING_CAPTION_SETTLE_MS);
	}

	private maybeSendOpeningTrigger(): void {
		if (this.opening.phase !== "awaiting") return;
		if (this.opening.heardOpening || this.openingCaptionShown) return;
		if (this.openingTriggerSent || !this.assistantTurnSeen) return;
		if (
			!this.openingAssistantCaption?.text ||
			isCanonicalDefenseAnnouncementCaption(this.openingAssistantCaption.text)
		)
			return;
		if (
			this.opening.voiceState !== "listening" &&
			this.opening.voiceState !== "idle"
		)
			return;
		if (this.channel?.readyState !== "open") return;
		this.dispatchOpeningTrigger();
	}

	private dispatchOpeningTrigger(): void {
		if (this.opening.phase !== "awaiting") return;
		if (this.opening.heardOpening || this.openingTriggerSent) return;
		if (this.channel?.readyState !== "open") return;
		this.openingTriggerSent = true;
		const trigger = buildDefenseOpeningTrigger(this.openingLanguage);
		const messageId = crypto.randomUUID();
		this.internalCaptionMessageIds.add(messageId);
		this.internalCaptionTexts.push(trigger);
		this.channel.send(
			encodeVoiceEvent(buildVoiceRelayEvent(trigger, messageId)),
		);
		this.logWire({
			dir: "out",
			kind: "relay",
			drop: "internal",
			captionId: messageId,
			role: "user",
			text: trigger,
		});
		logger.info(
			"[viva] canonical opening recovery trigger dispatched after noncanonical response",
		);
		this.clearInitialAssistantTimer();
		this.initialAssistantTimer = window.setTimeout(() => {
			this.initialAssistantTimer = null;
			this.handleOpeningTimeout();
		}, OPENING_RECOVERY_TIMEOUT_MS);
	}

	private handleOpeningTimeout(): void {
		if (this.opening.phase === "open") return;
		if (this.opening.heardOpening) {
			this.applyOpening(reduceVoiceOpening(this.opening, { type: "timeout" }));
			return;
		}
		if (this.openingTriggerSent) {
			logger.warn(
				"[viva] canonical opening not received after recovery trigger",
			);
			this.fail(new VoiceDefenseError("openingTimeout"));
			return;
		}
		// Voice state is not trustworthy enough to prove that the old response
		// has ended. Interrupt unconditionally so a long preamble cannot leak
		// when the recovery turn begins.
		this.interrupt();
		this.dispatchOpeningTrigger();
	}

	/**
	 * Canary for silent upstream protocol changes: if nearly nothing we
	 * receive parses as a known event, the wire format probably moved — log
	 * loudly once so the failure is diagnosable from user logs instead of
	 * presenting as a mute committee.
	 */
	private trackProtocolRecognition(recognized: boolean): void {
		this.protocolMessageCount += 1;
		if (recognized) this.protocolRecognizedCount += 1;
		if (this.protocolDriftReported || this.protocolMessageCount < 30) return;
		const ratio = this.protocolRecognizedCount / this.protocolMessageCount;
		if (ratio < 0.1) {
			this.protocolDriftReported = true;
			logger.warn(
				`[viva] upstream protocol drift suspected: ${this.protocolRecognizedCount}/${this.protocolMessageCount} messages recognized`,
			);
		}
	}

	private applyMicrophoneState(): void {
		const enabled =
			!this.userMuted &&
			this.opening.phase === "open" &&
			this.microphoneSettled;
		for (const track of this.localStream?.getAudioTracks() ?? []) {
			track.enabled = enabled;
		}
	}

	private enableCommitteePlayback(reason: "announcement" | "gate"): void {
		if (this.committeePlaybackEnabled) return;
		this.committeePlaybackEnabled = true;
		this.applyRemotePlaybackState();
		logger.info(`[viva] wire committee playback enabled reason=${reason}`);
	}

	private captionForPlayback(caption: VoiceCaption): VoiceCaption | null {
		if (caption.role !== "assistant") return caption;
		if (!this.committeePlaybackEnabled && this.opening.phase !== "open") {
			return null;
		}
		return caption;
	}

	private applyRemotePlaybackState(): void {
		const enabled =
			this.committeePlaybackEnabled || this.opening.phase === "open";
		for (const track of this.remoteStream?.getAudioTracks() ?? []) {
			track.enabled = enabled;
		}
		this.events.onCommitteePlayback?.(enabled);
	}

	private stageAssistantCaptionDuringOpening(
		caption: VoiceCaption,
	): VoiceCaption | null {
		const canonical = visibleAssistantCaptionDuringOpening(caption);
		if (canonical) return canonical;
		if (
			this.committeePlaybackEnabled &&
			!isOpeningFillerCaption(caption.text)
		) {
			return caption;
		}
		return null;
	}

	private maybeInterruptPreamble(caption: VoiceCaption): void {
		if (this.opening.phase !== "awaiting") return;
		if (this.committeePlaybackEnabled || this.openingTriggerSent) return;
		if (isCanonicalDefenseAnnouncementCaption(caption.text)) return;
		const paraphrased = isDefenseAnnouncementCaption(caption.text);
		if (!paraphrased && !isDefenseOpeningCaption(caption.text)) return;
		const compact = caption.text
			.replace(/\s+/g, "")
			.replace(/[，。,.!！？?:：；;]/g, "")
			.trim();
		if (paraphrased) {
			if (compact.length < 6) return;
		} else if (compact.length < 16) {
			return;
		}
		if (this.interruptedPreambleIds.has(caption.id)) return;
		this.interruptedPreambleIds.add(caption.id);
		logger.info(
			"[viva] wire preamble without canonical announcement muted and interrupted",
		);
		this.interrupt();
	}

	private applyOpening(next: VoiceOpeningState): void {
		const wasOpen = this.opening.phase === "open";
		this.opening = next;
		if (next.heardOpening || next.phase === "open") {
			this.clearOpeningTriggerTimer();
		}
		if (next.phase === "open" && !wasOpen) {
			this.clearInitialAssistantTimer();
			this.openingOpenedAt = performance.now();
			this.scheduleMicrophoneOpen();
			this.enableCommitteePlayback("gate");
		}
		this.applyMicrophoneState();
		this.applyRemotePlaybackState();
	}

	private clearInitialAssistantTimer(): void {
		if (this.initialAssistantTimer === null) return;
		window.clearTimeout(this.initialAssistantTimer);
		this.initialAssistantTimer = null;
	}

	private clearOpeningTriggerTimer(): void {
		if (this.openingTriggerTimer === null) return;
		window.clearTimeout(this.openingTriggerTimer);
		this.openingTriggerTimer = null;
	}

	private scheduleMicrophoneOpen(): void {
		this.clearMicrophoneOpenTimer();
		this.microphoneSettled = false;
		this.microphoneOpenTimer = window.setTimeout(() => {
			this.microphoneOpenTimer = null;
			if (this.closing || this.opening.phase !== "open") return;
			this.microphoneSettled = true;
			if (this.openingOpenedAt !== null) {
				this.unmuteDelayMs = Math.round(
					performance.now() - this.openingOpenedAt,
				);
			}
			this.applyMicrophoneState();
			logger.info(
				`[viva] wire microphone enabled after settle delay_ms=${MICROPHONE_OPEN_SETTLE_MS}`,
			);
		}, MICROPHONE_OPEN_SETTLE_MS);
	}

	private clearMicrophoneOpenTimer(): void {
		if (this.microphoneOpenTimer === null) return;
		window.clearTimeout(this.microphoneOpenTimer);
		this.microphoneOpenTimer = null;
	}

	private resetWireSession(): void {
		this.clearMicrophoneOpenTimer();
		this.heardSubstantialUserAnswer = false;
		this.microphoneSettled = false;
		this.committeePlaybackEnabled = false;
		this.interruptedPreambleIds.clear();
		this.wireStartedAt = performance.now();
		this.openingOpenedAt = null;
		this.unmuteDelayMs = null;
		this.firstUserCaptionPrefix = null;
		this.noiseDroppedCount = 0;
		this.restartSuppressedCount = 0;
	}

	private noteUserCaption(caption: VoiceCaption): void {
		if (this.firstUserCaptionPrefix !== null) return;
		this.firstUserCaptionPrefix = wireTextPrefix(caption.text);
	}

	private microphoneEnabled(): boolean {
		return (
			!this.userMuted && this.opening.phase === "open" && this.microphoneSettled
		);
	}

	private logWire(fields: {
		dir: "in" | "out";
		kind: "voice-state" | "caption" | "relay" | "interrupt";
		state?: string;
		captionId?: string;
		role?: VoiceCaption["role"];
		text?: string;
		textLen?: number;
		drop?: WireDropReason;
	}): void {
		const started = this.wireStartedAt || performance.now();
		if (this.wireStartedAt === 0) this.wireStartedAt = started;
		const parts = [
			`[viva] wire t=${Math.round(performance.now() - this.wireStartedAt)}`,
			`dir=${fields.dir}`,
			`kind=${fields.kind}`,
			`phase=${this.opening.phase}`,
			`voiceState=${this.opening.voiceState ?? "-"}`,
		];
		if (fields.state) parts.push(`state=${fields.state}`);
		if (fields.captionId) parts.push(`id=${fields.captionId.slice(0, 8)}`);
		if (fields.role) parts.push(`role=${fields.role}`);
		const textLen =
			fields.textLen ??
			(fields.text !== undefined
				? fields.text.replace(/\s+/g, " ").trim().length
				: undefined);
		if (textLen !== undefined) parts.push(`textLen=${textLen}`);
		if (fields.text) {
			parts.push(`text=${JSON.stringify(wireTextPrefix(fields.text))}`);
		}
		if (fields.drop) parts.push(`drop=${fields.drop}`);
		parts.push(`mic=${this.microphoneEnabled() ? 1 : 0}`);
		parts.push(`trigger=${this.openingTriggerSent ? 1 : 0}`);
		logger.debug(parts.join(" "));
	}

	private logWireSummary(): void {
		logger.info(
			`[viva] wire summary openingTriggerSent=${this.openingTriggerSent} firstUser=${JSON.stringify(this.firstUserCaptionPrefix ?? "")} noiseDropped=${this.noiseDroppedCount} restartSuppressed=${this.restartSuppressedCount} unmuteDelayMs=${this.unmuteDelayMs ?? "-"}`,
		);
	}

	private assertActive(): void {
		if (this.closing) throw new Error("Voice connection cancelled");
	}

	private scheduleConnectionFailure(
		code: "networkOffline" | "connectionLost",
		delay: number,
	): void {
		if (this.closing || this.terminalError) return;
		this.clearDisconnectTimer();
		this.disconnectTimer = window.setTimeout(() => {
			this.disconnectTimer = null;
			if (
				(code === "networkOffline" && navigator.onLine === false) ||
				this.peer?.connectionState === "disconnected" ||
				this.peer?.connectionState === "failed"
			) {
				this.fail(new VoiceDefenseError(code));
			}
		}, delay);
	}

	private clearDisconnectTimer(): void {
		if (this.disconnectTimer === null) return;
		window.clearTimeout(this.disconnectTimer);
		this.disconnectTimer = null;
	}

	private fail(error: VoiceDefenseError): void {
		if (this.closing || this.terminalError) return;
		this.terminalError = true;
		this.events.onStatus("error");
		this.events.onError(error);
		void this.close();
	}
}
