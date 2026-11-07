/**
 * Built-in palette commands. They close over the action modules (all stable),
 * so this list is a module constant. Importing the module registers them as
 * builtins; the live palette reads `listCommands()`.
 */

import { fileTreeHandle } from "@/components/shell/file-tree-registry";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { pinActiveSelection } from "@/lib/agent/selection-store";
import { openMagicWand } from "@/lib/paper/import-actions";
import { refreshLibrary } from "@/lib/paper/library-store";
import {
	canLoadDevelopmentPlugin,
	hasDevelopmentPlugins,
	loadDevelopmentPlugin,
	unloadDevelopmentPlugins,
} from "@/lib/plugins/development";
import { pluginsSurfaceEnabled } from "@/lib/plugins/visibility";
import { registerBuiltinCommands } from "@/lib/shell/commands/registry";
import type { AppCommand } from "@/lib/shell/commands/types";
import {
	closeSettingsWindow,
	openSettingsWindow,
} from "@/lib/shell/settings-window";
import { layout, toggleSidebar, uiStore } from "@/lib/shell/ui-store";
import { openRightTab, toggleChat } from "@/lib/shell/ui-window-actions";
import {
	createNewVault,
	openSelectedInTerminal,
	openVault,
	refreshAll,
	revealSelectedInFinder,
} from "@/lib/vault/actions";
import { getVaultPath } from "@/lib/vault/store";
import {
	closeTabOrWindow,
	cycleActiveTab,
	reopenClosedTab,
	selectLibrary,
	splitActivePane,
} from "@/lib/workspace/actions";
import { getActiveTab, getActiveTabId } from "@/lib/workspace/store";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";
import { resolveActivePdfHandle } from "@/lib/workspace/viewer/pdf-viewer-registry";

const hasVault = () => Boolean(getVaultPath());

