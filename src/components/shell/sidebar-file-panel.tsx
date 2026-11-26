import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { DocumentContent } from "@/components/workspace/doc-view";
import { useSettings, useUiStore, useVaultStore } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { paperDirFromPath } from "@/lib/paper/detect";
import { notesPathForPaper } from "@/lib/paper/paths";
import {
	removeTabAnnotations,
	setTabAsks,
	setTabHighlights,
	setTabVisualTraces,
} from "@/lib/pdf/annotations-store";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import { resolveFontFamilyCss } from "@/lib/settings";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import type { SidebarPanelParams } from "@/lib/shell/sidebar-tabs";
import { joinVaultPath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { refreshTree } from "@/lib/vault/store";
import { renameWikiHeadingAction } from "@/lib/wiki/actions";
import { persistFile } from "@/lib/workspace/persistence";
import {
	patchSidebarDocument,
	setSidebarDocuments,
	sidebarDocuments,
} from "@/lib/workspace/sidebar-documents";
import {
	readSidebarFile,
	type SidebarFileData,
	type SidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { createPlaceholderTab } from "@/lib/workspace/tabs/model";
import { applyMarkdownConflictChoice } from "@/lib/workspace/tabs/notes-split";
import { registerPdfHandle } from "@/lib/workspace/viewer/pdf-viewer-registry";

const pdf = {
	onOpenSettings: () => openSettingsWindow("translate"),
	registerHandle: registerPdfHandle,
	onHighlightsChange: setTabHighlights,
	onAsksChange: setTabAsks,
	onVisualTracesChange: setTabVisualTraces,
};

export function SidebarFilePanel({
	api,
	params,
}: IDockviewPanelProps<SidebarPanelParams>) {
	const { t } = useTranslation("app");
	const target = params.target as SidebarFileTarget;
	const vault = useVaultStore((store) => store.vaultPath) ?? "";
	const paperFolders = useVaultStore((store) => store.paperFolders);
	const railOpen = useUiStore((store) => store.rightSidebarOpen);
	const [visible, setVisible] = useState(api.isVisible);
	const [htmlGrant, setHtmlGrant] = useState(params.file?.htmlGrant);
	const [loadError, setLoadError] = useState<string>();
	const tab = useStore(sidebarDocuments, (store) =>
		store.tabs.find((tab) => tab.id === api.id),
	);
	const fontSize = useSettings((store) => store.editorFontSize);
	const textFontFamily = useSettings((store) => store.textFontFamily);
	const lineHeight = useSettings((store) => store.editorLineHeight);
	const showToolbar = useSettings((store) => store.showEditorToolbar);
	const path = joinVaultPath(vault, target.vaultRelPath);
	const paper = paperDirFromPath(path, paperFolders);
	const paperNotes = paper ? notesPathForPaper(paper) : null;
	const notesPath =
		target.kind === "notes" && path !== paperNotes ? null : paperNotes;
	const mode = target.kind === "notes" ? "markdown" : target.kind;
	const editor = useMemo(
		() => ({
			fontSize,
			fontFamily: resolveFontFamilyCss(textFontFamily, "text"),
			lineHeight,
			showToolbar,
			notesPlaceholder: t("editor.notesPlaceholder"),
			markdownPlaceholder: t("editor.markdownPlaceholder"),
			onPersistFile: persistFile,
			onResolveMarkdownConflict: (
				viewId: string,
				action: "keep" | "load" | "hold",
				disk: string,
			) => {
				setSidebarDocuments((tabs) =>
					applyMarkdownConflictChoice(tabs, viewId, action, disk),
				);
			},
			onAssetsChanged: () => {
				void refreshTree(vault);
			},
			onTabPatch: patchSidebarDocument,
			onRenameHeading: isRemoteVaultHandle(vault)
				? undefined
				: renameWikiHeadingAction,
		}),
		[fontSize, textFontFamily, lineHeight, showToolbar, t, vault],
	);

	useEffect(() => {
		const listener = api.onDidVisibilityChange(({ isVisible }) =>
			setVisible(isVisible),
		);
		return () => listener.dispose();
	}, [api]);
	useEffect(() => {
		setSidebarDocuments((tabs) => [
			...tabs,
			createPlaceholderTab(path, mode, api.id),
		]);
		return () => {
			cancelPdfNavigationForTab(api.id);
			removeTabAnnotations([api.id]);
			setSidebarDocuments((tabs) => tabs.filter((tab) => tab.id !== api.id));
		};
	}, [api.id, mode, path]);
	useEffect(() => {
		patchSidebarDocument(api.id, { notesPath });
	}, [api.id, notesPath]);
	useEffect(() => {
		if ((!visible || !railOpen) && !params.file) return;
		if (tab?.loaded || loadError) return;
		let cancelled = false;
		const apply = (data: SidebarFileData) => {
			if (cancelled) return;
			setHtmlGrant(data.htmlGrant);
			patchSidebarDocument(api.id, {
				pdfBytes: data.pdfBytes ?? null,
				markdownSeed: data.markdown ?? "",
				notesSeed: data.markdown ?? "",
				loaded: true,
			});
		};
		if (params.file) apply(params.file);
		else
			void readSidebarFile(vault, target).then(apply, (error: unknown) => {
				if (!cancelled) setLoadError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [
		api.id,
		params.file,
		target,
		vault,
		visible,
		railOpen,
		tab?.loaded,
		loadError,
	]);

	if (loadError)
		return (
			<div className="flex h-full flex-col items-start gap-2 overflow-auto p-4 text-sm">
				<p role="status">{loadError}</p>
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						setLoadError(undefined);
					}}
				>
					{t("sidebarTabs.retry")}
				</Button>
			</div>
		);
	if (!tab) return null;
	return (
		<div
			data-sidebar-view={api.id}
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<DocumentContent
				tab={tab}
				active={visible && railOpen}
				keepMounted
				vaultPath={vault}
				editor={editor}
				pdf={pdf}
				localHtmlGrant={htmlGrant}
			/>
		</div>
	);
}
