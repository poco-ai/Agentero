/**
 * App shortcuts aligned with common macOS / Apple HIG patterns.
 * Display uses Apple symbols: ⌘ ⌥ ⇧ ⌃
 */

import { getPlatformOS } from "@/lib/core/tauri";
import type { ShortcutOverrides } from "@/lib/settings/shortcut-bindings";
import { loadSettings } from "@/lib/settings/store";

export type ShortcutId =
	| "settings"
	| "newWindow"
	| "openVault"
	| "createVault"
	| "refreshTree"
	| "revealInFinder"
	| "openInTerminal"
	| "deleteTreeItem"
	| "cutTreeItem"
	| "pasteTreeItem"
	/** ⌘← — collapse selected file-tree folder (or its parent) */
	| "collapseTreeCurrent"
	/** ⇧⌘← — reset tree to only papers/ expanded (children listed, not open) */
	| "collapseTreeDefault"
	| "magicWand"
	/** ⌘P — quick open papers & contents */
	| "quickOpen"
	/** ⇧⌘P — run app commands */
	| "commandPalette"
	| "toggleMarkdownSource"
	| "toggleSidebar"
	| "toggleChat"
	/** ⌘K — in-page Quick chat (Ask) from the live selection */
	| "quickChat"
	/** ⇧⌘L — pin the live selection into the Agent context and focus the composer */
	| "addSelectionToChat"
	| "closeSheet"
	| "focusSidebar"
	| "focusEditor"
	| "focusNotes"
	| "closeTab"
	/** ⇧⌘T — reopen the most recently closed tab */
	| "reopenTab"
	| "splitPane"
	| "nextTab"
	| "prevTab"
	| "zoomIn"
	| "zoomOut"
	| "zoomReset"
	/** ⌘. — start/cancel PDF visual-region annotation (active PDF tab). */
	| "visualAnnotation"
	/** ⌥A — toggle PDF full-text (layout) translation (active PDF tab). */
	| "layoutTranslate"
	/** F11 — borderless fullscreen (Windows only). */
	| "toggleFullscreen";

export type ShortcutGroup = "App" | "Navigation" | "Vault" | "Editor";

export type ShortcutPlatform = "windows" | "macos" | "linux";

export type ShortcutDef = {
	id: ShortcutId;
	/** Grouping label (translated for display via the `shortcuts` namespace) */
	group: ShortcutGroup;
	/** Keys without modifiers, lower-case letter or special */
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	/**
	 * When true, only matches if any app overlay is open
	 * (settings, dialogs, command palette — see overlay-stack).
	 */
	whenSettingsOpen?: boolean;
	/** When true, only matches if no app overlay is open. */
	whenSettingsClosed?: boolean;
	/** When set, only active / listed on these desktop OSes. */
	platforms?: readonly ShortcutPlatform[];
};

