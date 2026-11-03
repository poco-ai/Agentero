import type { MermaidConfig } from "@streamdown/mermaid";

export type MermaidThemeMode = "light" | "dark";

/**
 * Mermaid paints its own SVG, so it cannot read the app's `oklch()` tokens:
 * it hands every theme variable to `khroma`, which only understands
 * hex/rgb/hsl. These palettes are the sRGB equivalents of the neutrals in
 * `src/index.css` (`:root` / `.dark`), kept neutral so diagrams sit inside the
 * chat/editor surface instead of becoming their own color scheme.
 */
const LIGHT = {
	canvas: "#fdfdff",
	node: "#f2f5f9",
	nodeBorder: "#dce0e5",
	text: "#16181c",
	mutedText: "#595e66",
	line: "#8d939c",
	cluster: "#f6f8fb",
	clusterBorder: "#e3e7ec",
	edgeLabel: "#fdfdff",
	note: "#eff2f6",
	noteBorder: "#dce0e5",
	noteText: "#16181c",
	activation: "#e6ebf2",
} as const;

const DARK = {
	canvas: "#0b0c0f",
	node: "#212327",
	nodeBorder: "#3a3c40",
	text: "#f7f8fb",
	mutedText: "#a0a5ac",
	line: "#767b84",
	cluster: "#14161a",
	clusterBorder: "#2b2f35",
	edgeLabel: "#0b0c0f",
	note: "#212327",
	noteBorder: "#3a3c40",
	noteText: "#f7f8fb",
	activation: "#2b3038",
} as const;

const FALLBACK_FONT =
	'system-ui, "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", sans-serif';

/** Typography follows Settings → Appearance → Fonts, like the rest of the UI. */
function readFontFamily(): string {
	if (typeof window === "undefined") return FALLBACK_FONT;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue("--agentero-font-sans")
		.trim();
	return value || FALLBACK_FONT;
}

function themeVariables(mode: MermaidThemeMode, fontFamily: string) {
	const p = mode === "dark" ? DARK : LIGHT;
	const isDark = mode === "dark";
	return {
		darkMode: isDark,
		background: p.canvas,
		fontFamily,
		fontSize: "13px",

		// Nodes, clusters and edge labels.
		primaryColor: p.node,
		primaryTextColor: p.text,
		primaryBorderColor: p.nodeBorder,
		mainBkg: p.node,
		nodeBorder: p.nodeBorder,
		nodeTextColor: p.text,
		secondaryColor: p.cluster,
		secondaryTextColor: p.text,
		secondaryBorderColor: p.clusterBorder,
		tertiaryColor: p.canvas,
		tertiaryTextColor: p.text,
		textColor: p.text,
		titleColor: p.text,
		clusterBkg: p.cluster,
		clusterBorder: p.clusterBorder,
		edgeLabelBackground: p.edgeLabel,
		labelBackground: p.cluster,
		labelTextColor: p.text,

		// Edges.
		lineColor: p.line,
		defaultLinkColor: p.line,
		arrowheadColor: p.line,

		// Sequence diagrams.
		actorBkg: p.node,
		actorBorder: p.nodeBorder,
		actorLineColor: p.clusterBorder,
		actorTextColor: p.text,
		signalColor: p.mutedText,
		signalTextColor: p.text,
		labelBoxBkgColor: p.cluster,
		labelBoxBorderColor: p.clusterBorder,
		loopTextColor: p.mutedText,
		noteBkgColor: p.note,
		noteBorderColor: p.noteBorder,
		noteTextColor: p.noteText,
		activationBkgColor: p.activation,
		activationBorderColor: p.nodeBorder,
		sequenceNumberColor: p.canvas,
	};
}

/**
 * Neutral geometry tuned for dense research notes: labels wrap before nodes
 * get wide, ranks keep a readable gap, and edges curve like the rest of the
 * app's diagram styling instead of meeting at hard elbows.
 */
function baseConfig(mode: MermaidThemeMode, fontFamily: string): MermaidConfig {
	return {
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		theme: "base",
		fontFamily,
		fontSize: 13,
		htmlLabels: true,
		markdownAutoWrap: true,
		flowchart: {
			curve: "basis",
			nodeSpacing: 40,
			rankSpacing: 48,
			padding: 12,
			diagramPadding: 8,
			wrappingWidth: 220,
			useMaxWidth: true,
		},
		sequence: {
			actorMargin: 56,
			boxMargin: 8,
			noteMargin: 8,
			messageMargin: 40,
			mirrorActors: false,
			wrap: true,
			wrapPadding: 8,
			useMaxWidth: true,
		},
		class: { useMaxWidth: true },
		state: { useMaxWidth: true },
		er: { useMaxWidth: true },
		gantt: { useMaxWidth: true },
		themeVariables: themeVariables(mode, fontFamily),
	};
}

let cachedKey = "";
let cachedConfig: MermaidConfig | null = null;

/**
 * Mermaid config for the active theme, cached so repeated renders keep the
 * same object identity. Streamdown and the editor both compare the config by
 * reference; a fresh object per render would re-render every diagram.
 */
export function getMermaidConfig(mode: MermaidThemeMode): MermaidConfig {
	const fontFamily = readFontFamily();
	const key = `${mode}\u0000${fontFamily}`;
	if (cachedConfig && cachedKey === key) return cachedConfig;
	cachedConfig = baseConfig(mode, fontFamily);
	cachedKey = key;
	return cachedConfig;
}
