/**
 * What the PDF-bar compile control should show.
 *
 * The store keeps the last result so the problems list can render it. The
 * button must not: a finished, failed, or cancelled build stops the spinner
 * immediately, and success is only a short flash after a run that was actually
 * in progress.
 */

import { dirnameOf, normalizePath } from "@/lib/core/path";
import type { TexBuildSnapshot } from "@/lib/tex/build-state";

/** How long the compile button shows success before returning to idle. */
export const COMPILE_SUCCESS_FLASH_MS = 1600;

export type CompileButtonPhase = "idle" | "running" | "succeeded" | "failed";

/** Idle, or the brief success flash. Failure uses the problems button. */
export type CompileButtonDisplay = "idle" | "running" | "succeeded";

/**
 * True when `compilingPath` is this project's root or a file inside its
 * directory. `compilingPath` is the file the user acted on, which may be a
 * child of the root the build snapshot is keyed by.
 */
export function compileInvolvesRoot(
	compilingPath: string | null,
	rootFile: string,
): boolean {
	if (!compilingPath || !rootFile) return false;
	const compiling = normalizePath(compilingPath);
	const root = normalizePath(rootFile);
	if (compiling === root) return true;
	const rootDir = dirnameOf(root);
	return rootDir.length > 0 && compiling.startsWith(`${rootDir}/`);
}

/**
 * Store truth for one root.
 *
 * A terminal snapshot wins over a `compilingPath` that has not been cleared
 * yet, so the spinner cannot outlive success, failure, or cancel. A path set
 * for this root with no snapshot yet (the click landed, `beginTexBuild` has
 * not run) is already running.
 */
export function compileButtonPhase(input: {
	compilingPath: string | null;
	rootFile: string;
	status?: TexBuildSnapshot["status"];
}): CompileButtonPhase {
	const status = input.status;
	const mine = compileInvolvesRoot(input.compilingPath, input.rootFile);
	const terminal =
		status === "succeeded" || status === "failed" || status === "cancelled";
	if (status === "running" || (mine && !terminal)) return "running";
	if (status === "failed") return "failed";
	if (status === "succeeded") return "succeeded";
	return "idle";
}

/** Button face. Failed and cancelled recover to idle; the problems button reports errors. */
export function compileButtonDisplay(
	phase: CompileButtonPhase,
	successFlash: boolean,
): CompileButtonDisplay {
	if (phase === "running") return "running";
	if (phase === "succeeded" && successFlash) return "succeeded";
	return "idle";
}

/** Flash only when a run that was on screen just succeeded. Mounting on an old success does not. */
export function shouldFlashCompileSuccess(
	previous: CompileButtonPhase,
	next: CompileButtonPhase,
): boolean {
	return previous === "running" && next === "succeeded";
}
