import type { JobKind } from "@/lib/core/bindings";
import type { SoundCue } from "@/lib/ui/sound";

/**
 * Audio for background jobs. Only full-document layout translation earns a
 * cue: it runs for minutes and finishes while the user is elsewhere. Every
 * other kind stays visual — those jobs are frequent and usually on screen.
 */
export function jobTerminalCue(
	event: "completed" | "failed",
	kind: JobKind,
): SoundCue | null {
	if (kind !== "layoutTranslate") return null;
	return event === "failed" ? "error" : "done";
}
