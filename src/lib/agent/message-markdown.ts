import { normalizeMarkdownMath } from "@/lib/markdown/math-normalize";

import { linkifyBareUrls, linkifyBareVaultCitations } from "./bare-url-link";
import { stripCitationStatusTags } from "./citation-href";
import { linkifyWikilinks } from "./wikilink-citation";

/**
 * Streamdown ships rehype-harden with `allowedLinkPrefixes: ["*"]`, but harden
 * only treats hrefs starting with `/`, `./`, or `../` as relative. Bare vault
 * paths like `papers/a/a.pdf#page=1` fail parseUrl and render as
 * `label [blocked]` with title `Blocked URL: …`.
 *
 * CommonMark angle-bracket destinations (`](<papers/foo bar/a.pdf#page=1>)`)
 * are the standard way to keep spaces, but the parsed href still does not
 * start with `./` and harden blocks it. Rewrite those to a `./` href with
 * spaces percent-encoded so harden keeps the link. {@link cleanCitationHref}
 * strips `./` and decodes `%20` on click.
 */
const UNBRACKETED_VAULT_HREF =
	/\]\(((?:\.\.?\/)*(?:papers|notes)\/[^)\s]+)\)/gi;
const ANGLE_VAULT_HREF =
	/\]\(\s*<((?:\.\.?\/)*(?:papers|notes)\/[^>\r\n]+)>\s*\)/gi;

/**
 * `./` + percent-encoded destination. `encodeURI` keeps `#` `/` and existing
 * `%XX`, but also keeps `()` — those would end the unbracketed destination
 * the next replace writes, so encode them too.
 */
function hardenSafeVaultDestination(href: string): string {
	const normalized = href.replace(/^\.\//, "");
	return `./${encodeURI(normalized).replaceAll("(", "%28").replaceAll(")", "%29")}`;
}

export function prefixVaultMarkdownHrefs(text: string): string {
	return text
		.replace(
			/\]\(<?(agentero:\/\/cite\/[a-f0-9]+\/[A-Za-z0-9_-]+(?:#excerpt=[A-Za-z0-9_-]+)?)>?\)/g,
			"](./$1)",
		)
		.replace(ANGLE_VAULT_HREF, (_full, href: string) => {
			return `](${hardenSafeVaultDestination(href)})`;
		})
		.replace(UNBRACKETED_VAULT_HREF, (_full, href: string) => {
			const normalized = href.replace(/^\.\//, "");
			return `](./${normalized})`;
		});
}

/** Prepare agent text consistently before Streamdown renders it. */
export function prepareAgentMessageMarkdown(text: string): string {
	return prefixVaultMarkdownHrefs(
		linkifyBareUrls(
			linkifyBareVaultCitations(
				linkifyWikilinks(stripCitationStatusTags(normalizeMarkdownMath(text))),
			),
		),
	);
}