export const SHORTCUTS: ShortcutDef[] = [
	{
		id: "settings",
		group: "App",
		key: ",",
		meta: true,
	},
	{
		id: "closeSheet",
		group: "App",
		// Esc — dismiss the topmost registered overlay (settings, dialogs, palette…)
		key: "Escape",
		whenSettingsOpen: true,
	},
	{
		id: "zoomIn",
		group: "App",
		// ⌘+ — zoom whole UI in (matches browsers / VS Code)
		key: "+",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "zoomOut",
		group: "App",
		// ⌘- — zoom whole UI out
		key: "-",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "zoomReset",
		group: "App",
		// ⌘0 — reset UI zoom to 100%
		key: "0",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "newWindow",
		group: "App",
		key: "n",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "openVault",
		group: "Vault",
		key: "o",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "createVault",
		group: "Vault",
		key: "n",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "refreshTree",
		group: "Vault",
		key: "r",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "revealInFinder",
		group: "Vault",
		// ⌥⌘R — reveal selected tree item in Finder / Explorer
		key: "r",
		meta: true,
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "openInTerminal",
		group: "Vault",
		// ⌥⌘T — open system terminal at selected path (dir = self, file = parent)
		key: "t",
		meta: true,
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "deleteTreeItem",
		group: "Vault",
		// ⌘⌫ — delete selected file tree item (with confirm)
		key: "Backspace",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "cutTreeItem",
		group: "Vault",
		// ⌘X — cut selected file tree item(s)
		key: "x",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "pasteTreeItem",
		group: "Vault",
		// ⌘V — paste cut file tree item(s) into selected destination
		key: "v",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "collapseTreeCurrent",
		group: "Vault",
		// ⌘← — collapse selected folder (VS Code list.collapse-ish; free of ⌥⌘← tabs)
		key: "ArrowLeft",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "collapseTreeDefault",
		group: "Vault",
		// ⇧⌘← — collapse tree to default (only papers/ open; no subfolder expand)
		key: "ArrowLeft",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "magicWand",
		group: "Vault",
		// ⇧⌘I — open identifier / magic-wand import popover
		key: "i",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "quickOpen",
		group: "Navigation",
		// ⌘P — quick open papers + contents (VS Code Go to File)
		key: "p",
		meta: true,
		// No whenSettingsClosed: same key dismisses while palette is open.
	},
	{
		id: "commandPalette",
		group: "Navigation",
		// ⇧⌘P — run app commands (VS Code Command Palette)
		key: "p",
		meta: true,
		shift: true,
		// No whenSettingsClosed: same key dismisses while palette is open.
	},
	{
		id: "toggleMarkdownSource",
		group: "Editor",
		key: "/",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "toggleSidebar",
		group: "Navigation",
		// Apple Mail / Preview family uses ⌥⌘S; many Mac productivity apps use ⌘B.
		// Prefer ⌥⌘S for platform feel; ⌘B kept as secondary alias in matcher.
		key: "s",
		meta: true,
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "toggleChat",
		group: "Navigation",
		// ⌘L — toggle the right sidebar independently of the selection.
		key: "l",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "quickChat",
		group: "Navigation",
		// ⌘K — in-page Quick chat (Ask) from the live PDF / Plaza selection.
		key: "k",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "addSelectionToChat",
		group: "Navigation",
		// ⇧⌘L — pin the live selection as Agent context and focus the composer.
		key: "l",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "focusSidebar",
		group: "Navigation",
		key: "1",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "focusEditor",
		group: "Navigation",
		key: "2",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "focusNotes",
		group: "Navigation",
		key: "3",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "closeTab",
		group: "Navigation",
		// ⌘W — close top overlay first; else active tab / window.
		// Intentionally NOT whenSettingsClosed: overlays take priority over tabs.
		key: "w",
		meta: true,
	},
	{
		id: "reopenTab",
		group: "Navigation",
		// ⇧⌘T — reopen the most recently closed panel (browser convention).
		key: "t",
		meta: true,
		shift: true,
		whenSettingsClosed: true,
	},
	{
		id: "splitPane",
		group: "Navigation",
		// ⌘\ — Obsidian-style split pane to the right.
		key: "\\",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "nextTab",
		group: "Navigation",
		// ⌥⌘→ — next document tab
		key: "ArrowRight",
		meta: true,
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "prevTab",
		group: "Navigation",
		// ⌥⌘← — previous document tab
		key: "ArrowLeft",
		meta: true,
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "visualAnnotation",
		group: "App",
		// ⌘. — toggle PDF visual annotation region select (active PDF tab)
		key: ".",
		meta: true,
		whenSettingsClosed: true,
	},
	{
		id: "layoutTranslate",
		group: "App",
		// ⌥A — toggle PDF full-text (layout) translation (active PDF tab).
		// Immersive Translate convention; guard text fields (⌥A types "å").
		key: "a",
		alt: true,
		whenSettingsClosed: true,
	},
	{
		id: "toggleFullscreen",
		group: "App",
		// F11 — exclusive (borderless) fullscreen; Windows only
		key: "F11",
		platforms: ["windows"],
	},
];

function shortcutAvailableOnPlatform(def: ShortcutDef): boolean {
	if (!def.platforms?.length) return true;
	const os = getPlatformOS();
	return os === "windows" || os === "macos" || os === "linux"
		? def.platforms.includes(os)
		: false;
}

/** Secondary aliases that still work (documented lightly). */
const ALIASES: Partial<Record<ShortcutId, ShortcutDef[]>> = {
	toggleSidebar: [
		{
			id: "toggleSidebar",
			group: "Navigation",
			key: "b",
			meta: true,
			whenSettingsClosed: true,
		},
	],
	zoomIn: [
		{
			id: "zoomIn",
			group: "App",
			// ⌘= — alias for zoom in on keyboards where + shares the = key
			key: "=",
			meta: true,
			whenSettingsClosed: true,
		},
	],
};

