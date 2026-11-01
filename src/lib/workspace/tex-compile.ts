/**
 * LaTeX engine state and compile lifecycle for .tex files, kept in a lib-level
 * store so plain workspace actions (⌘\ split, tab buttons) can compile too —
 * not just the file-tree React hook. Mirrors the vaultStore vanilla-store
 * pattern; the hook stays a thin adapter.
 */

import { createStore } from "zustand/vanilla";
import i18n from "@/i18n";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { normalizePath } from "@/lib/core/path";
import { enqueueTaskSettled } from "@/lib/core/tasks";
import { startTexAutoBuild } from "@/lib/tex/auto-build";
import {
	beginTexBuild,
	ensureTexBuildEvents,
	finishTexBuild,
	texBuildStore,
} from "@/lib/tex/build-state";
import {
	explicitTexRoot,
	getTexProjectSettings,
	texBuildOptions,
} from "@/lib/tex/config";
import {
	chooseTexEngine,
	inferRequiredEngine,
	parseTexProgram,
	rememberedTexEngine,
} from "@/lib/tex/engine";
import { cleanLatexArtifacts, getLatexArtifacts } from "@/lib/tex/host";
import { readVaultFile } from "@/lib/vault/fs";
import { vaultStore } from "@/lib/vault/store";
import { texPdfPath } from "@/lib/workspace/viewer";

export type LatexEngine = {
	id: string;
	label: string;
	path: string | null;
};

type TexCompileState = {
	engines: LatexEngine[];
	enginesLoading: boolean;
	selectedEngine: string | null;
	compilingPath: string | null;
};

export const texCompileStore = createStore<TexCompileState>(() => ({
	engines: [],
	enginesLoading: false,
	selectedEngine: null,
	compilingPath: null,
}));

// Single-flight detection promise: callers can await it instead of racing
// the async result (compile right after a window reload used to read an
// empty list and falsely report "no engine").
let enginesPromise: Promise<void> | null = null;

/**
 * Detect engines (single-flight; concurrent callers share one invoke).
 * The promise is dropped when the scan fails or finds nothing, so the next
 * entry point retries instead of staying engine-less until a window reload.
 */
export function ensureTexEngines(): Promise<void> {
	if (!enginesPromise) {
		enginesPromise = (async () => {
			texCompileStore.setState({ enginesLoading: true });
			try {
				const res = await commands.detectLatexEngines();
				if (res.ok && res.data && res.data.length > 0) {
					texCompileStore.setState({ engines: res.data });
				} else {
					// Failed scan or engine-less host: allow a later retry (a
					// TeX install mid-session is picked up by the next compile).
					enginesPromise = null;
				}
			} catch {
				// Transient IPC failure (e.g. during window reload): retry later.
				enginesPromise = null;
			} finally {
				texCompileStore.setState({ enginesLoading: false });
			}
		})();
	}
	return enginesPromise;
}

/**
 * Kick off engine detection (idempotent; safe to call from every entry
 * point). Await `ensureTexEngines` when the result is needed.
 */
export function initTexEngines(): void {
	startTexAutoBuild();
	void ensureTexEngines();
}

export function selectTexEngine(id: string): void {
	texCompileStore.setState({ selectedEngine: id });
}

export type TexEngineChoice = {
	rootPath: string;
	engineId: string | null;
	/** Root file names an engine that is installed. The settings list stays put. */
	locked: boolean;
};

/** Engine for an already-resolved root file. */
export async function engineChoiceForRoot(
	rootPath: string,
): Promise<TexEngineChoice> {
	await ensureTexEngines();
	const available = texCompileStore
		.getState()
		.engines.map((engine) => engine.id);
	let source = "";
	try {
		source = await readVaultFile(rootPath);
	} catch {
		source = "";
	}
	const magic = parseTexProgram(source);
	return {
		rootPath,
		engineId: chooseTexEngine({
			magic,
			remembered: rememberedTexEngine(rootPath),
			required: inferRequiredEngine(source),
			available,
		}),
		locked: magic != null && available.includes(magic),
	};
}

