import type { SettingsSection } from "@/components/settings/types";

/**
 * Searchable settings rows. `group` is an i18n key for the section label a row
 * lives under; entries without one show only the settings section in the path.
 *
 * Rows are matched against their rendered label text, so a label key must stay
 * in sync with the `t(...)` call used by the pane. Add an entry when adding a
 * settings row.
 */
const CATALOG = {
	general: [
		{
			group: "general.sections.system",
			labels: ["general.terminalApp.label", "general.finder.label"],
		},
		{
			group: "general.sections.papers",
			labels: [
				"general.paperTreeLabelMode.label",
				"general.paperTreeSortMode.label",
				"general.paperNoteMode.label",
				"general.autoOpenPaperNotes.label",
				"general.autoIngest.label",
				"general.replaceCurrentTabOnOpenPaper.label",
				"general.autoUpdateInternalLinks.label",
				"general.batchImportConcurrency.label",
			],
		},
		{
			group: "general.sections.network",
			labels: [
				"general.networkProxy.label",
				"general.institutionProxy.label",
				"general.institutionProxy.typeLabel",
				"general.institutionProxy.cookieLabel",
			],
		},
		{
			group: "general.sections.integrations",
			labels: [
				"general.openreviewAuth.label",
				"general.alphaxiv.label",
				"general.alphaxiv.keyLabel",
				"general.connector.label",
				"general.connector.portLabel",
				"word.label",
			],
		},
		{
			group: "general.easyScholar.section",
			labels: [
				"general.easyScholar.keyLabel",
				"general.easyScholar.ranksLabel",
			],
		},
		{
			group: "general.sections.mcp",
			labels: [
				"general.mcp.label",
				"general.mcp.allowWrite",
				"general.mcp.allowOnline",
				"general.mcp.exposeText.label",
				"general.mcp.portLabel",
				"general.mcp.tunnel.label",
				"general.mcp.tunnel.tunnelIdLabel",
				"general.mcp.tunnel.apiKeyLabel",
			],
		},
		{
			group: "general.privacy.section",
			labels: [
				"general.privacy.telemetry.label",
				"general.privacy.clearUsage.label",
			],
		},
	],
	appearance: [
		{
			labels: [
				"appearance.themeLabel",
				"appearance.uiThemeLabel",
				"appearance.languageLabel",
				"appearance.uiScale.label",
				"appearance.sound.label",
				"appearance.plaza.label",
			],
		},
		{
			group: "appearance.fonts.section",
			labels: [
				"appearance.fonts.interface",
				"appearance.fonts.text",
				"appearance.fonts.mono",
			],
		},
		{
			group: "appearance.markdownEditor.section",
			labels: [
				"appearance.fontSize.label",
				"appearance.lineHeight.label",
				"appearance.wikiEmbedFontSize.label",
				"appearance.markdownMaxWidth.label",
				"appearance.editorToolbar.label",
			],
		},
		{
			group: "appearance.sections.pdf",
			labels: [
				"appearance.pdfScrollStrategy.label",
				"appearance.pdfVimKeys.label",
				"appearance.pdfSpreadMode.label",
				"appearance.pdfTranslateTab.label",
				"appearance.pdfSentenceHover.label",
				"appearance.pdfCommentDisplay.label",
			],
		},
	],
	agent: [
		{
			labels: [
				"agent.permission.label",
				"agent.autoPaperReader.label",
				"agent.responseLanguage.label",
				"agent.personalPrompt.label",
			],
		},
		{
			group: "agent.defaultAgent.section",
			labels: ["agent.defaultAgent.label"],
		},
		{
			group: "agent.embedding.section",
			labels: [
				"agent.embedding.agentero",
				"agent.embedding.source.label",
				"agent.embedding.baseUrl.label",
				"agent.embedding.apiKey.label",
				"agent.embedding.model.label",
			],
		},
		{
			group: "agent.userAgent.section",
			labels: ["agent.userAgent.label", "agent.userAgent.providerIdsLabel"],
		},
	],
	translate: [
		{
			labels: [
				"translate.provider.label",
				"translate.targetLang.label",
				"translate.dictionaryMode.label",
				"translate.alwaysShowCard.label",
				"translate.autoSelection.label",
			],
		},
		{
			group: "translate.providerConfig.section",
			labels: [
				"translate.providerConfig.apiKey.label",
				"translate.providerConfig.baseUrl.label",
				"translate.providerConfig.model.label",
				"translate.providerConfig.concurrency.label",
				"translate.providerConfig.extraRequestBody.label",
			],
		},
		{
			group: "translate.autoTranslation.section",
			labels: [
				"translate.autoImport.label",
				"translate.autoImport.concurrency.label",
			],
		},
		{
			group: "translate.cache.section",
			labels: [
				"translate.cache.ir.label",
				"translate.cache.final.label",
				"translate.cache.dictionary.label",
			],
		},
	],
	layout: [
		{
			labels: ["layout.backend.label", "layout.parserBackend.label"],
		},
		{
			group: "layout.providerConfig.section",
			labels: [
				"layout.providerConfig.apiKey.label",
				"layout.providerConfig.baseUrl.label",
				"layout.providerConfig.model.label",
				"layout.providerConfig.prompt.label",
				"layout.providerConfig.language.label",
				"layout.providerConfig.selfHosted.label",
			],
		},
	],
	experimental: [
		{
			group: "experimental.decision.section",
			labels: [
				"experimental.decision.smartHighlight",
				"experimental.decision.concurrency.label",
				"experimental.decision.timeout.label",
				"experimental.decision.provider.label",
				"experimental.decision.apiKey.label",
				"experimental.decision.baseUrl.label",
				"experimental.decision.model.label",
			],
		},
	],
	sync: [
		{
			labels: [
				"sync.autoSync",
				"sync.interval",
				"sync.space",
				"sync.gitRemote",
				"sync.gitBranch",
				"sync.gitAllowInsecureHttp",
				"sync.gitSslCa",
				"sync.serverUrl",
				"sync.username",
				"sync.password",
				"sync.endpoint",
				"sync.bucket",
				"sync.accessKey",
				"sync.secretKey",
				"sync.region",
				"sync.prefix",
				"sync.pathStyle",
				"sync.scopePdf",
				"sync.scopeSource",
				"sync.scopeAttachments",
				"sync.scopeTranslation",
				"sync.allowDegradedSync",
			],
		},
	],
	"remote-access": [
		{
			labels: ["remoteAccess.hostName.label"],
		},
		{
			group: "remoteAccess.cache.section",
			labels: ["remoteAccess.cache.label"],
		},
	],
	keyboard: [
		{
			labels: ["keyboard.vimMode", "shortcuts:hintModeEnabled"],
		},
	],
	about: [
		{
			labels: [
				"about.logs.label",
				"about.scratch.label",
				"about.reflowCache.label",
				"about.cli.label",
				"about.feedback.label",
			],
		},
	],
} satisfies Partial<
	Record<SettingsSection, { group?: string; labels: readonly string[] }[]>