/** Keys needed to render a chord (registry entries or one-off UI hints). */
export type ShortcutDisplay = Pick<
	ShortcutDef,
	"key" | "meta" | "ctrl" | "alt" | "shift"
>;

/** Let text controls keep editor-native keys, including the sidebar's ⌘B alias. */
export function shortcutBelongsToTextField(
	id: ShortcutId,
	event: Pick<KeyboardEvent, "key" | "target">,
): boolean {
	if (id === "toggleMarkdownSource") return false;
	const binding = getShortcut(id);
	const optionTyping = binding?.alt && !binding.meta && !binding.ctrl;
	if (
		!optionTyping &&
		id !== "deleteTreeItem" &&
		id !== "collapseTreeCurrent" &&
		id !== "collapseTreeDefault" &&
		id !== "cutTreeItem" &&
		id !== "pasteTreeItem" &&
		id !== "layoutTranslate" &&
		!(id === "toggleSidebar" && event.key.toLowerCase() === "b")
	) {
		return false;
	}
	const target = event.target as {
		closest?: (selector: string) => Element | null;
	} | null;
	return Boolean(
		target?.closest?.(
			"input, textarea, select, [contenteditable='true'], [role='textbox']",
		),
	);
}

/**
 * Platform-aware shortcut label for UI.
 * macOS: Apple symbols (⌘X); Windows/Linux: Ctrl+X style.
 * Not i18n — modifier names follow the OS, not the app language.
 */
export function formatShortcut(def: ShortcutDisplay): string {
	const isMac =
		typeof navigator !== "undefined" &&
		/Mac|iPhone|iPad|iPod/.test(navigator.platform);

	const parts: string[] = [];
	if (def.ctrl) parts.push(isMac ? "⌃" : "Ctrl");
	if (def.alt) parts.push(isMac ? "⌥" : "Alt");
	if (def.shift) parts.push(isMac ? "⇧" : "Shift");
	if (def.meta) parts.push(isMac ? "⌘" : "Ctrl");

	const keyLabel =
		def.key === "," || def.key === "."
			? def.key
			: def.key === "Backspace"
				? isMac
					? "⌫"
					: "Backspace"
				: def.key === "Escape"
					? "Esc"
					: def.key === "ArrowRight"
						? "→"
						: def.key === "ArrowLeft"
							? "←"
							: def.key.length === 1
								? def.key.toUpperCase()
								: def.key;
	parts.push(keyLabel);
	return parts.join(isMac ? "" : "+");
}

/** Primary-mod + key (⌘K / Ctrl+K) for ad-hoc menu / tooltip hints. */
export function formatModShortcut(
	key: string,
	extras?: Omit<ShortcutDisplay, "key" | "meta">,
): string {
	return formatShortcut({ key, meta: true, ...extras });
}

/** Format the primary shortcut for an id (platform-aware) for tooltip interpolation. */
export function formatShortcutById(id: ShortcutId): string {
	const def = getShortcut(id);
	return def ? formatShortcut(def) : "";
}

export type ShortcutKeyEvent = Pick<
	KeyboardEvent,
	"key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** Local find handlers share the shell's exact macOS modifier matching. */
export function isFindShortcut(event: ShortcutKeyEvent): boolean {
	return matchShortcut(event, { key: "f", meta: true });
}

