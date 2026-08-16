import type { VoiceCaption } from "@/lib/voice-defense/protocol";

/** ChatGPT TTS speaks Chinese at roughly 6–8 characters per second. */
export const CJK_CAPTION_CHARS_PER_SEC = 7;
/** ~170 wpm English, counting letters and spaces. */
export const LATIN_CAPTION_CHARS_PER_SEC = 16;
/** Follow live ASR when it grows by a small snapshot instead of a dump. */
export const CAPTION_STREAM_CATCHUP_CHARS = 12;

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9d]/g;

export function captionCharsPerSecond(text: string): number {
	if (!text) return CJK_CAPTION_CHARS_PER_SEC;
	const cjk = text.match(CJK_CHAR)?.length ?? 0;
	const ratio = cjk / text.length;
	return (
		CJK_CAPTION_CHARS_PER_SEC * ratio +
		LATIN_CAPTION_CHARS_PER_SEC * (1 - ratio)
	);
}

/**
 * How many characters should be on stage if speech started at `startedAtMs`.
 * A burst of ASR must not jump the visible end past the estimated mouth
 * position. The first glyph is shown immediately so the slot is not blank.
 */
export function pacedCaptionLength(input: {
	text: string;
	startedAtMs: number;
	nowMs: number;
	charsPerSec?: number;
	flush?: boolean;
	shown?: number;
}): number {
	if (input.flush || !input.text) return input.text.length;
	const shown = input.shown ?? 0;
	const arrived = input.text.length - shown;
	if (arrived > 0 && arrived <= CAPTION_STREAM_CATCHUP_CHARS) {
		return input.text.length;
	}
	const rate = input.charsPerSec ?? captionCharsPerSecond(input.text);
	const elapsedSec = Math.max(0, (input.nowMs - input.startedAtMs) / 1000);
	const spoken = Math.floor(elapsedSec * rate);
	const next = Math.min(input.text.length, Math.max(spoken, 1));
	return Math.max(shown, next);
}

export function slicePacedCaption(
	caption: VoiceCaption,
	length: number,
): VoiceCaption {
	if (length >= caption.text.length) return caption;
	return { ...caption, text: caption.text.slice(0, length) };
}

/**
 * Keeps the saved transcript authoritative and only throttles what the stage
 * shows. Committee text advances at speech rate from the first token (or an
 * earlier `speaking` mark). User captions and a finished turn flush immediately.
 */
/**
 * After the committee stops speaking, wait this long before flushing the
 * remaining caption text. Debounces transient speaking→listening→speaking
 * flickers that happen during normal voice-state negotiation.
 */
const IDLE_CATCHUP_MS = 400;

export class VoiceCaptionPacer {
	private readonly targets = new Map<string, VoiceCaption>();
	private readonly order: string[] = [];
	private readonly startedAt = new Map<string, number>();
	private readonly shown = new Map<string, number>();
	private readonly flushed = new Set<string>();
	private pendingSpeakingAt: number | null = null;
	private idleAt: number | null = null;

	reset(): void {
		this.targets.clear();
		this.order.length = 0;
		this.startedAt.clear();
		this.shown.clear();
		this.flushed.clear();
		this.pendingSpeakingAt = null;
		this.idleAt = null;
	}

	push(caption: VoiceCaption, nowMs: number): void {
		if (!caption.text.trim()) {
			this.retract(caption.id);
			return;
		}
		if (!this.targets.has(caption.id)) {
			this.order.push(caption.id);
			if (caption.role === "assistant") {
				this.flushOtherAssistants(caption.id);
				this.startedAt.set(caption.id, this.speechAnchor(caption, nowMs));
				this.pendingSpeakingAt = null;
				this.idleAt = null;
			} else {
				this.flushAssistants();
			}
		}
		this.targets.set(caption.id, caption);
		if (caption.role === "user") {
			this.flushed.add(caption.id);
			this.shown.set(caption.id, caption.text.length);
		}
	}

	/**
	 * Earliest evidence of when this caption's audio began: a speaking mark,
	 * or the caption's own first delta. A caption that was gated for seconds
	 * (opening confirmation, suppression windows) must not reveal from its
	 * first glyph while the voice is already mid-sentence.
	 */
	private speechAnchor(caption: VoiceCaption, nowMs: number): number {
		let anchor = nowMs;
		if (this.pendingSpeakingAt !== null) {
			anchor = Math.min(anchor, this.pendingSpeakingAt);
		}
		if (caption.firstDeltaAt !== undefined) {
			anchor = Math.min(anchor, caption.firstDeltaAt);
		}
		return anchor;
	}

	markSpeaking(nowMs: number): void {
		this.idleAt = null;
		const active = this.latestAssistantId();
		if (active && !this.startedAt.has(active)) {
			this.startedAt.set(active, nowMs);
		} else if (!active) {
			this.pendingSpeakingAt = nowMs;
		}
	}

	markIdle(nowMs: number): void {
		// Keep unused pendingSpeakingAt. Voice state often returns to
		// listening before the assistant transcript arrives; clearing the
		// mark made late ASR crawl from one glyph while audio was already
		// mid-sentence. A later markSpeaking still overwrites the clock.
		if (this.idleAt === null) {
			this.idleAt = nowMs;
		}
	}

	flushAll(): void {
		for (const id of this.targets.keys()) this.flushed.add(id);
	}

	tick(nowMs: number): VoiceCaption[] {
		if (this.idleAt !== null && nowMs - this.idleAt > IDLE_CATCHUP_MS) {
			const activeId = this.latestAssistantId();
			if (activeId) this.flushed.add(activeId);
		}
		const staged: VoiceCaption[] = [];
		for (const id of this.order) {
			const caption = this.targets.get(id);
			if (!caption) continue;
			if (caption.role === "user" || this.flushed.has(id)) {
				this.shown.set(id, caption.text.length);
				staged.push(caption);
				continue;
			}
			const startedAtMs = this.startedAt.get(id) ?? nowMs;
			const length = pacedCaptionLength({
				text: caption.text,
				startedAtMs,
				nowMs,
				shown: this.shown.get(id),
			});
			this.shown.set(id, length);
			staged.push(slicePacedCaption(caption, length));
		}
		return staged;
	}

	private retract(id: string): void {
		this.targets.delete(id);
		this.startedAt.delete(id);
		this.shown.delete(id);
		this.flushed.delete(id);
		const index = this.order.indexOf(id);
		if (index !== -1) this.order.splice(index, 1);
	}

	private latestAssistantId(): string | null {
		for (let index = this.order.length - 1; index >= 0; index -= 1) {
			const id = this.order[index];
			if (this.targets.get(id)?.role === "assistant") return id;
		}
		return null;
	}

	private flushAssistants(): void {
		for (const [id, caption] of this.targets) {
			if (caption.role === "assistant") this.flushed.add(id);
		}
	}

	private flushOtherAssistants(keepId: string): void {
		for (const [id, caption] of this.targets) {
			if (caption.role === "assistant" && id !== keepId) this.flushed.add(id);
		}
	}
}