>;

export type SettingsSearchHit = {
	section: SettingsSection;
	label: string;
	path: string;
	labelKey: string;
};

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function searchSettings(
	query: string,
	t: (key: string) => string,
): SettingsSearchHit[] {
	const needle = normalizeText(query);
	if (!needle) return [];

	const scored: { hit: SettingsSearchHit; rank: number; order: number }[] = [];
	const seen = new Set<string>();
	let order = 0;
	for (const [section, groups] of Object.entries(CATALOG) as [
		SettingsSection,
		{ group?: string; labels: readonly string[] }[],
	][]) {
		const sectionLabel = t(`nav.${section}`);
		for (const group of groups) {
			const groupLabel = group.group ? t(group.group) : "";
			const path = groupLabel
				? `${sectionLabel} › ${groupLabel}`
				: sectionLabel;
			for (const labelKey of group.labels) {
				const label = t(labelKey);
				const normalizedLabel = normalizeText(label);
				let rank: number;
				if (normalizedLabel === needle) rank = 0;
				else if (normalizedLabel.startsWith(needle)) rank = 1;
				else if (normalizedLabel.includes(needle)) rank = 2;
				else if (normalizeText(path).includes(needle)) rank = 3;
				else {
					order += 1;
					continue;
				}
				const key = `${section}|${label}`;
				if (seen.has(key)) {
					order += 1;
					continue;
				}
				seen.add(key);
				scored.push({
					hit: { section, label, path, labelKey },
					rank,
					order,
				});
				order += 1;
			}
		}
	}
	return scored
		.sort((a, b) => a.rank - b.rank || a.order - b.order)
		.map((entry) => entry.hit);
}

/**
 * Find the rendered row for `label` inside a mounted settings pane. Rows whose
 * label wraps extra chips still match by containment; the shortest match wins.
 */
export function findSettingsRow(
	root: ParentNode,
	label: string,
): HTMLElement | null {
	const needle = normalizeText(label);
	if (!needle) return null;
	let best: { row: HTMLElement; score: number; length: number } | null = null;
	for (const row of root.querySelectorAll<HTMLElement>("[data-settings-row]")) {
		const labelNode = row.querySelector("[data-settings-label]");
		const text = normalizeText((labelNode ?? row).textContent ?? "");
		if (!text) continue;
		let score: number;
		if (text === needle) score = 0;
		else if (text.includes(needle) || needle.includes(text)) score = 1;
		else continue;
		if (
			!best ||
			score < best.score ||
			(score === best.score && text.length < best.length)
		) {
			best = { row, score, length: text.length };
		}
	}
	return best?.row ?? null;
}
