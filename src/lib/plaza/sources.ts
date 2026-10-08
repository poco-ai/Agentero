/**
 * 广场（Plaza）— external discovery sources.
 *
 * Virtual tree/tab paths only; nothing here ever touches disk. Adding a source
 * is a single {@link PLAZA_SOURCES} entry — the sidebar child row and the
 * center panel both derive from this registry.
 *
 * @see docs/development/plaza.md
 */

import i18n from "@/i18n";

/** Virtual tree/tab path for the Plaza parent node. */
export const PLAZA_VIRTUAL_PATH = "agentero:plaza";

/**
 * Icon key for a plaza source. Lib only carries the name; the
 * name→component map lives in the components layer
 * (`components/plaza/source-icons.ts`).
 */
export type PlazaSourceIcon =
	| "coolPapers"
	| "modelScope"
	| "sparkles"
	| "rss"
	| "telescope"
	| "calendarClock";

export type PlazaSource = {
	id: string;
	/** `agentero:plaza/<id>` — virtual, never a filesystem path. */
	path: string;
	label: string;
	/**
	 * Canonical public site: used for "open in browser", and embedded directly
	 * when there is no proxy. `null` with no {@link panel} is a placeholder.
	 */
	url: string | null;
	/** Native plaza panel (not an iframe). */
	panel?: "skills" | "feeds" | "arxivRec" | "ccfDeadlines";
	/**
	 * Host proxy scheme origin used for embedding. A cross-origin frame cannot
	 * retarget the site's `target="_blank"` links or report its navigations, so
	 * sources meant for in-frame browsing are served under our own scheme.
	 * `null` embeds {@link url} as-is.
	 */
	embedOrigin: (() => string) | null;
	/** Icon name; rendered through the components-layer icon map. */
	icon: PlazaSourceIcon;
};

function sourcePath(id: string): string {
	return `${PLAZA_VIRTUAL_PATH}/${id}`;
}

/** Custom-scheme origin, spelled the way each platform's WebView expects. */
function schemeOrigin(scheme: string): string {
	// Windows WebView2 intercepts http(s)://<scheme>.localhost; the filter is
	// registered as http:// unless useHttpsSchemeForCustomProtocol is set.
	return navigator.userAgent.includes("Windows")
		? `http://${scheme}.localhost`
		: `${scheme}://localhost`;
}

export const PLAZA_SOURCES: readonly PlazaSource[] = [
	{
		id: "cool-papers",
		path: sourcePath("cool-papers"),
		label: "Cool Papers",
		url: "https://papers.cool/",
		embedOrigin: () => schemeOrigin("agentero-coolpapers"),
		icon: "coolPapers",
	},
	{
		id: "modelscope",
		path: sourcePath("modelscope"),
		label: "ModelScope Papers",
		url: "https://modelscope.cn/papers",
		embedOrigin: () => schemeOrigin("agentero-modelscope"),
		icon: "modelScope",
	},
	{
		id: "skills",
		path: sourcePath("skills"),
		label: "Skill picks",
		url: null,
		embedOrigin: null,
		panel: "skills",
		icon: "sparkles",
	},
	{
		id: "feeds",
		path: sourcePath("feeds"),
		label: "Feeds",
		url: null,
		embedOrigin: null,
		panel: "feeds",
		icon: "rss",
	},
	{
		id: "arxiv-rec",
		path: sourcePath("arxiv-rec"),
		label: "arXiv Daily",
		url: null,
		embedOrigin: null,
		panel: "arxivRec",
		icon: "telescope",
	},
	{
		id: "ccf-deadlines",
		path: sourcePath("ccf-deadlines"),
		label: "CCF Deadlines",
		url: "https://ccfddl.com/",
		embedOrigin: null,
		panel: "ccfDeadlines",
		icon: "calendarClock",
	},
];

/** True for the Plaza parent node and every source under this parent. */
export function isPlazaVirtualPath(path: string | null | undefined): boolean {
	if (!path) return false;
	return (
		path === PLAZA_VIRTUAL_PATH || path.startsWith(`${PLAZA_VIRTUAL_PATH}/`)
	);
}

export function isPlazaRootPath(path: string | null | undefined): boolean {
	return path === PLAZA_VIRTUAL_PATH;
}

/** The source owning this path, or `null` for the Plaza root / non-Plaza paths. */
export function plazaSourceForPath(
	path: string | null | undefined,
): PlazaSource | null {
	if (!path) return null;
	return PLAZA_SOURCES.find((source) => source.path === path) ?? null;
}

/** Sources not hidden by the user (`plazaHiddenSources` setting). */
export function visiblePlazaSources(
	hiddenIds: readonly string[],
): PlazaSource[] {
	if (hiddenIds.length === 0) return [...PLAZA_SOURCES];
	const hidden = new Set(hiddenIds);
	return PLAZA_SOURCES.filter((source) => !hidden.has(source.id));
}

/** Tab title for any Plaza path. */
export function plazaSourceLabel(source: PlazaSource): string {
	switch (source.id) {
		case "skills":
			return i18n.t("sidebar:plaza.skills.title");
		case "modelscope":
			return i18n.t("sidebar:plaza.modelscope");
		case "feeds":
			return i18n.t("sidebar:plaza.feeds.label");
		case "arxiv-rec":
			return i18n.t("sidebar:plaza.arxivRec.label");
		case "ccf-deadlines":
			return i18n.t("sidebar:plaza.ccfDeadlines.label");
		default:
			return source.label;
	}
}

export function plazaTitleForPath(path: string): string {
	const source = plazaSourceForPath(path);
	return source ? plazaSourceLabel(source) : i18n.t("sidebar:plaza.plaza");
}
