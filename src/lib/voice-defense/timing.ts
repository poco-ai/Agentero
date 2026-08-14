export type VoiceSessionActivity = "connecting" | "playback";

export type VoiceDefenseClosePhase =
	| "prepare"
	| "connecting"
	| "live"
	| "ending"
	| "ended"
	| "error";

/**
 * Resolve the immutable start timestamp for one voice session.
 *
 * The caller supplies `now` so the transition stays deterministic in tests.
 */
export function nextVoiceSessionStartedAt(
	current: Date | null,
	activity: VoiceSessionActivity,
	now: Date,
): Date | null {
	if (current) return current;
	return activity === "playback" ? now : null;
}

/**
 * Only a session that produced committee playback needs a debrief handoff.
 * Connection status and captions can arrive while the opening gate is still
 * closed, so they are not evidence that the user has entered the defense.
 */
export function shouldHandoffVoiceSession(
	phase: VoiceDefenseClosePhase,
	startedAt: Date | null,
): boolean {
	return startedAt !== null && (phase === "live" || phase === "error");
}
