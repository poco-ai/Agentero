/**
 * TeX compile/PDF, translation split, citation jumps, and wiki navigation.
 */

import i18n from "@/i18n";
import type { CitationTarget } from "@/lib/agent/api";
import { resolvePdfCitation } from "@/lib/agent/api";
import {
	citationHrefFromWikiParts,
	cleanCitationHref,
	isAgentCitationHref,
	rewriteCitationHrefToPdf,
} from "@/lib/agent/citation-href";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { dirnameOf, normalizePath, normalizeSlashes } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import {
	detectPaperDirectory,
	localFileToArrayBuffer,
	paperDirFromPath,
} from "@/lib/paper";
import { isLibraryVirtualPath } from "@/lib/paper/api";
import {
	lookupAnnotationRef,
	paperAbsFromWikiTarget,
} from "@/lib/pdf/annotation-ref";
import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import {
	buildLayoutDocumentResult,
	getLayoutDocumentResult,
	layoutKindFromCitationFragment,
	mergeCaptionsIntoHosts,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import {
	beginPdfNavigation,
	cancelPdfNavigation,
	completePdfNavigation,
	type PdfNavigationIntent,
} from "@/lib/pdf/pending-pdf-page";
import { registerScrollSyncPair } from "@/lib/pdf/scroll-sync";
import {
	cancelScheduledTexAutoBuild,
	registerTexAutoBuildRunner,
} from "@/lib/tex/auto-build";
import { queueTexBuild } from "@/lib/tex/build-queue";
import { getTexProjectSettings } from "@/lib/tex/config";
import { tryOpenWritingSource } from "@/lib/tex/editor-navigation";
import { syncTexAfterBuild } from "@/lib/tex/synctex";
import { isTexLiveRootActive } from "@/lib/tex-live/session";
import {
	ensureLocalFsScope,
	joinVaultPath,
	vaultPathExists,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import { getVaultPath, refreshTree, vaultStore } from "@/lib/vault/store";
import {
	missingNotePath,
	newNoteMarkdown,
	normalizeVaultRel,
	type WikiNavTarget,
	wikiNavigationDestination,
} from "@/lib/wiki";
import { rebuildWikiAndNotify } from "@/lib/wiki/store";
import { dockHandle } from "@/lib/workspace/dock-registry";
import {
	getActiveTabId,
	getTabs,
	setActiveTabId,
	setTabs,
	updateTab,
} from "@/lib/workspace/store";
import { flushAllTextEditors } from "@/lib/workspace/text-editor-flush";
import {
	type PdfViewerHandle,
	pdfHandleFor,
	subscribePdfHandles,
} from "@/lib/workspace/viewer/pdf-viewer-registry";
import {
	cloneTabForSplit,
	closeTab,
	openPaper,
	openPath,
	openTab,
} from "./navigation";
import {
	basenameOf,
	createNotesSplitPane,
	createPlaceholderTab,
	createTranslationSplitPane,
	type DocTab,
	insertPlaceholderTab,
	patchTab,
	SPLIT_PANE_ID_MARKER,
	tabIdForPath,
	tabNotesEligible,
	translationSplitPlacement,
} from "./tabs";
import {
	compileTexFile,
	ensureTexEngines,
	resolveTexPdfPath,
	resolveTexRoot,
	texCompileStore,
} from "./tex-compile";
import { isTexPath, preferredModeForPath } from "./viewer";

function texPdfPaneId(pdfPath: string): string {
	const matches = getTabs().filter(
		(tab) =>
			tab.mode === "pdf" && normalizePath(tab.path) === normalizePath(pdfPath),
	);
	return (
		matches.find((tab) => tab.id === getActiveTabId())?.id ??
		matches.find((tab) => tab.id === tabIdForPath(pdfPath))?.id ??
		matches[0]?.id ??
		tabIdForPath(pdfPath)
	);
}

function updateTexPdfPanes(pdfPath: string, patch: Partial<DocTab>): void {
	for (const tab of getTabs()) {
		if (
			(tab.mode === "pdf" || tab.mode === "translation") &&
			normalizePath(tab.path) === normalizePath(pdfPath)
		)
			updateTab(tab.id, patch);
	}
}

/**
 * Open (or refresh) the compiled PDF of a .tex file as a right split of its
 * editor pane — the TeX analogue of the paper→NOTES right split. The PDF is
 * the project ROOT's output (magic comment → self indicator → vault
 * \input/\include reverse scan → the file itself), so triggering this from a
 * child file still builds and shows the root's PDF. When the PDF is missing
 * on disk (or `forceCompile` is requested), the pane opens
 * immediately with a shimmer placeholder while the compile runs, then fills
 * in. Existing PDF tabs are refreshed in place (new bytes identity reloads
 * EmbedPDF) and activated.
 */
export async function openTexPdf(
	texPath: string,
	opts?: {
		referencePanelId?: string | null;
		forceCompile?: boolean;
		buildMode?: "normal" | "force" | "clean";
		/** Compile and View PDF leave live preview. Pass false to keep it (⌘\\). */
		exitLive?: boolean;
	},
): Promise<void> {
	if (!isTexPath(texPath)) return;
	try {
		const root = await resolveTexRoot(texPath);
		await queueTexBuild(
			root,
			() => openTexPdfNow(texPath, opts),
			opts?.buildMode ? 3 : 2,
		);
	} catch (error) {
		notifyError(errorText(error));
	}
}

async function openTexPdfNow(
	texPath: string,
	opts?: {
		referencePanelId?: string | null;
		forceCompile?: boolean;
		buildMode?: "normal" | "force" | "clean";
		exitLive?: boolean;
	},
): Promise<void> {
	const keepLive = opts?.exitLive === false;
	// One in-flight compile at a time (mirrors compileTexFile's guard).
	if (texCompileStore.getState().compilingPath) return;

	// Locate the reference editor panel (handles ::pane-N clones); open the
	// editor first when it is not on screen so the PDF lands beside it.
	const canonicalTexId = tabIdForPath(texPath);
	const refId =
		opts?.referencePanelId ??
		getTabs().find(
			(t) =>
				t.id === canonicalTexId ||
				t.id.startsWith(`${canonicalTexId}${SPLIT_PANE_ID_MARKER}`),
		)?.id ??
		null;
	if (!refId) {
		// openTab creates the dockview panel synchronously, so the id below
		// resolves immediately.
		openTab(texPath, { preferMode: "text" });
	}
	const referencePanelId = refId ?? canonicalTexId;

	// Flush every mounted editor's debounced autosave first (a root compile
	// must read the latest bytes of all its sections — the saveAll
	// equivalent), then resolve the root from that fresh disk state so a
	// just-typed magic comment or \input already counts. Both before the
	// fast path: the pane id must follow the root either way.
	await flushAllTextEditors();
	const rootPath = await resolveTexRoot(texPath);
	cancelScheduledTexAutoBuild(rootPath);
	const pdfPath = await resolveTexPdfPath(rootPath);
	if (!keepLive) {
		for (const tab of getTabs())
			if (
				tab.texLive &&
				normalizePath(tab.texRoot ?? "") === normalizePath(rootPath)
			)
				updateTab(tab.id, { texLive: false });
	}
	const pdfId = texPdfPaneId(pdfPath);
	await ensureLocalFsScope(vaultStore.getState().vaultPath);

	if (!opts?.forceCompile) {
		// Fast path: the PDF is already on disk → open/refresh, no shimmer.
		const bytes = await localFileToArrayBuffer(pdfPath);
		if (bytes) {
			if (getTabs().some((t) => t.id === pdfId)) {
				updateTexPdfPanes(pdfPath, {
					pdfBytes: bytes,
					loaded: true,
					texCompiling: false,
					texRoot: rootPath,
					...(keepLive ? {} : { texLive: false }),
					title: basenameOf(pdfPath),
				});
				setActiveTabId(pdfId);
				dockHandle()?.activatePanel(pdfId);
			} else {
				openTab(pdfPath, {
					preferMode: "pdf",
					placement: { direction: "right", referencePanelId },
				});
				updateTexPdfPanes(pdfPath, { texRoot: rootPath });
			}
			return;
		}
	}

	// Show the PDF pane immediately as a shimmer placeholder, then fill it
	// once the compile lands.
	const paneAlreadyOpen = getTabs().some((t) => t.id === pdfId);
	if (paneAlreadyOpen) {
		updateTexPdfPanes(pdfPath, {
			texCompiling: true,
			texLive: false,
			texRoot: rootPath,
		});
		setActiveTabId(pdfId);
		dockHandle()?.activatePanel(pdfId);
	} else {
		// Hand-rolled openTab prefix (placeholder + dock placement) without
		// the async resource load — the PDF does not exist yet, so
		// loadTabResources would only surface a cannotPreview error.
		const beforeTabs = getTabs();
		const { tabs: nextTabs, id: insertedId } = insertPlaceholderTab(
			beforeTabs,
			pdfPath,
			"pdf",
		);
		const placeholder =
			nextTabs.find((t) => t.id === insertedId) ??
			createPlaceholderTab(pdfPath, "pdf");
		setTabs(nextTabs);
		setActiveTabId(insertedId);
		dockHandle()?.openPanel(placeholder, {
			direction: "right",
			referencePanelId,
		});
		updateTab(insertedId, { texCompiling: true, texRoot: rootPath });
	}

	const compiled = await compileTexFile(rootPath, {
		triggerPath: texPath,
		...(opts?.buildMode ? { mode: opts.buildMode } : {}),
	});
	const bytes = compiled ? await localFileToArrayBuffer(compiled) : null;
	if (!compiled || !bytes) {
		// Failure already notified. Drop a pane we just created (it would sit
		// on a shimmer forever); just un-flag a pre-existing one so it shows
		// its previous content again.
		if (paneAlreadyOpen) updateTexPdfPanes(pdfPath, { texCompiling: false });
		else closeTab(pdfId, { remember: false });
		if (compiled) {
			// The compile itself succeeded but its output could not be read
			// back (fs scope / file vanished). Say so — a silent revert behind
			// the success toast reads as "the PDF did not update".
			notifyError(
				i18n.t("app:errors.pdfReadFailed", { name: basenameOf(pdfPath) }),
			);
		}
		return;
	}
	updateTexPdfPanes(pdfPath, {
		pdfBytes: bytes,
		loaded: true,
		texCompiling: false,
		texRoot: rootPath,
		...(keepLive ? {} : { texLive: false }),
		title: basenameOf(pdfPath),
	});
	void syncTexAfterBuild(
		rootPath,
		compiled,
		getTexProjectSettings(rootPath).syncAfterBuild,
	);
}

/**
 * Leave live preview and show the PDF already on disk. Does not run latexmk.
 * With no PDF yet, the pane stays on the empty preview state.
 */
export async function closeTexLive(texPath: string): Promise<void> {
	if (!isTexPath(texPath)) return;
	const rootPath = await resolveTexRoot(texPath);
	for (const tab of getTabs()) {
		if (
			!tab.texLive ||
			normalizePath(tab.texRoot ?? "") !== normalizePath(rootPath)
		)
			continue;
		const bytes = tab.pdfBytes ?? (await localFileToArrayBuffer(tab.path));
		updateTab(tab.id, {
			texLive: false,
			texCompiling: false,
			...(bytes ? { pdfBytes: bytes, loaded: true } : {}),
		});
	}
}

/**
 * Open the real-time rtex preview for a .tex project. The pane reuses the
 * compiled PDF tab identity (root output path) and flips `texLive`, so the
 * editor + live preview split behaves exactly like the existing PDF split.
 * The session itself starts inside the viewer, which also feeds the editor
 * buffers into it (`set_document`).
 */
export async function openTexLive(texPath: string): Promise<void> {
	if (!isTexPath(texPath) || !isTauri()) return;
	const status = await commands.rtexStatus();
	if (!status.ok || !status.data?.available) {
		notifyError(
			status.error?.message ??
				status.data?.error ??
				i18n.t("sidebar:fileTree.livePreviewUnavailable"),
		);
		return;
	}

	// The live session reads disk once, then the viewer syncs every mounted
	// editor buffer over it; flushing first keeps the very first layout close
	// to what the user sees.
	await flushAllTextEditors();
	const rootPath = await resolveTexRoot(texPath);
	const vaultPath = vaultStore.getState().vaultPath;
	if (!vaultPath) return;

	const pdfPath = await resolveTexPdfPath(rootPath);
	const pdfId = tabIdForPath(pdfPath);
	const editorId = tabIdForPath(texPath);
	const referencePanelId =
		getTabs().find(
			(t) =>
				t.id === editorId ||
				t.id.startsWith(`${editorId}${SPLIT_PANE_ID_MARKER}`),
		)?.id ?? editorId;
	if (!getTabs().some((t) => t.id === referencePanelId)) {
		openTab(texPath, { preferMode: "text" });
	}

	const existing = getTabs().find((t) => t.id === pdfId);
	if (existing) {
		updateTab(pdfId, {
			texLive: true,
			texRoot: rootPath,
			loaded: true,
			texCompiling: false,
		});
		setActiveTabId(pdfId);
		dockHandle()?.activatePanel(pdfId);
		return;
	}

	// Hand-rolled placeholder: the live pane does not need a PDF read, and a
	// missing first PDF must not surface as "cannot preview".
	const { tabs: nextTabs, id } = insertPlaceholderTab(
		getTabs(),
		pdfPath,
		"pdf",
	);
	const placeholder =
		nextTabs.find((t) => t.id === id) ?? createPlaceholderTab(pdfPath, "pdf");
	setTabs(nextTabs);
	setActiveTabId(id);
	dockHandle()?.openPanel(placeholder, {
		direction: "right",
		referencePanelId,
	});
	updateTab(id, {
		texLive: true,
		texRoot: rootPath,
		loaded: true,
		texCompiling: false,
		title: basenameOf(pdfPath),
	});
}

/**
 * Quiet TeX compile + in-place refresh of the open PDF pane. Called after
 * a manual ⌘S save lands (`compileTexOnManualSave`). The build target is the
 * project ROOT (saving a child recompiles the root and refreshes the root's
 * PDF pane), resolved after flushing every mounted editor — ⌘S only guaranteed
 * the triggered file on disk. The pane's shimmer (`texCompiling`) stays up
 * while latexmk runs so partial watcher writes never flash through; triggers
 * landing mid-compile queue a single trailing run with the latest path
 * (re-resolving the root against the then-current disk state).
 */
export async function compileTexOnSave(texPath: string): Promise<void> {
	try {
		const root = await resolveTexRoot(texPath);
		await queueTexBuild(root, () => compileTexAndRefreshNow(texPath));
	} catch (error) {
		notifyError(errorText(error));
	}
}

/** Explicit build refreshes existing previews without changing the active file or pane. */
export async function compileTexProject(
	texPath: string,
	mode: "normal" | "force" | "clean" = "normal",
): Promise<void> {
	if (!isTexPath(texPath)) return;
	try {
		const root = await resolveTexRoot(texPath);
		await queueTexBuild(
			root,
			() => compileTexAndRefreshNow(texPath, { explicit: true, mode }),
			3,
		);
	} catch (error) {
		notifyError(errorText(error));
	}
}

async function compileTexAndRefreshNow(
	texPath: string,
	options?: { explicit: boolean; mode: "normal" | "force" | "clean" },
): Promise<void> {
	// Right after a window reload the detection scan may still be in flight:
	// wait for it instead of silently dropping this trigger.
	await ensureTexEngines();
	const { engines, selectedEngine, compilingPath } = texCompileStore.getState();
	if (compilingPath) return;
	await flushAllTextEditors();
	const rootPath = await resolveTexRoot(texPath);
	// Recipes belong to the resolved project, including saves from child files.
	if (
		!selectedEngine &&
		engines.length === 0 &&
		!getTexProjectSettings(rootPath).recipe
	) {
		if (options?.explicit)
			notifyError(i18n.t("sidebar:fileTree.noLatexEngine"));
		return;
	}
	cancelScheduledTexAutoBuild(rootPath);
	const pdfPath = await resolveTexPdfPath(rootPath);
	const pdfId = texPdfPaneId(pdfPath);
	// Save-triggered builds leave live preview alone. An explicit build exits
	// live mode and refreshes the compiled bytes in place, without activation.
	if (
		!options?.explicit &&
		(isTexLiveRootActive(rootPath) ||
			getTabs().find((t) => t.id === pdfId)?.texLive)
	)
		return;
	if (options?.explicit) {
		for (const tab of getTabs()) {
			if (
				tab.texLive &&
				normalizePath(tab.texRoot ?? "") === normalizePath(rootPath)
			)
				updateTab(tab.id, { texLive: false });
		}
	}
	const paneOpen = getTabs().some((t) => t.id === pdfId);
	if (paneOpen)
		updateTexPdfPanes(pdfPath, {
			texCompiling: true,
			texLive: false,
			texRoot: rootPath,
		});
	try {
		const compiled = await compileTexFile(rootPath, {
			...(!options?.explicit ? { quietSuccess: true } : {}),
			triggerPath: texPath,
			...(options ? { mode: options.mode } : {}),
		});
		const bytes = compiled ? await localFileToArrayBuffer(compiled) : null;
		if (!compiled || !bytes) {
			// Drop the shimmer on the previous content; compileTexFile has reported
			// the failure (a toast, or the focused project's problems button).
			if (paneOpen) updateTexPdfPanes(pdfPath, { texCompiling: false });
			if (compiled) {
				notifyError(
					i18n.t("app:errors.pdfReadFailed", { name: basenameOf(pdfPath) }),
				);
			}
			return;
		}
		updateTexPdfPanes(pdfPath, {
			pdfBytes: bytes,
			loaded: true,
			texCompiling: false,
			texLive: false,
			texRoot: rootPath,
			title: basenameOf(pdfPath),
		});
		void syncTexAfterBuild(
			rootPath,
			compiled,
			getTexProjectSettings(rootPath).syncAfterBuild,
		);
	} finally {
		if (paneOpen) updateTexPdfPanes(pdfPath, { texCompiling: false });
	}
}

/**
 * ⌘S manual-save trigger for text tabs: compile the .tex once its save landed
 * (the editor flushes before calling this). Unlike the quiet path this
 * surfaces a missing engine — the user explicitly asked to build. Non-TeX
 * paths are a no-op (⌘S on them just saved).
 */
export async function compileTexOnManualSave(path: string): Promise<void> {
	if (!isTexPath(path)) return;
	await ensureTexEngines();
	const { engines, selectedEngine } = texCompileStore.getState();
	const root = await resolveTexRoot(path);
	if (
		!selectedEngine &&
		engines.length === 0 &&
		!getTexProjectSettings(root).recipe
	) {
		notifyError(i18n.t("sidebar:fileTree.noLatexEngine"));
		return;
	}
	await compileTexOnSave(path);
}

registerTexAutoBuildRunner(compileTexOnSave);

/** Obsidian-style Split pane: add a right pane and keep columns evenly sized. */
export function splitActivePane(): void {
	const id = getActiveTabId();
	if (!id) return;
	const tabs = getTabs();
	const active = tabs.find((t) => t.id === id);
	if (!active) return;
	// Library is the resident singleton — never clone it into a second pane.
	if (isLibraryVirtualPath(active.path)) return;

	// TeX editor ⌘\ → open/refresh its compiled PDF as the right split.
	if (isTexPath(active.path)) {
		void openTexPdf(active.path, {
			referencePanelId: active.id,
			exitLive: false,
		});
		return;
	}

	const notesId = active.notesPath ? tabIdForPath(active.notesPath) : null;
	const shouldOpenDefaultNotes =
		tabNotesEligible(active) &&
		Boolean(active.notesPath) &&
		notesId != null &&
		!tabs.some((t) => t.id === notesId);

	if (shouldOpenDefaultNotes) {
		const notesPane = createNotesSplitPane(active);
		if (!notesPane) return;
		setTabs((prev) =>
			prev.some((t) => t.id === notesPane.id) ? prev : [...prev, notesPane],
		);
		dockHandle()?.splitPanelRight(notesPane, active.id);
		setActiveTabId(notesPane.id);
		return;
	}

	const splitPane = cloneTabForSplit(active, tabs);
	setTabs((prev) => [...prev, splitPane]);
	dockHandle()?.splitPanelRight(splitPane, active.id);
	setActiveTabId(splitPane.id);
}

/**
 * Open a rendered-translation panel to the right of the referenced paper panel.
 * When dual-pane translation is enabled, the full-document translate button
 * calls this after kicking off the layout translation job.
 */
export function openTranslationTab(
	paperTabId: string,
	paperAbsPath: string | null,
): void {
	if (!paperAbsPath) return;
	const tabs = getTabs();
	// The caller passes the viewer's document id; bytes-backed viewers suffix a
	// per-buffer revision (`tab::r<n>`), so fall back to the stripped form.
	const paperTab =
		tabs.find((t) => t.id === paperTabId) ??
		tabs.find((t) => t.id === stripEmbedPdfRevision(paperTabId));
	if (!paperTab) return;
	paperTabId = paperTab.id;

	const existing = tabs.find(
		(t) => t.id === `${tabIdForPath(paperAbsPath)}::translation`,
	);
	if (existing) {
		// Restored/reused translation tabs do not pass through the creation path;
		// re-bind the two PDF documents every time the source opens translation.
		registerScrollSyncPair(paperTabId, existing.id);
		dockHandle()?.activatePanel(existing.id);
		return;
	}

	const translationPane = createTranslationSplitPane(paperTab);
	if (!translationPane) return;
	registerScrollSyncPair(paperTabId, translationPane.id);
	// Re-use the source pane's in-memory layout result so the translation pane
	// does not have to re-read the sidecar or re-run layout analysis.
	const sourceLayout = getLayoutDocumentResult(paperTabId);
	if (sourceLayout) {
		setLayoutDocumentResult({
			...sourceLayout,
			documentId: translationPane.id,
		});
	} else if (paperAbsPath) {
		// The source pane hasn't finished writing its result yet (rare race when
		// the user clicks translate immediately after opening the paper). Read the
		// sidecar asynchronously once it lands and seed the right pane so its auto-
		// start translation can begin without a manual layout re-run.
		void (async () => {
			const sidecar = await readLayoutSidecar(paperAbsPath);
			if (!sidecar) return;
			if (getLayoutDocumentResult(translationPane.id)) return;
			const result = buildLayoutDocumentResult(
				translationPane.id,
				mergeCaptionsIntoHosts([...sidecar.regions]),
				sidecar.regions,
			);
			setLayoutDocumentResult(result);
		})();
	}
	setTabs((prev) => [...prev, translationPane]);
	const notesPath = paperTab.notesPath;
	const notesPane = notesPath
		? tabs.find((tab) => tab.id === tabIdForPath(notesPath))
		: null;
	if (notesPane) {
		dockHandle()?.openPanel(translationPane, {
			direction: "within",
			referencePanelId: notesPane.id,
		});
	} else {
		dockHandle()?.splitPanelRight(
			translationPane,
			translationSplitPlacement(paperTabId, tabs).referencePanelId,
		);
	}
}

/**
 * If `href` carries a PDF citation fragment (`#page=` / `#section=` / …),
 * open via the shared citation jumper. Returns true when handled.
 */
export function tryOpenCitationHref(href: string): boolean {
	const trimmed = cleanCitationHref(href);
	if (!trimmed) return false;
	const rewritten = rewriteCitationHrefToPdf(trimmed);
	if (!isAgentCitationHref(trimmed) && !isAgentCitationHref(rewritten)) {
		return false;
	}
	openCitation(trimmed);
	return true;
}

/** Open a vault-relative path from backlinks (e.g. `notes/idea.md`). */
export function openVaultRel(rel: string): void {
	if (tryOpenCitationHref(rel)) return;
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForLinks"));
		return;
	}
	const clean = normalizeVaultRel(rel);
	openPath(joinVaultPath(vaultPath, clean));
}

/** POSIX `/…` or Windows `C:/…` path (callers normalize backslashes first). */
function isAbsoluteLocalPath(value: string): boolean {
	return value.startsWith("/") || /^[a-z]:\//i.test(value);
}

/**
 * True when `target` is a relative/absolute Vault path ending in `.html`.
 *
 * Absolute paths are accepted here; {@link openHtmlPreviewLink} still checks
 * that they live inside the active Vault. Agents routinely emit absolute
 * `/Users/.../report.html` links, and rejecting them silently did nothing.
 */
export function isLocalHtmlLink(target: string): boolean {
	const value = normalizeSlashes(target.trim().replace(/^<|>$/g, ""));
	if (!value || value.startsWith("#") || value.startsWith("//")) return false;
	// A Windows drive (`C:/…`) looks like a URL scheme; keep it local.
	if (!isAbsoluteLocalPath(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) {
		return false;
	}
	return /\.html?($|[?#])/i.test(value);
}

/**
 * Resolve `rel` against the directory of `fromFile` (CommonMark link rules).
 * `..` may climb, but never past the path root.
 */
function resolveLinkRelativeTo(fromFile: string, rel: string): string {
	let parent = dirnameOf(fromFile);
	for (const segment of rel.split(/[\\/]+/)) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			const next = dirnameOf(parent);
			if (next) parent = next;
			continue;
		}
		parent = joinVaultPath(parent, segment);
	}
	return parent;
}

function decodeLinkPath(rel: string): string {
	try {
		return decodeURIComponent(rel);
	} catch {
		return rel;
	}
}

/**
 * Open a local HTML file in a right-side split (#825).
 *
 * Relative destinations resolve against the source note first (as the Host
 * wiki resolver does for Markdown), then against the Vault root. `fromFile`
 * is null for chat links, which carry no source document. Absolute paths must
 * be inside the Vault; anything else is left to the caller.
 */
export async function openHtmlPreviewLink(
	source: string,
	fromFile?: string | null,
): Promise<boolean> {
	const trimmed = cleanCitationHref(source).trim();
	if (!isLocalHtmlLink(trimmed)) return false;
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForLinks"));
		return false;
	}
	const rel = decodeLinkPath(trimmed.split(/[?#]/, 1)[0]);
	const candidates: string[] = [];
	if (isAbsoluteLocalPath(normalizeSlashes(rel))) {
		const vaultRel = vaultRelativePath(vaultPath, rel);
		if (vaultRel === null) return false;
		candidates.push(joinVaultPath(vaultPath, vaultRel));
	} else {
		if (fromFile) candidates.push(resolveLinkRelativeTo(fromFile, rel));
		candidates.push(joinVaultPath(vaultPath, normalizeVaultRel(rel)));
	}

	let target = candidates[0];
	for (const candidate of candidates) {
		try {
			if (await vaultPathExists(candidate)) {
				target = candidate;
				break;
			}
		} catch {
			// Browser preview has no filesystem; fall through to the first candidate.
			break;
		}
	}
	openTab(target, {
		preferMode: "html",
		placement: { direction: "right", referencePanelId: null },
	});
	return true;
}

/** Graph: paper NOTES / paper folder → open paper (PDF + Notes). */
export function openGraphPath(rel: string): void {
	if (tryOpenCitationHref(rel)) return;
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForGraph"));
		return;
	}
	const clean = normalizeVaultRel(rel);
	const candidate = joinVaultPath(vaultPath, clean);
	// paperFolders are absolute paths from the file tree
	const paperAbs = paperDirFromPath(
		candidate,
		vaultStore.getState().paperFolders,
	);
	if (paperAbs) {
		openPaper(paperAbs);
		return;
	}
	// Collapsed graph node may already be the paper folder rel path
	void (async () => {
		if (await detectPaperDirectory(candidate)) {
			openPaper(candidate);
			return;
		}
		openVaultRel(clean);
	})();
}

/** Queue the latest resolved citation until the source viewer's layout is ready. */
export function scheduleCitationJump(
	paperAbs: string,
	target: CitationTarget,
	intent: PdfNavigationIntent = beginPdfNavigation(tabIdForPath(paperAbs)),
): void {
	completePdfNavigation(intent, {
		page: target.pageIndex + 1,
		region: {
			id: target.regionId,
			pageIndex: target.pageIndex,
			bbox: target.bbox,
			kind: layoutKindFromCitationFragment(target.fragment),
		},
	});
}

/** Short category toast for a failed citation resolve (e.g. figure / section). */
function citationResolveFailedMessage(source: string): string {
	const hash = source.indexOf("#");
	const frag = hash >= 0 ? source.slice(hash + 1) : "";
	const key = (frag.split("=")[0] ?? "").toLowerCase();
	switch (key) {
		case "figure":
			return i18n.t("agent:citation.figureNotFound", { source });
		case "section":
			return i18n.t("agent:citation.sectionNotFound", { source });
		case "table":
			return i18n.t("agent:citation.tableNotFound", { source });
		case "algorithm":
			return i18n.t("agent:citation.algorithmNotFound", { source });
		case "formula":
			return i18n.t("agent:citation.formulaNotFound", { source });
		case "page":
			return i18n.t("agent:citation.pageNotFound", { source });
		case "region":
			return i18n.t("agent:citation.regionNotFound", { source });
		default:
			return i18n.t("agent:citation.resolveFailed", { source });
	}
}

/**
 * Open a citation link from agent output.
 *
 * Plain vault paths open as documents. Links that point at a paper file and
 * carry a `#section=`, `#figure=`, `#page=`, or `#region=` fragment resolve
 * the fragment on the Host and jump the PDF viewer to the cited location.
 */
export function openCitation(source: string): void {
	const trimmed = rewriteCitationHrefToPdf(cleanCitationHref(source));
	if (!trimmed) return;
	if (/^https?:\/\//i.test(trimmed)) {
		openExternalUrl(trimmed);
		return;
	}
	// Local HTML opens in the built-in viewer beside the active pane (#825).
	if (isLocalHtmlLink(trimmed)) {
		void openHtmlPreviewLink(trimmed);
		return;
	}

	const fragmentIndex = trimmed.indexOf("#");
	const path = fragmentIndex >= 0 ? trimmed.slice(0, fragmentIndex) : trimmed;
	const fragment = fragmentIndex >= 0 ? trimmed.slice(fragmentIndex + 1) : "";
	if (tryOpenWritingSource(path, fragment)) return;
	if (!fragment) {
		// Prefer opening the paper unit for PDF paths; plain notes still use graph open.
		if (/\.pdf$/i.test(path)) {
			const vaultPath = getVaultPath();
			if (vaultPath) {
				const clean = normalizeVaultRel(path);
				const full = joinVaultPath(vaultPath, clean);
				const paperAbs =
					paperDirFromPath(full, vaultStore.getState().paperFolders) ?? null;
				if (paperAbs) {
					openPaper(paperAbs);
					return;
				}
			}
		}
		openGraphPath(path);
		return;
	}

	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForGraph"));
		return;
	}

	const clean = normalizeVaultRel(path);
	const full = joinVaultPath(vaultPath, clean);
	const paperAbs =
		paperDirFromPath(full, vaultStore.getState().paperFolders) ?? null;

	if (!paperAbs) {
		// Reserve before detection as well: A/B clicks can resolve out of order.
		const intent = beginPdfNavigation(tabIdForPath(full));
		void (async () => {
			if (await detectPaperDirectory(full)) {
				openPaper(full);
				void resolvePdfCitation(vaultPath, trimmed)
					.then((target) => scheduleCitationJump(full, target, intent))
					.catch((e) => {
						cancelPdfNavigation(intent);
						notifyError(citationResolveFailedMessage(trimmed));
						console.warn("resolve citation failed", e);
					});
				return;
			}
			cancelPdfNavigation(intent);
			notifyError(citationResolveFailedMessage(trimmed));
		})();
		return;
	}

	const intent = beginPdfNavigation(tabIdForPath(paperAbs));
	openPaper(paperAbs);
	void resolvePdfCitation(vaultPath, trimmed)
		.then((target) => scheduleCitationJump(paperAbs, target, intent))
		.catch((e) => {
			cancelPdfNavigation(intent);
			notifyError(citationResolveFailedMessage(trimmed));
			console.warn("resolve citation failed", e);
		});
}

let wikiNavigationIntentId = 0;

/** Wait for the PDF handle registration after openPaper, then jump. */
function scheduleAnnotationJump(paperAbs: string, annotationId: string): void {
	const tabId = tabIdForPath(paperAbs);
	let unsubscribe: (() => void) | null = null;
	let timeoutId: number | null = null;
	let finished = false;

	const finish = () => {
		if (finished) return false;
		finished = true;
		unsubscribe?.();
		if (timeoutId !== null) window.clearTimeout(timeoutId);
		return true;
	};

	const jump = (handle: PdfViewerHandle) => {
		if (!finish()) return;
		void lookupAnnotationRef(paperAbs, annotationId).then((ref) => {
			if (!ref) {
				notifyError(
					i18n.t("app:errors.wikiLinkInvalidFragment", {
						target: `@${annotationId}`,
					}),
				);
				return;
			}
			if (ref.kind === "visual" || ref.kind === "agent-trace") {
				handle.scrollToVisualTrace(ref.id);
			} else {
				handle.scrollToHighlight(ref.id);
			}
		});
	};

	const tryJump = () => {
		const handle = pdfHandleFor(tabId);
		if (handle) jump(handle);
	};

	tryJump();
	if (finished) return;
	unsubscribe = subscribePdfHandles(tryJump);
	timeoutId = window.setTimeout(() => {
		finish();
	}, 2000);
}

export async function navigateWiki(nav: WikiNavTarget): Promise<void> {
	const vaultPath = getVaultPath();
	// Invalid PDF anchors fail before opening/restoring an unrelated location.
	if (nav.status === "invalidFragment" && /\.pdf$/i.test(nav.path ?? "")) {
		notifyError(
			i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
		);
		return;
	}
	const destination = wikiNavigationDestination(nav);
	if (destination) {
		if (!vaultPath) {
			notifyError(i18n.t("app:errors.openVaultForLinks"));
			return;
		}
		// PDF / layout citation fragments (page=/section=/figure=/…) share the
		// agent citation jumper so editor wikilinks and markdown links behave alike.
		const citationHref = citationHrefFromWikiParts(
			destination.path,
			destination.fragment,
		);
		if (citationHref && tryOpenCitationHref(citationHref)) {
			return;
		}
		const full = joinVaultPath(vaultPath, normalizeVaultRel(destination.path));

		// Annotation fragments always open the paper PDF unit, not NOTES alone.
		if (destination.fragment?.kind === "annotation") {
			const paperAbs =
				paperDirFromPath(full, vaultStore.getState().paperFolders) ??
				paperAbsFromWikiTarget(vaultPath, destination.path);
			openPaper(paperAbs);
			const intent = {
				id: ++wikiNavigationIntentId,
				fragment: destination.fragment,
			};
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(paperAbs), {
					navigationIntent: intent,
				}),
			);
			if (destination.warning === "invalidFragment") {
				setTabs((previous) =>
					patchTab(previous, tabIdForPath(paperAbs), {
						navigationIntent: undefined,
					}),
				);
				notifyError(
					i18n.t("app:errors.wikiLinkInvalidFragment", {
						target: nav.targetRaw,
					}),
				);
				return;
			}
			scheduleAnnotationJump(paperAbs, destination.fragment.id);
			return;
		}

		openTab(full, { preferMode: preferredModeForPath(full) });
		if (destination.fragment) {
			const intent = {
				id: ++wikiNavigationIntentId,
				fragment: destination.fragment,
			};
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(full), { navigationIntent: intent }),
			);
		}
		if (destination.warning === "invalidFragment") {
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(full), {
					navigationIntent: undefined,
				}),
			);
			notifyError(
				i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
			);
		}
		return;
	}
	if (nav.status === "ambiguous") {
		notifyError(
			i18n.t("app:errors.wikiLinkAmbiguous", { target: nav.targetRaw }),
		);
		return;
	}
	if (nav.status === "invalidFragment") {
		notifyError(
			i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
		);
		return;
	}
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForCreate"));
		return;
	}
	if (/\.pdf$/i.test(nav.targetRaw)) {
		notifyError(
			i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
		);
		return;
	}
	const createRel = missingNotePath(nav.targetRaw);
	const ok = window.confirm(
		i18n.t("app:confirm.createNote", {
			target: nav.targetRaw,
			path: createRel,
		}),
	);
	if (!ok) return;

	const content = newNoteMarkdown(nav.targetRaw);
	const full = joinVaultPath(vaultPath, createRel);

	try {
		await writeVaultFile(full, content);
		await rebuildWikiAndNotify(vaultPath);
		await refreshTree(vaultPath);
		openPath(full);
	} catch (e) {
		notifyError(errorText(e));
	}
}
