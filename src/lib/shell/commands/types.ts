/**
 * Lightweight app commands for the Command Palette (⇧⌘P).
 * Aligns with VS Code: discoverable actions, not only resource search.
 *
 * A command has one title form. Built-ins keep i18n keys. External commands
 * use plain strings so their copy is not added to the locale catalogs.
 */

export type PaletteMode = "go" | "commands";

/** Object context passed by menu surfaces to commands. */
export type MenuContext = {
	vaultPath: string | null;
	relPath?: string;
	paperId?: string;
	selectionText?: string;
};

type AppCommandBase = {
	/** Stable id, e.g. `settings.open` */
	id: string;
	/** Extra terms for fuzzy match (English keywords) */
	keywords?: string[];
	/** When false, hide from the palette. `listCommands` does not apply this. */
	when?: () => boolean;
	run: (context?: MenuContext) => void | Promise<void>;
	/** Optional semantic target support for Navigator callers. */
	navigatorAction?: import("@/lib/navigator/types").NavigatorAction;
};

/** Built-in command. Title copy lives in the `app` i18n catalog. */
export type BuiltinAppCommand = AppCommandBase & {
	/** i18n key under the `app` namespace */
	titleKey: string;
	/** Optional category i18n key for grouping / prefix display */
	categoryKey?: string;
	title?: never;
	category?: never;
};

/** In-process external command. Title copy is a plain string, not an i18n key. */
export type ExternalAppCommand = AppCommandBase & {
	title: string;
	/** Optional plain category label. Not an i18n key. */
	category?: string;
	titleKey?: never;
	categoryKey?: never;
};

export type AppCommand = BuiltinAppCommand | ExternalAppCommand;

/** `t` from `useTranslation("app")`, adapted at the palette call site. */
export type CommandTranslator = (key: string) => string;

export function commandTitle(
	command: AppCommand,
	t: CommandTranslator,
): string {
	if (isExternalCommand(command)) return command.title;
	return t(command.titleKey);
}

export function commandCategory(
	command: AppCommand,
	t: CommandTranslator,
): string {
	if (isExternalCommand(command)) return command.category ?? "";
	return command.categoryKey ? t(command.categoryKey) : "";
}

function isExternalCommand(command: AppCommand): command is ExternalAppCommand {
	return typeof command.title === "string";
}
