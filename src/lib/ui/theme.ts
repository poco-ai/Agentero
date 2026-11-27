import tweakcnManifest from "@/themes/tweakcn-manifest.json";

/**
 * Bundled tweakcn UI theme presets (colors + radius only; fonts/shadows are
 * intentionally excluded so Appearance font stacks stay intact).
 * Full theme data is loaded on-demand from `@/themes/tweakcn-themes.json`;
 * the manifest only contains the metadata needed for the settings dropdown.
 *
 * `tweakcn-themes.json` is checked-in source data; the upstream fetch script
 * was removed, so palette fixes belong in the file itself.
 */
export type UiThemeMeta = {
	name: string;
	title: string;
};

export type UiThemeDef = UiThemeMeta & {
	light: Record<string, string>;
	dark: Record<string, string>;
};

export const UI_THEMES = tweakcnManifest as UiThemeMeta[];

/** Built-in look from index.css — no variable overrides injected. */
export const DEFAULT_UI_THEME = "default";

export function isKnownUiTheme(name: unknown): name is string {
	return (
		name === DEFAULT_UI_THEME ||
		(typeof name === "string" && UI_THEMES.some((t) => t.name === name))
	);
}

const STYLE_ID = "agentero-ui-theme";

let themeDataPromise: Promise<UiThemeDef[]> | null = null;

async function loadThemeData(): Promise<UiThemeDef[]> {
	if (themeDataPromise) return themeDataPromise;
	themeDataPromise = import("@/themes/tweakcn-themes.json")
		.then((mod) => (mod as unknown as { default: UiThemeDef[] }).default)
		.catch((e) => {
			themeDataPromise = null;
			throw e;
		});
	return themeDataPromise;
}

/** Load bundled variables for consumers that render theme previews. */
export function loadUiThemes(): Promise<UiThemeDef[]> {
	return loadThemeData();
}

function toCssBlock(selector: string, vars: Record<string, string>): string {
	const body = Object.entries(vars)
		.map(([k, v]) => `\t--${k}: ${v};`)
		.join("\n");
	return `${selector} {\n${body}\n}`;
}

/**
 * Override index.css variables by appending a <style> at the end of <head>
 * (same specificity, later order wins). `default`/unknown removes the override.
 *
 * Full theme data is fetched lazily so the settings dropdown does not have to
 * parse the whole ~100KB variable table up front.
 */
export async function applyUiTheme(name: string): Promise<void> {
	if (typeof document === "undefined") return;
	const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

	if (name === DEFAULT_UI_THEME || !isKnownUiTheme(name)) {
		existing?.remove();
		return;
	}

	const themes = await loadUiThemes();
	const theme = themes.find((t) => t.name === name);
	if (!theme) {
		existing?.remove();
		return;
	}

	const el =
		(existing as HTMLStyleElement | null) ?? document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = `${toCssBlock(":root", theme.light)}\n${toCssBlock(".dark", theme.dark)}`;

	// Re-append only when the node is missing or no longer the last child
	// (e.g. Vite HMR injected styles after it in dev). Otherwise leave it in
	// place to avoid unnecessary style recalculation.
	if (el.parentNode !== document.head || el.nextSibling !== null) {
		document.head.appendChild(el);
	}
}
