/**
 * Subtle in-app audio cues.
 *
 * Synthesized with the Web Audio API so there are no assets to ship, no
 * licensing to track and no decode latency. Business code only calls
 * `playCue`; volume, throttling and context life stay here.
 *
 * Cues are intentionally sparse: an agent turn that finished, an agent that
 * wants the user, and a failed turn. Everything else is visual.
 */

import { getSettings } from "@/lib/settings/react-store";

export type SoundCue = "attention" | "done" | "error";

type Tone = { hz: number; at: number };
type Cue = {
	type: OscillatorType;
	/** Peak amplitude (0–1); kept low so cues sit under speech / music. */
	gain: number;
	/** Seconds a single note rings. */
	length: number;
	tones: Tone[];
};

const CUES: Record<SoundCue, Cue> = {
	// Two rising plucks — "I need you".
	attention: {
		type: "sine",
		gain: 0.12,
		length: 0.18,
		tones: [
			{ hz: 659.25, at: 0 },
			{ hz: 880, at: 0.13 },
		],
	},
	// Soft perfect fifth — "the turn landed".
	done: {
		type: "sine",
		gain: 0.1,
		length: 0.24,
		tones: [
			{ hz: 523.25, at: 0 },
			{ hz: 783.99, at: 0.1 },
		],
	},
	// Low fall — "something broke".
	error: {
		type: "triangle",
		gain: 0.09,
		length: 0.22,
		tones: [
			{ hz: 196, at: 0 },
			{ hz: 146.83, at: 0.12 },
		],
	},
};

/** Same cue never repeats inside this window (turn-end bursts). */
const CUE_GAP_MS = 1500;
/** Any two cues stay at least this far apart. */
const GLOBAL_GAP_MS = 300;

let ctx: AudioContext | null = null;
let audioOperation = Promise.resolve();
let activeTones = 0;
const lastByCue = new Map<SoundCue, number>();
let lastAny = 0;

function emit(context: AudioContext, cue: Cue): void {
	const start = context.currentTime + 0.01;
	for (const { hz, at } of cue.tones) {
		const osc = context.createOscillator();
		const gain = context.createGain();
		const noteStart = start + at;
		osc.type = cue.type;
		osc.frequency.value = hz;
		gain.gain.setValueAtTime(0.0001, noteStart);
		gain.gain.linearRampToValueAtTime(cue.gain, noteStart + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + cue.length);
		osc.connect(gain).connect(context.destination);
		osc.start(noteStart);
		osc.stop(noteStart + cue.length + 0.02);
		activeTones++;
		osc.onended = () => {
			if (--activeTones === 0) {
				audioOperation = audioOperation
					.then(() => (activeTones === 0 ? context.suspend() : undefined))
					.catch(() => undefined);
			}
		};
	}
}

/** Play one cue; silent no-op when sounds are off, throttled or not unlocked. */
export function playCue(cue: SoundCue): void {
	const context = ctx;
	if (!context) return;
	// Serialize device transitions so a cue can resume even as the previous one goes idle.
	audioOperation = audioOperation
		.then(async () => {
			const now = Date.now();
			if (now - (lastByCue.get(cue) ?? 0) < CUE_GAP_MS) return;
			if (now - lastAny < GLOBAL_GAP_MS || !getSettings().soundEnabled) return;
			try {
				if (context.state !== "running") await context.resume();
				if (context.state !== "running" || !getSettings().soundEnabled) return;
				emit(context, CUES[cue]);
				lastByCue.set(cue, now);
				lastAny = now;
			} finally {
				if (activeTones === 0 && context.state === "running") {
					await context.suspend();
				}
			}
		})
		.catch(() => undefined);
}

// Prime on the first user gesture so Host-driven cues (agent turn ended,
// permission requested) can play without a click of their own.
if (typeof window !== "undefined" && "AudioContext" in window) {
	const unlock = () => {
		if (
			!getSettings().soundEnabled ||
			navigator.userActivation?.isActive === false
		)
			return;
		const context = new AudioContext();
		ctx = context;
		audioOperation = context
			.resume()
			.then(() => context.suspend())
			.catch(() => undefined);
		window.removeEventListener("click", unlock, true);
		window.removeEventListener("keydown", unlock, true);
	};
	window.addEventListener("click", unlock, true);
	window.addEventListener("keydown", unlock, true);
}