export function matchShortcut(
	event: ShortcutKeyEvent,
	def: Pick<ShortcutDef, "key" | "meta" | "ctrl" | "alt" | "shift">,
): boolean {
	const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	const defKey = def.key.length === 1 ? def.key.toLowerCase() : def.key;
	// macOS composes ⌥+letter into a single character (⌥A → "å"), so event.key
	// never equals the def letter. Option letter shortcuts fall back to the
	// physical key (event.code), which stays stable across layouts.
	const physicalKey = /^Key[A-Z]$/.test(event.code)
		? event.code.slice(3).toLowerCase()
		: null;
	if (
		key !== defKey &&
		event.key !== def.key &&
		!(def.alt && physicalKey === defKey)
	)
		return false;

	const wantMeta = Boolean(def.meta);
	const wantAlt = Boolean(def.alt);
	const wantShift = Boolean(def.shift);
	const wantCtrl = Boolean(def.ctrl);

	const isMac = getPlatformOS() === "macos";
	if (isMac) {
		if (wantMeta !== event.metaKey) return false;
		if (wantCtrl !== event.ctrlKey) return false;
	} else {
		// On Windows/Linux, treat Ctrl as ⌘ equivalent when meta is required.
		const metaOrCtrl = event.metaKey || event.ctrlKey;
		if (wantMeta) {
			if (!metaOrCtrl) return false;
		} else if (event.metaKey) {
			return false;
		}

		if (wantCtrl && !wantMeta && !event.ctrlKey) return false;
		// When meta maps to ctrl on non-Mac, ignore pure ctrl-only false positives
		if (!wantMeta && !wantCtrl && event.ctrlKey) return false;
	}

	if (wantAlt !== event.altKey) return false;
	if (wantShift !== event.shiftKey) return false;

	return true;
}

export function resolveShortcutId(
	event: KeyboardEvent,
	opts: {
		/** Any app overlay open (settings / dialogs / palette). */
		settingsOpen: boolean;
	},
): ShortcutId | null {
	if (event.isComposing || event.key === "Dead" || event.key === "Process")
		return null;
	const overlayOpen = opts.settingsOpen;
	const overrides = loadSettings().shortcutOverrides ?? {};
	const candidates = SHORTCUTS.flatMap((def) => {
		const effective = getShortcut(def.id, overrides);
		if (!effective) return [];
		const aliases = getShortcutAliases(def.id, overrides);
		return [effective, ...aliases];
	});

	for (const def of candidates) {
		if (!shortcutAvailableOnPlatform(def)) continue;
		if (def.whenSettingsOpen && !overlayOpen) continue;
		if (def.whenSettingsClosed && overlayOpen) continue;
		if (matchShortcut(event, def)) return def.id;
	}
	return null;
}

export function shortcutsByGroup(): {
	group: ShortcutGroup;
	items: ShortcutDef[];
}[] {
	const order = ["App", "Vault", "Navigation", "Editor"] as const;
	return order.map((group) => ({
		group,
		items: SHORTCUTS.filter(
			(s) => s.group === group && shortcutAvailableOnPlatform(s),
		),
	}));
}

/** A custom binding replaces the primary chord and its built-in aliases. */
export function getShortcut(
	id: ShortcutId,
	overrides: ShortcutOverrides = loadSettings().shortcutOverrides ?? {},
): ShortcutDef | null {
	const def = SHORTCUTS.find((item) => item.id === id);
	if (!def || !shortcutAvailableOnPlatform(def)) return null;
	if (!Object.hasOwn(overrides, id)) return def;
	const binding = overrides[id];
	if (binding === null) return null;
	if (!binding || !validateShortcutBinding(binding, id)) return null;
	return {
		...def,
		meta: false,
		ctrl: false,
		alt: false,
		shift: false,
		...binding,
	};
}

export function getShortcutAliases(
	id: ShortcutId,
	overrides: ShortcutOverrides = loadSettings().shortcutOverrides ?? {},
): ShortcutDef[] {
	return Object.hasOwn(overrides, id) ? [] : (ALIASES[id] ?? []);
}

function chordEvent(binding: ShortcutDisplay): ShortcutKeyEvent {
	const mac = getPlatformOS() === "macos";
	return {
		key: binding.key,
		code: "",
		metaKey: mac && Boolean(binding.meta),
		ctrlKey: Boolean(binding.ctrl || (!mac && binding.meta)),
		altKey: Boolean(binding.alt),
		shiftKey: Boolean(binding.shift),
	};
}

const NATIVE_MENU_SHORTCUTS: ReadonlySet<ShortcutId> = new Set([
	"settings",
	"newWindow",
	"openVault",
	"createVault",
	"refreshTree",
	"closeTab",
	"toggleSidebar",
	"splitPane",
	"toggleChat",
]);

