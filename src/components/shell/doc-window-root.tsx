/**
 * Lightweight root for `?window=doc&path=…` document popouts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrafficLightSpacer } from "@/components/shell/traffic-light-spacer";
import { WindowHeader } from "@/components/shell/window-header";
import {
	DocView,
	type DocViewEditorProps,
	type DocViewLibraryProps,
	type DocViewPdfProps,
} from "@/components/workspace/doc-view";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useFlushMarkdownOnClose } from "@/hooks/use-flush-markdown-on-close";
import { useNativeSelectAllGuard } from "@/hooks/use-native-select-all-guard";
import { useAnyModalOverlayOpen } from "@/hooks/use-overlay-registration";
import { useVaultFileEvents } from "@/hooks/use-vault-file-events";
import { isMacOS } from "@/lib/core/tauri";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { refreshLibrary } from "@/lib/paper/library-store";
import { applyDocumentChrome, resolveFontFamilyCss } from "@/lib/settings";
import { closeCurrentWindow } from "@/lib/shell/close-window";
import { readDocWindowParams } from "@/lib/shell/doc-window";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { resolveShortcutId } from "@/lib/shell/shortcuts";
import { openRecentVault } from "@/lib/vault/actions";
import { refreshTree, vaultStore } from "@/lib/vault/store";
import { shouldIgnoreInternalRenameEvent } from "@/lib/wiki/store";
import {
	applyDiskChange,
	compileTexOnManualSave,
	persistExcalidrawFile,
	persistFile,
	persistTextFile,
} from "@/lib/workspace/actions";
import {
	applyMarkdownConflictChoice,
	createPlaceholderTab,
	type DocTab,
	loadTabResources,
	patchFromTabResources,
	syncTabSeedsForPath,
} from "@/lib/workspace/tabs";
import { isCenterViewMode } from "@/lib/workspace/viewer";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

// DocView's memo compares domain objects by identity; the popout never shows
// Library / PDF-chrome surfaces, so constant no-op stubs keep it that way.
const LIBRARY_STUB: DocViewLibraryProps = {
	papers: [],
	loading: false,
	query: "",
	onQueryChange: () => {},
	scopePath: null,
	columns: [],
	onColumnsChange: () => {},
	rescanning: false,
	onOpenPaper: () => {},
	onRescan: () => {},
};
const PDF_STUB: DocViewPdfProps = {
	onOpenSettings: () => openSettingsWindow("general"),
	registerHandle: () => {},
	onHighlightsChange: () => {},
	onAsksChange: () => {},
	onVisualTracesChange: () => {},
};
const NOOP_TRASH_CHANGED = () => {};

export function DocWindowRoot() {
	const { t } = useTranslation(["app"]);
	const isMac = useMemo(() => isMacOS(), []);
	const params = useMemo(() => readDocWindowParams(), []);
	const [tab, setTab] = useState<DocTab | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const tabRef = useRef<DocTab | null>(null);
	tabRef.current = tab;
	useNativeSelectAllGuard();
	useFlushMarkdownOnClose();
	const modalOverlayOpen = useAnyModalOverlayOpen();

	const vaultPath = useVaultStore((s) => s.vaultPath);
	const fontSize = useSettings((s) => s.editorFontSize);
	const textFontFamily = useSettings((s) => s.textFontFamily);
	const lineHeight = useSettings((s) => s.editorLineHeight);
	const showToolbar = useSettings((s) => s.showEditorToolbar);
	const uiScale = useSettings((s) => s.uiScale);
	const interfaceFontFamily = useSettings((s) => s.interfaceFontFamily);
	const monoFontFamily = useSettings((s) => s.monoFontFamily);
	const fontFamily = resolveFontFamilyCss(textFontFamily, "text");
	useExternalFileDrop();

	useEffect(() => {
		applyDocumentChrome({
			uiScale,
			interfaceFontFamily,
			monoFontFamily,
		});
	}, [uiScale, interfaceFontFamily, monoFontFamily]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const path = params.path;
			if (!path) {
				setError(t("windows.docMissingPath"));
				setReady(true);
				return;
			}
			if (isLibraryVirtualPath(path) || isTrashVirtualPath(path)) {
				setError(t("windows.docUnsupported"));
				setReady(true);
				return;
			}
			const vault = params.vaultPath;
			if (vault) {
				await openRecentVault(vault);
				if (!cancelled) {
					await refreshTree(vault);
					await refreshLibrary();
				}
			}
			if (cancelled) return;

			// Unregistered URL modes are ignored (viewerModeSpec throws otherwise).
			const preferMode = isCenterViewMode(params.mode)
				? params.mode
				: undefined;
			const placeholder = createPlaceholderTab(path, preferMode);
			setTab(placeholder);

			const vs = vaultStore.getState();
			const res = await loadTabResources(
				path,
				vs.vaultPath,
				vs.tree,
				vs.paperFolders,
			);
			if (cancelled) return;
			if (res.error) setError(res.error);

			// The placeholder carries the URL-param mode: a PDF popout must not
			// flip to a Markdown editor on a single failed local-PDF probe.
			const next: DocTab = {
				...placeholder,
				...patchFromTabResources(res, placeholder),
			};
			setTab(next);
			setReady(true);
			if (typeof document !== "undefined" && res.title) {
				document.title = res.title;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [params.path, params.mode, params.vaultPath, t]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				document.querySelector("[data-shortcut-recording]")
			)
				return;
			const source =
				!modalOverlayOpen &&
				resolveShortcutId(event, { settingsOpen: false }) ===
					"toggleMarkdownSource";
			if (source) {
				event.preventDefault();
				event.stopPropagation();
				if (!event.repeat)
					markdownEditorFor(tabRef.current?.id)?.toggleSource();
				return;
			}
			const id = resolveShortcutId(event, { settingsOpen: true });
			if (id === "closeSheet" || id === "closeTab") {
				event.preventDefault();
				closeCurrentWindow();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [modalOverlayOpen]);

	const onTabPatch = useCallback((id: string, patch: Partial<DocTab>) => {
		setTab((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
	}, []);

	const diskChangeSink = useMemo(
		() => ({
			getTabs: () => (tabRef.current ? [tabRef.current] : []),
			// Single-tab window: run the shared tab-list transforms over the
			// local React tab and keep the patched tab.
			updateTabs: (update: (prev: DocTab[]) => DocTab[]) => {
				setTab((prev) => (prev ? (update([prev])[0] ?? prev) : prev));
			},
		}),
		[],
	);

	const excalidrawProps = useMemo(
		() => ({
			onPersistFile: persistExcalidrawFile,
			onTabPatch: onTabPatch,
		}),
		[onTabPatch],
	);

	const textProps = useMemo(
		() => ({
			onPersistFile: persistTextFile,
			// ⌘S in a popout window compiles the same way as the main dock.
			onManualSave: (path: string) => void compileTexOnManualSave(path),
			onTabPatch: onTabPatch,
		}),
		[onTabPatch],
	);

	const onDiskChange = useCallback(
		(absPath: string) => {
			void applyDiskChange(absPath, diskChangeSink);
		},
		[diskChangeSink],
	);

	const onStructuralChange = useCallback(() => {
		if (vaultPath) void refreshTree(vaultPath);
	}, [vaultPath]);

	// Per-window watcher: Agent / external edits must reseed this popout's
	// local tab (main-window applyDiskChange cannot see it).
	useVaultFileEvents({
		vaultPath,
		onDiskChange,
		onStructuralChange,
		shouldIgnoreEvent: shouldIgnoreInternalRenameEvent,
	});

	const onPersistFile = useCallback(
		async (path: string, md: string, lastSaved: string, tabId: string) => {
			const ok = await persistFile(path, md, lastSaved, tabId);
			if (ok) {
				// Popout tabs live in local state. Refresh this pane the same way
				// the main window refreshes its siblings.
				setTab((prev) => {
					if (!prev) return prev;
					return syncTabSeedsForPath([prev], path, md, tabId)[0] ?? prev;
				});
			}
			return ok;
		},
		[],
	);

	const onResolveMarkdownConflict = useCallback(
		(tabId: string, action: "keep" | "load" | "hold", disk: string) => {
			setTab((prev) => {
				if (!prev) return prev;
				return (
					applyMarkdownConflictChoice([prev], tabId, action, disk)[0] ??
					prev
				);
			});
		},
		[],
	);

	const editorProps = useMemo<DocViewEditorProps>(
		() => ({
			fontSize,
			fontFamily,
			lineHeight,
			showToolbar,
			notesPlaceholder: t("editor.notesPlaceholder"),
			markdownPlaceholder: t("editor.markdownPlaceholder"),
			onPersistFile,
			onResolveMarkdownConflict,
			onAssetsChanged: () => {
				if (vaultPath) void refreshTree(vaultPath);
			},
			onTabPatch,
		}),
		[
			fontSize,
			fontFamily,
			lineHeight,
			showToolbar,
			t,
			vaultPath,
			onTabPatch,
			onPersistFile,
			onResolveMarkdownConflict,
		],
	);

	const title = tab?.title ?? t("tabs.strip");

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
			{isMac ? (
				<WindowHeader>
					<TrafficLightSpacer />
					<div
						className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-muted-foreground"
						data-tauri-drag-region
					>
						{title}
					</div>
				</WindowHeader>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{!ready || !tab ? (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						{error ?? t("windows.loading")}
					</div>
				) : (
					<DocView
						tab={tab}
						active
						keepMounted
						vaultPath={vaultPath}
						library={LIBRARY_STUB}
						editor={editorProps}
						pdf={PDF_STUB}
						excalidraw={excalidrawProps}
						text={textProps}
						onTrashChanged={NOOP_TRASH_CHANGED}
					/>
				)}
			</div>
		</div>
	);
}
