import { RotateCcw, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
	settingsRowClassName,
} from "@/components/settings/settings-layout";
import {
	holdNativeMenuShortcuts,
	ShortcutRecorder,
} from "@/components/settings/shortcut-recorder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getPlatformOS } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type { AppSettings } from "@/lib/settings";
import type { ShortcutOverrides } from "@/lib/settings/shortcut-bindings";
import {
	findShortcutConflict,
	formatShortcut,
	getShortcut,
	getShortcutAliases,
	SHORTCUTS,
	type ShortcutDef,
	type ShortcutDisplay,
	type ShortcutGroup,
	type ShortcutId,
	shortcutFromEvent,
} from "@/lib/shell/shortcuts";
import { revealInOsLabelKey } from "@/lib/vault/reveal";

const GROUP_KEY = {
	App: "app",
	Vault: "vault",
	Navigation: "navigation",
	Editor: "editor",
} as const satisfies Record<ShortcutGroup, string>;

const KEY_ALIASES: Record<string, string> = {
	esc: "Escape",
	escape: "Escape",
	tab: "Tab",
	space: " ",
	backspace: "Backspace",
	"⌫": "Backspace",
	delete: "Delete",
	del: "Delete",
	left: "ArrowLeft",
	"←": "ArrowLeft",
	arrowleft: "ArrowLeft",
	right: "ArrowRight",
	"→": "ArrowRight",
	arrowright: "ArrowRight",
	up: "ArrowUp",
	"↑": "ArrowUp",
	arrowup: "ArrowUp",
	down: "ArrowDown",
	"↓": "ArrowDown",
	arrowdown: "ArrowDown",
	comma: ",",
	period: ".",
	plus: "+",
	minus: "-",
};

function normalizeChordKey(raw: string): string {
	const token = raw.trim();
	const alias = KEY_ALIASES[token.toLowerCase()] ?? KEY_ALIASES[token];
	if (alias) return alias;
	if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
	return token.length === 1 ? token.toLowerCase() : token;
}

function sameChord(a: ShortcutDisplay, b: ShortcutDisplay): boolean {
	const key = (value: string) =>
		value.length === 1 ? value.toLowerCase() : value;
	return (
		key(a.key) === key(b.key) &&
		Boolean(a.meta) === Boolean(b.meta) &&
		Boolean(a.ctrl) === Boolean(b.ctrl) &&
		Boolean(a.alt) === Boolean(b.alt) &&
		Boolean(a.shift) === Boolean(b.shift)
	);
}

/** Parse a typed chord such as ⌘L, ⇧⌘L, or cmd+shift+l. Bare words stay text. */
export function parseShortcutQuery(raw: string): ShortcutDisplay | null {
	const text = raw.trim();
	if (!text) return null;
	const binding: ShortcutDisplay = { key: "" };
	let rest = text;
	let sawSymbol = false;
	const symbols = [
		["⌘", "meta"],
		["⇧", "shift"],
		["⌥", "alt"],
		["⌃", "ctrl"],
	] as const;
	while (rest.length > 0) {
		const symbol = symbols.find(([mark]) => rest.startsWith(mark));
		if (!symbol) break;
		binding[symbol[1]] = true;
		rest = rest.slice(symbol[0].length);
		sawSymbol = true;
	}
	if (sawSymbol) {
		if (!rest) return null;
		binding.key = normalizeChordKey(rest);
		return binding;
	}
	const parts = text.split(/\s*\+\s*/).filter(Boolean);
	if (parts.length < 2) return null;
	const key = parts.pop();
	if (!key) return null;
	for (const part of parts) {
		const mod = part.toLowerCase();
		if (["cmd", "command", "meta", "⌘"].includes(mod)) binding.meta = true;
		else if (["shift", "⇧"].includes(mod)) binding.shift = true;
		else if (["alt", "option", "⌥"].includes(mod)) binding.alt = true;
		else if (["ctrl", "control", "⌃"].includes(mod)) binding.ctrl = true;
		else return null;
	}
	if (getPlatformOS() !== "macos" && binding.ctrl && !binding.meta) {
		binding.meta = true;
		binding.ctrl = false;
	}
	binding.key = normalizeChordKey(key);
	return binding.key ? binding : null;
}

