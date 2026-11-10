import { syntaxTree } from "@codemirror/language";
import {
	Compartment,
	EditorState,
	type Extension,
	type Text,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { addSelectionToChat } from "@/components/selection/add-selection-to-chat";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { useTextEditorFontSize } from "@/components/viewer/hooks/use-text-editor-font-size";
import { TexCitationPicker } from "@/components/viewer/tex-citation-picker";
import { textLanguageExtensions } from "@/components/viewer/text-editor-language";
import {
	type EditorDiagnostic,
	lintDiagnosticsWatcher,
	TextEditorLintFooter,
} from "@/components/viewer/text-editor-lint-footer";
import {
	editorChrome,
	editorColorScheme,
	editorHighlight,
	texCommentHighlight,
} from "@/components/viewer/text-editor-theme";
import { TextEditorToolbar } from "@/components/viewer/text-editor-toolbar";
import {
	armedTextEditorRange,
	useTextEditorSelection,
} from "@/components/viewer/use-text-editor-selection";
import {
	readTexReviewWidth,
	TEX_REVIEW_MAX_PX,
	TEX_REVIEW_MIN_PX,
	TexReviewPanel,
	writeTexReviewWidth,
} from "@/components/writing/tex-review-panel";
import { useWritingSelectionGroup } from "@/components/writing/writing-selection-group";
import { dirnameOf, normalizePath } from "@/lib/core/path";
import {
	addTexComment,
	commentFileKey,
	deleteTexComment,
	editTexComment,
	loadTexComments,
	relocateTexComments,
	replyTexComment,
	resolveTexComment,
	shiftTexComments,
	texCommentStore,
} from "@/lib/tex/comment-store";
import {
	attachComment,
	commentChatQuote,
	commentChatRecord,
	isCommentableTexPath,
	shiftComment,
	TEX_ADD_COMMENT_EVENT,
	type TexComment,
} from "@/lib/tex/comments";
import { texSettingsStore } from "@/lib/tex/config";
import { insertTexCitation } from "@/lib/tex/editor-intelligence";
import {
	editorLintStore,
	pendingEditorLineJump,
} from "@/lib/tex/editor-lint-bridge";
import {
	markTexEditorActive,
	registerTexEditor,
} from "@/lib/tex/editor-navigation";
import { latexFromClipboard } from "@/lib/tex/html-to-latex";
import { type TexOutlineItem, texOutlineFromTree } from "@/lib/tex/outline";
import { isInsideProject } from "@/lib/tex/project";
import {
	invalidateTexProjectIndex,
	loadTexProjectIndex,
	notifyTexProjectFilesChanged,
	registerTexProjectBuffer,
	subscribeTexProjectChanges,
} from "@/lib/tex/project-index";
import { syncTexToPdf } from "@/lib/tex/synctex";
import {
	registerTexLiveEditor,
	texLiveApplyUpdate,
	texLiveSetDocument,
} from "@/lib/tex-live/session";
import { dockHandle } from "@/lib/workspace/dock-registry";
import { setActiveTabId } from "@/lib/workspace/store";
import { tabIdForPath } from "@/lib/workspace/tabs";
import { bindTexOutline } from "@/lib/workspace/tex-outline-bridge";
import { registerTextEditorFlusher } from "@/lib/workspace/text-editor-flush";
import { isTexPath, textLanguageIdForPath } from "@/lib/workspace/viewer";
import { writingStore } from "@/lib/writing/store";

/** Toolbar paths are vault-relative; the editor prop is absolute. */
function sameTexFile(left: string, right: string): boolean {
	if (normalizePath(left) === normalizePath(right)) return true;
	return commentFileKey(left) === commentFileKey(right);
}

interface TextEditorProps {
	panelId?: string;
	seed: string;
	path: string;
	reloadKey: number;
	onPersist: (
		path: string,
		content: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange: (dirty: boolean) => void;
	/** Manual save (⌘S) after the flush landed — TeX compiles here. */
	onManualSave?: (path: string) => void;
	/** Whether the owning tab is the active panel — gates the selection toolbar. */
	active?: boolean;
	/** Which surface owns the live-preview buffer (reading dock vs writing). */
	texLiveOwner?: "reading" | "writing";
	/** Writing draws lint counts on the PDF bar. */
	hideLintFooter?: boolean;
	className?: string;
}

const AUTOSAVE_DELAY_MS = 800;

/**
 * Plain-text / code editor (CodeMirror 6) for the `text` fallback mode.
 * Same lifecycle contract as ExcalidrawViewer: React props seed the document
 * and signal external reloads (`reloadKey`); live content, dirty state and
 * debounced autosave are owned here and flow out via callbacks. Unlike the
 * Excalidraw viewer a reload swaps the document in place — view, scroll and
 * undo history are not thrown away.
 */
export function TextEditor({
	panelId,
	seed,
	path,
	reloadKey,
	onPersist,
	onDirtyChange,
	onManualSave,
	active = true,
	texLiveOwner = "reading",
	hideLintFooter = false,
	className,
}: TextEditorProps) {
	const [citationOpen, setCitationOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [showResolved, setShowResolved] = useState(false);
	const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
	const [draft, setDraft] = useState<{
		from: number;
		to: number;
		quote: string;
	} | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const commentCompartment = useRef(new Compartment());
	const threads = useStore(texCommentStore, (state) => state.threads);
	const fileKey = commentFileKey(path);
	const fileThreads = useMemo(
		() => threads.filter((thread) => thread.file === fileKey),
		[threads, fileKey],
	);
	const fileThreadsRef = useRef(fileThreads);
	fileThreadsRef.current = fileThreads;
	const openCommentCount = fileThreads.filter(
		(thread) => !thread.resolved,
	).length;
	// Font size managed by hook with process-wide persistence (like PDF paper tone).
	const { fontSize, setFontSize } = useTextEditorFontSize();

	// Follow the app theme (system / light / dark preference via next-themes).
	const { resolvedTheme } = useTheme();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const themeCompartment = useRef(new Compartment());
	const languageCompartment = useRef(new Compartment());
	const fontSizeCompartment = useRef(new Compartment());
	const lastSavedRef = useRef(seed);
	// PERF: pending edits are kept as the CodeMirror `Text` doc (a persistent
	// structure shared with the editor, zero-copy) — the string is
	// materialized once inside the debounced flush, not per keystroke.
	const pendingContentRef = useRef<Text | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const dirtyRef = useRef(false);
	// rtex replays full-buffer `set_document` on reload instead of diff edits.
	const texLiveReloadRef = useRef(false);

	// Latest seed for the reload effect without re-mounting the editor.
	const seedRef = useRef(seed);
	seedRef.current = seed;
	// Initial language/theme are read at mount; later changes go through the
	// reconfigure effects below (mounting must stay once-per-tab).
	const pathRef = useRef(path);
	pathRef.current = path;
	const themeRef = useRef(resolvedTheme);
	themeRef.current = resolvedTheme;
	const fontSizeRef = useRef(fontSize);
	fontSizeRef.current = fontSize;

	// Keep callbacks stable across parent re-renders (doc-view passes inline
	// arrows for `onDirtyChange`).
	const onDirtyChangeRef = useRef(onDirtyChange);
	onDirtyChangeRef.current = onDirtyChange;

	// True when disk is current after the flush (nothing pending, or the save
	// landed); false when the save was refused (conflict guard / write error).
	const flush = useCallback(async (): Promise<boolean> => {
		const doc = pendingContentRef.current;
		if (doc == null) return true;
		pendingContentRef.current = null;
		const content = doc.toString();
		const ok = await onPersist(path, content, lastSavedRef.current);
		if (ok) {
			lastSavedRef.current = content;
			dirtyRef.current = false;
			onDirtyChangeRef.current(false);
			notifyTexProjectFilesChanged([path]);
		}
		return ok;
	}, [onPersist, path]);

	const schedulePersist = useCallback(
		(doc: Text) => {
			pendingContentRef.current = doc;
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				void flush();
			}, AUTOSAVE_DELAY_MS);
		},
		[flush],
	);

	// The update listener is registered once at mount; route it through a ref
	// so a path change (rename) keeps saving to the current file.
	const schedulePersistRef = useRef(schedulePersist);
	schedulePersistRef.current = schedulePersist;

	// Manual save (⌘S / Ctrl+S) rides the CodeMirror keymap (only when the
	// editor is focused, same as its other bindings): flush immediately,
	// skipping the debounce, then fire the hook — the TeX path compiles there.
	// A clean buffer still fires it (explicit rebuild, Overleaf-style); a
	// refused save (conflict guard) does not — compiling the disk copy would
	// mislead. Routed through refs since the keymap registers once at mount.
	const flushRef = useRef(flush);
	flushRef.current = flush;
	const onManualSaveRef = useRef(onManualSave);
	onManualSaveRef.current = onManualSave;
	const manualSaveKeymap = useMemo(
		() => [
			{
				key: "Mod-Alt-j",
				run: (view: EditorView) => {
					if (!isTexPath(pathRef.current)) return false;
					const position = view.state.selection.main.head;
					const line = view.state.doc.lineAt(position);
					void syncTexToPdf(
						pathRef.current,
						line.number,
						position - line.from + 1,
						writingStore.getState().surface === "writing"
							? { scope: "writing" as const }
							: undefined,
					);
					return true;
				},
			},
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					void flushRef.current().then((ok) => {
						if (ok) onManualSaveRef.current?.(pathRef.current);
					});
					return true;
				},
			},
		],
		[],
	);

	// Selection → floating Quick chat / Add to chat toolbar (same chrome the
	// PDF surfaces have). The listener extension registers once at mount and
	// routes through refs inside the hook.
	const writingSelectionGroup = useWritingSelectionGroup();
	const selection = useTextEditorSelection({
		viewRef,
		path,
		active,
		selectionGroup: writingSelectionGroup,
	});

	// Lint diagnostics for the status-bar footer (TeX only — the only mode
	// with lint sources). The watcher extension registers once at mount and
	// pushes the merged findings after every lint run.
	const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
	const handleDiagnostics = useCallback((next: EditorDiagnostic[]) => {
		setDiagnostics(next);
	}, []);
	const hasLintSources = useMemo(
		() => textLanguageIdForPath(path) === "tex",
		[path],
	);
	const jumpToDiagnostic = useCallback((diagnostic: EditorDiagnostic) => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			selection: { anchor: diagnostic.from, head: diagnostic.to },
			scrollIntoView: true,
		});
		view.focus();
	}, []);
	const jumpToLine = useCallback((line: number) => {
		const view = viewRef.current;
		if (!view || line < 1) return;
		const info = view.state.doc.line(Math.min(line, view.state.doc.lines));
		view.dispatch({
			selection: { anchor: info.from },
			scrollIntoView: true,
		});
		view.focus();
	}, []);

	useEffect(() => {
		if (!hideLintFooter || !hasLintSources) return;
		editorLintStore.setState({
			current: { path, diagnostics, jump: jumpToDiagnostic, jumpToLine },
		});
		return () => {
			if (editorLintStore.getState().current?.path === path) {
				editorLintStore.setState({ current: null });
			}
		};
	}, [
		hideLintFooter,
		hasLintSources,
		path,
		diagnostics,
		jumpToDiagnostic,
		jumpToLine,
	]);

	useEffect(() => {
		const pending = pendingEditorLineJump.getState();
		if (!pending.path || normalizePath(pending.path) !== normalizePath(path)) {
			return;
		}
		const line = pending.line;
		pendingEditorLineJump.setState({ path: "", line: 0 });
		const timer = window.setTimeout(() => jumpToLine(line), 0);
		return () => window.clearTimeout(timer);
	}, [path, jumpToLine]);

	// Expose the flush to lib actions: the compile button builds disk bytes,
	// so it must first land this editor's debounced autosave.
	useEffect(() => registerTextEditorFlusher(path, flush), [path, flush]);

	// Filled after mount. The update listener (registered once) publishes
	// through it; the effect below owns the binding.
	const publishOutlineRef = useRef<((view: EditorView) => void) | null>(null);

	// Editor owns its state: mount once, reconfigure language/theme in place.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const language = textLanguageExtensions(pathRef.current);
		const extensions: Extension[] = [
			basicSetup,
			EditorView.lineWrapping,
			keymap.of(manualSaveKeymap),
			selection.selectionListener,
			lintDiagnosticsWatcher(handleDiagnostics),
			languageCompartment.current.of(language),
			editorChrome,
			editorHighlight,
			themeCompartment.current.of(
				editorColorScheme(themeRef.current === "dark"),
			),
			fontSizeCompartment.current.of(
				EditorView.theme({ "&": { fontSize: `${fontSizeRef.current}px` } }),
			),
			commentCompartment.current.of(texCommentHighlight([])),
			EditorView.domEventHandlers({
				focus(_event, view) {
					markTexEditorActive(pathRef.current, view);
				},
				click(event, view) {
					if (!isCommentableTexPath(pathRef.current)) return false;
					const pos = view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					});
					if (pos == null) return false;
					const hit = fileThreadsRef.current.find(
						(thread) =>
							!thread.detached && pos >= thread.from && pos < thread.to,
					);
					if (!hit) return false;
					setActiveCommentId(hit.id);
					setReviewOpen(true);
					return false;
				},
				paste(event, view) {
					if (!isTexPath(pathRef.current)) return false;
					const html = event.clipboardData?.getData("text/html") ?? "";
					const plain = event.clipboardData?.getData("text/plain") ?? "";
					const latex = latexFromClipboard(html, plain);
					if (!latex) return false;
					event.preventDefault();
					view.dispatch(view.state.replaceSelection(latex));
					return true;
				},
			}),
			EditorView.updateListener.of((update) => {
				if (update.docChanged || update.selectionSet) {
					if (update.view.hasFocus)
						markTexEditorActive(pathRef.current, update.view);
					publishOutlineRef.current?.(update.view);
				}
				if (!update.docChanged) return;
				if (isTexPath(pathRef.current) || /\.bib$/i.test(pathRef.current))
					invalidateTexProjectIndex();
				if (!dirtyRef.current) {
					dirtyRef.current = true;
					onDirtyChangeRef.current(true);
				}
				if (isTexPath(pathRef.current) && !texLiveReloadRef.current) {
					texLiveApplyUpdate(pathRef.current, view, update);
				}
				if (isCommentableTexPath(pathRef.current)) {
					const doc = update.state.doc.toString();
					const file = commentFileKey(pathRef.current);
					if (texLiveReloadRef.current) relocateTexComments(file, doc);
					else shiftTexComments(file, update.changes, doc);
					const current = draftRef.current;
					if (current) {
						const before = update.startState.doc.toString();
						const synthetic: TexComment = {
							id: "draft",
							file,
							quote: before.slice(current.from, current.to),
							prefix: before.slice(
								Math.max(0, current.from - 40),
								current.from,
							),
							suffix: before.slice(current.to, current.to + 40),
							from: current.from,
							to: current.to,
							detached: false,
							resolved: false,
							messages: [],
							createdAt: 0,
						};
						const next = texLiveReloadRef.current
							? attachComment(doc, synthetic)
							: shiftComment(synthetic, update.changes, doc);
						if (next.detached) setDraft(null);
						else if (
							next.from !== current.from ||
							next.to !== current.to ||
							next.quote !== current.quote
						) {
							setDraft({
								from: next.from,
								to: next.to,
								quote: next.quote,
							});
						}
					}
				}
				schedulePersistRef.current(update.state.doc);
			}),
		];
		const view = new EditorView({
			parent: host,
			state: EditorState.create({ doc: seedRef.current, extensions }),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Mount-once; seed/path/theme changes are handled by the effects below
		// (`manualSaveKeymap` / `selection.selectionListener` /
		// `handleDiagnostics` are stable — never re-mount the editor).
	}, [manualSaveKeymap, selection.selectionListener, handleDiagnostics]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const unregisterEditor = registerTexEditor(path, view, {
			canonical: !panelId || panelId === tabIdForPath(path),
			owner: texLiveOwner,
			activate: panelId
				? () => {
						setActiveTabId(panelId);
						dockHandle()?.activatePanel(panelId);
					}
				: undefined,
		});
		const unregisterBuffer = registerTexProjectBuffer(path, () =>
			view.state.doc.toString(),
		);
		return () => {
			unregisterEditor();
			unregisterBuffer();
		};
	}, [path, panelId, texLiveOwner]);

	// Mounted TeX buffer owns the sidebar outline and the click-to-jump
	// target, including while the PDF tab is the one in front. Runs after
	// the editor mounts so the first snapshot is the current buffer.
	useEffect(() => {
		if (!isTexPath(path)) return;
		const binding = bindTexOutline(path);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let generation = 0;
		let projectOutline: { items: TexOutlineItem[]; rootPath: string } | null =
			null;
		let previousDocument: Text | null = null;
		let projectPaths = new Set<string>();
		const publish = (view: EditorView) => {
			const changed = previousDocument !== view.state.doc;
			previousDocument = view.state.doc;
			const cursorLine = view.state.doc.lineAt(
				view.state.selection.main.head,
			).number;
			if (projectOutline) {
				binding.publish(
					projectOutline.items,
					cursorLine,
					projectOutline.rootPath,
				);
				if (!changed) return;
			} else {
				binding.publish(
					texOutlineFromTree(syntaxTree(view.state).topNode, view.state.doc),
					cursorLine,
				);
			}
			if (timer) clearTimeout(timer);
			const currentGeneration = ++generation;
			timer = setTimeout(() => {
				void loadTexProjectIndex(path)
					.then((index) => {
						if (currentGeneration !== generation || viewRef.current !== view)
							return;
						projectOutline = { items: index.outline, rootPath: index.rootPath };
						projectPaths = new Set(
							[...index.texFiles, ...index.bibFiles, ...index.dependencies].map(
								normalizePath,
							),
						);
						binding.publish(
							index.outline,
							view.state.doc.lineAt(view.state.selection.main.head).number,
							index.rootPath,
						);
					})
					.catch(() => {
						/* Local outline remains usable without a desktop host. */
					});
			}, 500);
		};
		publishOutlineRef.current = publish;
		const unsubscribeFiles = subscribeTexProjectChanges((paths) => {
			const rootDir = dirnameOf(projectOutline?.rootPath ?? path);
			if (
				!paths.some(
					(changed) =>
						projectPaths.has(normalizePath(changed)) ||
						isInsideProject(changed, rootDir),
				)
			)
				return;
			projectOutline = null;
			const current = viewRef.current;
			if (current) publish(current);
		});
		const unsubscribeSettings = texSettingsStore.subscribe(
			(state, previous) => {
				if (
					state.roots === previous.roots &&
					state.projects === previous.projects
				)
					return;
				projectOutline = null;
				const current = viewRef.current;
				if (current) publish(current);
			},
		);
		const view = viewRef.current;
		if (view) publish(view);
		return () => {
			generation += 1;
			if (timer) clearTimeout(timer);
			if (publishOutlineRef.current === publish) {
				publishOutlineRef.current = null;
			}
			binding.unbind();
			unsubscribeSettings();
			unsubscribeFiles();
		};
	}, [path]);

	// A live preview session may already be running (restored pane / another
	// split). Register this buffer so its edits and current text reach rtex.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		return registerTexLiveEditor(path, {
			getText: () => viewRef.current?.state.doc.toString() ?? "",
		});
	}, [path]);

	// Follow light/dark without rebuilding the editor. Token colors use
	// light-dark() against this color-scheme, and surface colors are CSS
	// variables, so a palette change does not need another reconfigure.
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.current.reconfigure(
				editorColorScheme(resolvedTheme === "dark"),
			),
		});
	}, [resolvedTheme]);

	// Follow fontSize changes without rebuilding the editor.
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: fontSizeCompartment.current.reconfigure(
				EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
			),
		});
	}, [fontSize]);

	// A renamed path only swaps the language support.
	const language = useMemo(() => textLanguageExtensions(path), [path]);
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: languageCompartment.current.reconfigure(language),
		});
	}, [language]);

	// The seed is authoritative: after our own save it equals what we wrote
	// (idempotent), after an external change it is the new disk snapshot.
	useEffect(() => {
		lastSavedRef.current = seed;
	}, [seed]);

	// Flush pending autosave on unmount (tab close / LRU eviction).
	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			if (pendingContentRef.current) {
				void flush();
			}
		};
	}, [flush]);

	// A `reloadKey` bump means the file was reloaded from disk (external
	// change the user accepted). Drop any pending autosave from the superseded
	// session — its flush would pass the conflict check (disk === lastSaved)
	// and overwrite the reloaded content — and swap the document in place.
	useEffect(() => {
		if (reloadKey === 0) return; // mount: document was seeded directly
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		pendingContentRef.current = null;
		const view = viewRef.current;
		const next = seedRef.current;
		lastSavedRef.current = next;
		if (view && view.state.doc.toString() !== next) {
			texLiveReloadRef.current = true;
			try {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: next },
				});
			} finally {
				texLiveReloadRef.current = false;
			}
		}
		texLiveSetDocument(path, next);
		dirtyRef.current = false;
		onDirtyChangeRef.current(false);
	}, [reloadKey, path]);

	useEffect(() => {
		if (!isCommentableTexPath(path)) return;
		void loadTexComments();
	}, [path]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const ranges = [
			...fileThreads
				.filter((thread) => !thread.detached && !thread.resolved)
				.map((thread) => ({
					from: thread.from,
					to: thread.to,
					active: thread.id === activeCommentId,
				})),
			...(draft ? [{ from: draft.from, to: draft.to, active: true }] : []),
		];
		view.dispatch({
			effects: commentCompartment.current.reconfigure(
				texCommentHighlight(ranges),
			),
		});
	}, [fileThreads, draft, activeCommentId]);

	useEffect(() => {
		const onAdd = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string }>).detail;
			const range = armedTextEditorRange();
			if (!detail?.path || !range || !sameTexFile(detail.path, path)) return;
			if (!sameTexFile(range.path, path)) return;
			const view = viewRef.current;
			if (!view) return;
			const quote = view.state.sliceDoc(range.from, range.to);
			if (!quote.trim()) return;
			setDraft({ from: range.from, to: range.to, quote });
			setReviewOpen(true);
			setShowResolved(false);
		};
		window.addEventListener(TEX_ADD_COMMENT_EVENT, onAdd);
		return () => window.removeEventListener(TEX_ADD_COMMENT_EVENT, onAdd);
	}, [path]);

	const revealComment = useCallback((thread: TexComment) => {
		setActiveCommentId(thread.id);
		const view = viewRef.current;
		if (!view || thread.detached) return;
		view.dispatch({
			effects: EditorView.scrollIntoView(thread.from, { y: "center" }),
		});
	}, []);

	// An unreadable file still opens an empty buffer — the next autosave
	// creates/repairs the file on disk.
	// The selection chrome portals to body so the fixed-position toolbar and
	// Ask popover escape the panel's overflow/stacking context (same as the
	// PDF card stack); inactive keep-alive panes render no chrome.
	return (
		<div
			className={`relative flex h-full w-full flex-col overflow-hidden ${className ?? ""}`}
		>
			{isTexPath(path) ? (
				<TexCitationPicker
					path={path}
					open={citationOpen}
					onOpenChange={setCitationOpen}
					onInsert={(key) => {
						const view = viewRef.current;
						if (!view) return;
						insertTexCitation(view, key);
					}}
				/>
			) : null}
			{/* The chip anchors to the editor viewport, so the lint footer and
			panel edges never affect its position. */}
			<div className="flex min-h-0 w-full flex-1 overflow-hidden">
				<ResizableGroup
					orientation="horizontal"
					className="h-full min-h-0 w-full"
				>
					<ResizablePanel
						id="tex-source"
						minSize={160}
						className="min-h-0 min-w-0"
					>
						<div className="relative h-full min-h-0 min-w-0 overflow-hidden">
							<TextEditorToolbar
								fontSize={fontSize}
								onFontSizeChange={setFontSize}
								texTools={
									isTexPath(path)
										? { onCitation: () => setCitationOpen(true) }
										: null
								}
								review={
									isCommentableTexPath(path)
										? {
												open: reviewOpen,
												count: openCommentCount,
												onToggle: () => setReviewOpen((open) => !open),
											}
										: null
								}
							/>
							<div ref={hostRef} className="h-full w-full overflow-hidden" />
						</div>
					</ResizablePanel>
					{reviewOpen && isCommentableTexPath(path) ? (
						<ResizableHandle />
					) : null}
					{reviewOpen && isCommentableTexPath(path) ? (
						<ResizablePanel
							id="tex-review"
							defaultSize={readTexReviewWidth()}
							minSize={TEX_REVIEW_MIN_PX}
							maxSize={TEX_REVIEW_MAX_PX}
							groupResizeBehavior="preserve-pixel-size"
							className="min-h-0 min-w-0"
							onResize={(size) => writeTexReviewWidth(size.inPixels)}
						>
							<TexReviewPanel
								threads={fileThreads}
								draft={draft}
								activeId={activeCommentId}
								showResolved={showResolved}
								onShowResolved={setShowResolved}
								onSubmitDraft={(body) => {
									if (!draft) return;
									const view = viewRef.current;
									if (!view) return;
									const thread = addTexComment(
										fileKey,
										view.state.doc.toString(),
										draft.from,
										draft.to,
										body,
									);
									setDraft(null);
									if (thread) setActiveCommentId(thread.id);
								}}
								onCancelDraft={() => {
									setDraft(null);
									if (fileThreads.length === 0) setReviewOpen(false);
								}}
								onReply={replyTexComment}
								onEdit={editTexComment}
								onDelete={(threadId, messageId) => {
									const root = fileThreads.find(
										(thread) => thread.id === threadId,
									)?.messages[0]?.id;
									deleteTexComment(threadId, messageId);
									if (root === messageId) setActiveCommentId(null);
								}}
								onResolve={(threadId, resolved) => {
									resolveTexComment(threadId, resolved);
									if (resolved && activeCommentId === threadId) {
										setActiveCommentId(null);
									}
								}}
								onSelect={revealComment}
								onAddToChat={(thread) => {
									const doc = viewRef.current?.state.doc.toString() ?? null;
									const quote = commentChatQuote(thread, doc);
									if (!quote) return;
									addSelectionToChat({
										text: quote.text,
										sourcePath: path,
										origin: "markdown",
										surface: "text",
										lineFrom: quote.lineFrom,
										lineTo: quote.lineTo,
										context: {
											status:
												quote.before.trim() || quote.after.trim()
													? "available"
													: "unavailable",
											before: quote.before,
											after: quote.after,
										},
										comment: commentChatRecord(thread),
									});
								}}
							/>
						</ResizablePanel>
					) : null}
				</ResizableGroup>
			</div>
			{hasLintSources && !hideLintFooter ? (
				<TextEditorLintFooter
					path={path}
					diagnostics={diagnostics}
					onJump={jumpToDiagnostic}
				/>
			) : null}
		</div>
	);
}