/** Native menu accelerators overlap every scope; renderer-only actions keep overlay scopes. */
export function findShortcutConflict(
	id: ShortcutId,
	binding: ShortcutDisplay,
	overrides: ShortcutOverrides = loadSettings().shortcutOverrides ?? {},
): ShortcutId | null {
	const own = SHORTCUTS.find((item) => item.id === id);
	if (!own) return null;
	for (const item of SHORTCUTS) {
		if (item.id === id) continue;
		if (
			!(
				getPlatformOS() === "macos" &&
				(NATIVE_MENU_SHORTCUTS.has(id) || NATIVE_MENU_SHORTCUTS.has(item.id))
			) &&
			((own.whenSettingsOpen && item.whenSettingsClosed) ||
				(own.whenSettingsClosed && item.whenSettingsOpen))
		)
			continue;
		const effective = getShortcut(item.id, overrides);
		if (!effective) continue;
		for (const candidate of [
			effective,
			...getShortcutAliases(item.id, overrides),
		]) {
			if (
				matchShortcut(chordEvent(binding), candidate) ||
				matchShortcut(chordEvent(candidate), binding)
			)
				return item.id;
		}
	}
	return null;
}

const NON_CHARACTER_KEYS = new Set([
	"Escape",
	"Enter",
	"Tab",
	"Backspace",
	"Delete",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
]);

/** Keep typing, native text editing, and OS window controls available. */
export function validateShortcutBinding(
	binding: ShortcutDisplay,
	id?: ShortcutId,
): boolean {
	if (
		!(
			binding.key.length === 1 ||
			NON_CHARACTER_KEYS.has(binding.key) ||
			/^F([1-9]|1\d|2[0-4])$/.test(binding.key)
		)
	)
		return false;
	if (
		/\s/.test(binding.key) ||
		[...binding.key].some(
			(key) => key.charCodeAt(0) < 32 || key.charCodeAt(0) === 127,
		)
	)
		return false;
	if (
		!binding.meta &&
		!binding.ctrl &&
		!binding.alt &&
		binding.key !== "Escape" &&
		!/^F([1-9]|1\d|2[0-4])$/.test(binding.key)
	)
		return false;
	const mac = getPlatformOS() === "macos";
	if (
		mac &&
		id &&
		NATIVE_MENU_SHORTCUTS.has(id) &&
		binding.alt &&
		!binding.meta &&
		!binding.ctrl
	)
		return false;
	const primary = mac
		? binding.meta && !binding.ctrl
		: binding.meta || binding.ctrl;
	if (primary && !binding.alt) {
		const key = binding.key.toLowerCase();
		const reserved = binding.shift
			? ["z", "s", "q"]
			: ["a", "c", "x", "v", "z", "f", "g", "s", "b", "i", "u", "q", "h", "m"];
		if (reserved.includes(key)) {
			return (
				(key === "x" && id === "cutTreeItem") ||
				(key === "v" && id === "pasteTreeItem")
			);
		}
	}
	if (mac && binding.meta) {
		if (binding.key === "Tab" || binding.key === " ") return false;
		if (binding.alt && binding.key === "Escape") return false;
		if (
			binding.ctrl &&
			!binding.alt &&
			!binding.shift &&
			binding.key.toLowerCase() === "f"
		)
			return false;
	}
	if (
		!mac &&
		binding.alt &&
		!binding.meta &&
		!binding.ctrl &&
		(binding.key === "F4" || binding.key === "Tab")
	)
		return false;
	return true;
}

/** Normalize platform primary modifiers and composed macOS Option letters. */
export function shortcutFromEvent(
	event: ShortcutKeyEvent & { isComposing?: boolean; repeat?: boolean },
): ShortcutDisplay | null {
	if (
		event.isComposing ||
		event.repeat ||
		[
			"Dead",
			"Process",
			"Unidentified",
			"Alt",
			"Control",
			"Meta",
			"Shift",
			"AltGraph",
		].includes(event.key)
	)
		return null;
	let key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	if (event.altKey && /^Key[A-Z]$/.test(event.code))
		key = event.code.slice(3).toLowerCase();
	const mac = getPlatformOS() === "macos";
	return {
		key,
		meta: mac ? event.metaKey : event.ctrlKey || event.metaKey,
		ctrl: mac && event.ctrlKey,
		alt: event.altKey,
		shift: event.shiftKey,
	};
}