function isSearchChord(chord: ShortcutDisplay): boolean {
	const key = chord.key.toLowerCase();
	const editing =
		["a", "c", "v", "x", "z"].includes(key) &&
		chord.meta &&
		!chord.shift &&
		!chord.alt &&
		!chord.ctrl;
	if (editing) return false;
	return Boolean(
		chord.meta || chord.ctrl || chord.alt || /^f([1-9]|1\d|2[0-4])$/i.test(key),
	);
}

export function KeyboardPane({
	settings,
	shortcutOverrides: overrides,
	patch,
}: {
	settings: AppSettings;
	shortcutOverrides: ShortcutOverrides;
	patch: (settings: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "shortcuts", "sidebar"]);
	const [resetVersion, setResetVersion] = useState(0);
	const [query, setQuery] = useState("");
	const [chordQuery, setChordQuery] = useState<ShortcutDisplay | null>(null);
	const menuHold = useRef<(() => void) | null>(null);
	const commandLabel = (id: ShortcutId) =>
		id === "revealInFinder"
			? t(`sidebar:${revealInOsLabelKey()}`)
			: t(`shortcuts:labels.${id}`);

	const visible = SHORTCUTS.filter((def) => {
		if (
			def.platforms?.length &&
			!def.platforms.some((platform) => platform === getPlatformOS())
		) {
			return false;
		}
		const text = query.trim();
		if (!text && !chordQuery) return true;
		const binding = getShortcut(def.id, overrides);
		const chords = [binding, ...getShortcutAliases(def.id, overrides)].filter(
			(item): item is ShortcutDef => item !== null,
		);
		if (chordQuery) return chords.some((item) => sameChord(item, chordQuery));
		if (commandLabel(def.id).toLowerCase().includes(text.toLowerCase())) {
			return true;
		}
		const parsed = parseShortcutQuery(text);
		if (parsed) return chords.some((item) => sameChord(item, parsed));
		return chords.some((item) =>
			formatShortcut(item).toLowerCase().includes(text.toLowerCase()),
		);
	});
	const matched = visible.length > 0;

	return (
		<>
			<PageTitle
				title={t("keyboard.title")}
				actions={
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={Object.keys(overrides).length === 0}
						onClick={() => {
							patch({ shortcutOverrides: {} });
							setResetVersion((version) => version + 1);
						}}
					>
						<RotateCcw aria-hidden data-icon="inline-start" />
						<span className="max-sm:sr-only">{t("keyboard.restoreAll")}</span>
					</Button>
				}
			/>
			<div className="relative mb-5">
				<Search
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					value={query}
					placeholder={t("keyboard.search")}
					aria-label={t("keyboard.search")}
					data-shortcut-search=""
					className="pl-8"
					onFocus={() => {
						menuHold.current ??= holdNativeMenuShortcuts().release;
					}}
					onBlur={() => {
						menuHold.current?.();
						menuHold.current = null;
					}}
					onChange={(event) => {
						setQuery(event.target.value);
						setChordQuery(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape" && (query || chordQuery)) {
							event.preventDefault();
							event.stopPropagation();
							setQuery("");
							setChordQuery(null);
							return;
						}
						const chord = shortcutFromEvent(event.nativeEvent);
						if (!chord || !isSearchChord(chord)) return;
						event.preventDefault();
						event.stopPropagation();
						setChordQuery(chord);
						setQuery(formatShortcut(chord));
					}}
				/>
			</div>
			<SettingsGroup>
				<SettingsRow
					label={t("shortcuts:hintModeEnabled")}
					htmlFor="hint-mode-enabled"
					description={
						settings.vimMode ? undefined : t("shortcuts:requiresVimMode")
					}
				>
					<Switch
						id="hint-mode-enabled"
						disabled={!settings.vimMode}
						aria-checked={settings.hintModeEnabled}
						checked={settings.hintModeEnabled}
						onCheckedChange={(checked) => patch({ hintModeEnabled: checked })}
					/>
				</SettingsRow>
			</SettingsGroup>
			{matched ? (
				(Object.keys(GROUP_KEY) as ShortcutGroup[]).map((group) => {
					const items = visible.filter((def) => def.group === group);
					if (items.length === 0) return null;
					return (
						<div key={group}>
							<SettingsSectionLabel>
								{t(`shortcuts:groups.${GROUP_KEY[group]}`)}
							</SettingsSectionLabel>
							<SettingsGroup>
								{items.map((def) => (
									<ShortcutRow
										key={`${def.id}-${resetVersion}`}
										def={def}
										binding={getShortcut(def.id, overrides)}
										shortcutOverrides={overrides}
										patch={patch}
									/>
								))}
							</SettingsGroup>
						</div>
					);
				})
			) : (
				<p className="px-1 text-sm text-muted-foreground">
					{t("keyboard.noResults")}
				</p>
			)}
		</>
	);
}