/** Resolve the root, then the engine latexmk should call for it. */
export async function inspectTexEngine(
	texPath: string,
): Promise<TexEngineChoice> {
	const rootPath = await resolveTexRoot(texPath);
	return engineChoiceForRoot(rootPath);
}

export type TexRootResolution = {
	rootPath: string;
	/**
	 * Nothing tied the file to a document: no magic comment, no root
	 * indicator, no main file referencing it. Callers that list projects
	 * skip these; compilation still uses `rootPath`.
	 */
	fallbackSelf: boolean;
};

/**
 * Resolve the compile root for a .tex path: `% !TEX root` magic-comment chain
 * → self indicator (\documentclass / \begin{document}) → vault-wide reverse
 * \input/\include scan → the file itself. One IPC call over fresh disk state
 * (callers flush editors first, so a just-typed magic comment is visible);
 * falls back to `texPath` on any error so compilation still runs.
 */
export async function resolveTexRootInfo(
	texPath: string,
): Promise<TexRootResolution> {
	const override = explicitTexRoot(texPath);
	if (override) return { rootPath: override, fallbackSelf: false };
	try {
		const res = await commands.resolveLatexRoot(
			texPath,
			vaultStore.getState().vaultPath ?? "",
		);
		if (res.ok && res.data?.rootPath) {
			return {
				rootPath: res.data.rootPath,
				fallbackSelf: res.data.source === "fallbackSelf",
			};
		}
	} catch {
		// Transient IPC failure: callers still need a usable path.
	}
	return { rootPath: texPath, fallbackSelf: false };
}

export async function resolveTexRoot(texPath: string): Promise<string> {
	return (await resolveTexRootInfo(texPath)).rootPath;
}

/**
 * Clear the regenerable LaTeX intermediates (latexmk -c) for one source,
 * keeping the PDF. Escape hatch for latexmk's stuck state after a failed
 * run: its fingerprint database (`.fdb_latexmk`) records the error and,
 * with an unchanged source, it refuses to recompile ("Nothing to do …
 * gave an error in previous invocation"). Clearing the intermediates
 * resets that database so the next compile is a full run.
 *
 * Runs against the project's root file — the fdb database and aux set live
 * with the root, so clearing a child file's own name would be a no-op.
 */
export async function cleanTexAuxFiles(texPath: string): Promise<boolean> {
	// latexmk -c mid-compile would delete files the run is still writing.
	if (texCompileStore.getState().compilingPath) return false;
	const root = await resolveTexRoot(texPath);
	try {
		const build = texBuildOptions(root);
		if (build.outDir || build.auxDir || build.jobname || build.recipe) {
			await cleanLatexArtifacts(root, build);
			notifySuccess(i18n.t("sidebar:fileTree.cleanAuxSuccess"));
			return true;
		}
		const res = await commands.cleanLatexAuxFiles(root);
		if (!res.ok) {
			notifyError(
				res.error?.message || i18n.t("sidebar:fileTree.cleanAuxFailed"),
			);
			return false;
		}
		notifySuccess(i18n.t("sidebar:fileTree.cleanAuxSuccess"));
		return true;
	} catch (e) {
		notifyError(
			e instanceof Error && e.message
				? e.message
				: i18n.t("sidebar:fileTree.cleanAuxFailed"),
		);
		return false;
	}
}

// Roots whose problems button is on screen, counted per view.
const problemsViews = new Map<string, number>();

/**
 * Mark the problems button of `rootPath` as on screen until the returned
 * cleanup runs. A TeX project view calls this while it is focused, so a
 * failed compile of its root turns that button red instead of raising a
 * toast.
 */