export const paletteCommands: AppCommand[] = [
	{
		id: "plugins.loadDevelopment",
		titleKey: "commands.pluginsLoadDevelopment",
		categoryKey: "commands.catApp",
		when: () => pluginsSurfaceEnabled && canLoadDevelopmentPlugin(),
		run: loadDevelopmentPlugin,
	},
	{
		id: "plugins.unloadDevelopment",
		titleKey: "commands.pluginsUnloadDevelopment",
		categoryKey: "commands.catApp",
		when: () => pluginsSurfaceEnabled && hasDevelopmentPlugins(),
		run: unloadDevelopmentPlugins,
	},
	{
		id: "settings.open",
		titleKey: "commands.settingsOpen",
		categoryKey: "commands.catApp",
		keywords: ["preferences", "settings"],
		run: () => openSettingsWindow(),
	},
	{
		id: "settings.close",
		titleKey: "commands.settingsClose",
		categoryKey: "commands.catApp",
		when: () => uiStore.getState().settingsOpen,
		run: () => closeSettingsWindow(),
	},
	{
		id: "vault.open",
		titleKey: "commands.vaultOpen",
		categoryKey: "commands.catVault",
		run: () => void openVault(),
	},
	{
		id: "vault.create",
		titleKey: "commands.vaultCreate",
		categoryKey: "commands.catVault",
		run: () => void createNewVault(),
	},
	{
		id: "vault.refresh",
		titleKey: "commands.vaultRefresh",
		categoryKey: "commands.catVault",
		when: hasVault,
		run: () => refreshAll(),
	},
	{
		id: "vault.reveal",
		titleKey: "commands.vaultReveal",
		categoryKey: "commands.catVault",
		when: hasVault,
		run: () => revealSelectedInFinder(),
	},
	{
		id: "vault.terminal",
		titleKey: "commands.vaultTerminal",
		categoryKey: "commands.catVault",
		when: hasVault,
		run: () => openSelectedInTerminal(),
	},
	{
		id: "vault.collapseTreeCurrent",
		titleKey: "commands.vaultCollapseTreeCurrent",
		categoryKey: "commands.catVault",
		when: hasVault,
		keywords: ["collapse", "folder", "tree", "fold"],
		run: () => fileTreeHandle()?.collapseSelected(),
	},
	{
		id: "vault.collapseTreeDefault",
		titleKey: "commands.vaultCollapseTreeDefault",
		categoryKey: "commands.catVault",
		when: hasVault,
		keywords: ["collapse", "default", "papers", "tree", "fold"],
		run: () => fileTreeHandle()?.collapseToDefault(),
	},
	{
		id: "view.toggleSidebar",
		titleKey: "commands.viewToggleSidebar",
		categoryKey: "commands.catView",
		run: () => toggleSidebar(),
	},
	{
		id: "view.toggleChat",
		titleKey: "commands.viewToggleChat",
		categoryKey: "commands.catView",
		keywords: ["agent", "chat"],
		run: () => toggleChat(),
	},
	{
		id: "view.addSelectionToChat",
		titleKey: "commands.viewAddSelectionToChat",
		categoryKey: "commands.catView",
		keywords: ["agent", "chat", "selection", "context"],
		run: () => {
			pinActiveSelection();
			openRightTab("agent");
			focusAgentComposer();
		},
	},
	{
		id: "view.focusSidebar",
		titleKey: "commands.viewFocusSidebar",
		categoryKey: "commands.catView",
		run: () => layout()?.focusSidebar(),
	},
	{
		id: "view.focusEditor",
		titleKey: "commands.viewFocusEditor",
		categoryKey: "commands.catView",
		run: () => layout()?.focusEditorPane(),
	},
	{
		id: "view.focusNotes",
		titleKey: "commands.viewFocusNotes",
		categoryKey: "commands.catView",
		run: () => layout()?.focusNotesEditor(),
	},
	{
		id: "library.focus",
		titleKey: "commands.libraryFocus",
		categoryKey: "commands.catLibrary",
		when: hasVault,
		run: () => {
			selectLibrary();
			void refreshLibrary();
		},
	},
	{
		id: "tab.close",
		titleKey: "commands.tabClose",
		categoryKey: "commands.catTab",
		run: () => closeTabOrWindow(),
	},
	{
		id: "tab.reopen",
		titleKey: "commands.tabReopen",
		categoryKey: "commands.catTab",
		keywords: ["reopen", "restore", "undo close", "recent"],
		run: () => reopenClosedTab(),
	},
	{
		id: "tab.splitPane",
		titleKey: "commands.tabSplitPane",
		categoryKey: "commands.catTab",
		run: () => splitActivePane(),
	},
	{
		id: "tab.next",
		titleKey: "commands.tabNext",
		categoryKey: "commands.catTab",
		run: () => cycleActiveTab(1),
	},
	{
		id: "tab.prev",
		titleKey: "commands.tabPrev",
		categoryKey: "commands.catTab",
		run: () => cycleActiveTab(-1),
	},
	{
		id: "editor.toggleMarkdownSource",
		titleKey: "commands.toggleMarkdownSource",
		categoryKey: "commands.catEditor",
		keywords: ["markdown", "source", "wysiwyg", "源码", "渲染"],
		when: () => Boolean(markdownEditorFor(getActiveTabId())),
		run: () => markdownEditorFor(getActiveTabId())?.toggleSource(),
	},
	{
		id: "pdf.exportAnnotatedPdf",
		titleKey: "commands.exportAnnotatedPdf",
		categoryKey: "commands.catPdf",
		keywords: ["export", "pdf", "annotated", "highlight", "comment"],
		when: () => getActiveTab()?.mode === "pdf",
		run: () => {
			const handle = resolveActivePdfHandle();
			if (handle) void handle.exportAnnotatedPdf();
		},
	},
	{
		id: "wand.open",
		titleKey: "commands.wandOpen",
		categoryKey: "commands.catVault",
		keywords: ["import", "arxiv", "doi", "lookup"],
		when: hasVault,
		run: () => openMagicWand(),
	},
];

// Second evaluation (HMR / reimport) skips ids already registered.
registerBuiltinCommands(paletteCommands);