export function ShortcutRow({
	def,
	binding,
	shortcutOverrides,
	patch,
}: {
	def: ShortcutDef;
	binding: ShortcutDisplay | null;
	shortcutOverrides: ShortcutOverrides;
	patch: (settings: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "shortcuts", "sidebar"]);
	const [error, setError] = useState<string | null>(null);
	const commandLabel = (id: ShortcutId) =>
		id === "revealInFinder"
			? t(`sidebar:${revealInOsLabelKey()}`)
			: t(`shortcuts:labels.${id}`);
	const label = commandLabel(def.id);

	const update = (next: ShortcutDisplay | null, restore = false) => {
		const overrides = { ...shortcutOverrides };
		const candidates = next
			? [next, ...(restore ? getShortcutAliases(def.id, {}) : [])]
			: [];
		const conflict = candidates
			.map((candidate) => findShortcutConflict(def.id, candidate, overrides))
			.find((owner) => owner !== null);
		if (conflict) {
			setError(t("shortcuts:conflict", { command: commandLabel(conflict) }));
			return false;
		}
		if (restore) delete overrides[def.id];
		else overrides[def.id] = next;
		patch({ shortcutOverrides: overrides });
		setError(null);
		return true;
	};

	return (
		<div className={cn(settingsRowClassName, "group")}>
			<span className="min-w-0 truncate text-sm text-foreground">{label}</span>
			<div className="relative flex shrink-0 items-start">
				<div
					className={cn(
						"absolute right-full top-0 z-10 flex h-8 items-center pr-0.5",
						"pointer-events-none opacity-0",
						"transition-opacity duration-150 ease-out motion-reduce:transition-none",
						"group-hover:pointer-events-auto group-hover:opacity-100",
						"group-focus-within:pointer-events-auto group-focus-within:opacity-100",
					)}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								tabIndex={-1}
								disabled={!binding?.key}
								aria-label={t("keyboard.clear", { command: label })}
								onClick={() => update(null)}
							>
								<X aria-hidden className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("keyboard.clearHint")}</TooltipContent>
					</Tooltip>
					{Object.hasOwn(shortcutOverrides, def.id) ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									tabIndex={-1}
									aria-label={t("keyboard.restore", { command: label })}
									onClick={() => update(def, true)}
								>
									<RotateCcw aria-hidden className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("keyboard.restoreHint")}</TooltipContent>
						</Tooltip>
					) : null}
				</div>
				<ShortcutRecorder
					id={def.id}
					label={label}
					binding={binding}
					error={error}
					onError={setError}
					onRecord={(next) => update(next)}
				/>
			</div>
		</div>
	);
}