export function showTexProblemsView(rootPath: string): () => void {
	const key = normalizePath(rootPath);
	problemsViews.set(key, (problemsViews.get(key) ?? 0) + 1);
	let shown = true;
	return () => {
		if (!shown) return;
		shown = false;
		const count = (problemsViews.get(key) ?? 1) - 1;
		if (count > 0) problemsViews.set(key, count);
		else problemsViews.delete(key);
	};
}

/**
 * Compile with the root file's engine (`% !TEX program`, else the engine
 * remembered for that project, else XeLaTeX). Runs as a background
 * job: the tasks panel shows live latexmk progress (rule / run milestones)
 * and a cancel button; `compilingPath` still drives the file-tree spinner.
 * Returns the absolute pdf path on success, else null.
 *
 * `texPath` is the compile ROOT (a `resolveTexRoot` product) — the job's
 * identity, dedupe key and output PDF all follow it. `triggerPath` marks the
 * file the user actually acted on, so the file-tree spinner stays on the
 * triggered row even when the build target is its root.
 *
 * `quietSuccess` skips the success toast (save-triggered compiles would spam
 * one per autosave). Failures notify, except while a focused TeX project view
 * shows this root (`showTexProblemsView`): its problems button turns red and
 * lists the errors instead.
 */
export async function compileTexFile(
	texPath: string,
	opts?: {
		quietSuccess?: boolean;
		triggerPath?: string;
		mode?: "normal" | "force" | "clean";
	},
): Promise<string | null> {
	initTexEngines();
	// Wait for the in-flight scan: reading the store immediately after a
	// window reload races detection and falsely reports "no engine".
	await ensureTexEngines();
	const { compilingPath } = texCompileStore.getState();
	if (compilingPath) return null;
	const choice = await engineChoiceForRoot(texPath);
	const engineId =
		choice.engineId ??
		(getTexProjectSettings(texPath).recipe ? "pdflatex" : null);
	if (!engineId) {
		notifyError(i18n.t("sidebar:fileTree.noLatexEngine"));
		return null;
	}
	// One in-flight compile at a time (prevents ⌘\ double-fire).
	if (texCompileStore.getState().compilingPath) return null;

	texCompileStore.setState({ compilingPath: opts?.triggerPath ?? texPath });
	const build = texBuildOptions(texPath, opts?.mode);
	try {
		await ensureTexBuildEvents();
		beginTexBuild(texPath);
		await enqueueTaskSettled({
			kind: "latexCompile",
			vaultPath: vaultStore.getState().vaultPath ?? "",
			path: texPath,
			lane: "focus",
			force: true,
			params: { engine: engineId, build },
		});
		finishTexBuild(texPath, "succeeded");
		if (!opts?.quietSuccess) {
			notifySuccess(i18n.t("sidebar:fileTree.compileSuccess"));
		}
		return (
			texBuildStore.getState().byRoot[normalizePath(texPath)]?.result
				?.pdfPath ?? (await resolveTexPdfPath(texPath))
		);
	} catch (e) {
		finishTexBuild(
			texPath,
			isBackgroundTaskCancelledError(e) ? "cancelled" : "failed",
			isBackgroundTaskCancelledError(e)
				? undefined
				: e instanceof Error
					? e.message
					: String(e),
		);
		if (
			!isBackgroundTaskCancelledError(e) &&
			!problemsViews.has(normalizePath(texPath))
		) {
			notifyError(
				e instanceof Error && e.message
					? e.message
					: i18n.t("sidebar:fileTree.compileFailed"),
			);
		}
		return null;
	} finally {
		texCompileStore.setState({ compilingPath: null });
	}
}

/** The host owns artifact layout (outDir/jobname), including custom recipes. */
export async function resolveTexPdfPath(rootPath: string): Promise<string> {
	const build = texBuildOptions(rootPath);
	try {
		return (await getLatexArtifacts(rootPath, build)).pdfPath;
	} catch (error) {
		if (build.outDir || build.auxDir || build.jobname || build.recipe)
			throw error;
		return texPdfPath(rootPath);
	}
}
