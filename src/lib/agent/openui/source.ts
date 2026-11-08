import {
	cleanCitationHref,
	isAgentCitationHref,
	isVaultPdfHref,
	splitCitationHref,
} from "@/lib/agent/citation-href";
import { isTextOpenable } from "@/lib/vault/path-kinds";

/**
 * Whether a block `source` / `path` prop is an actual navigable target.
 *
 * Models sometimes put a human-readable citation label ("Table 3, Section
 * 4.2") into `source`. Treating that as a vault path resolves it against the
 * vault root and produces a raw file-open error. Only URLs, citation hrefs
 * and paths with a known openable file extension become links; everything
 * else is rendered as plain source text.
 */
export function isOpenUiSourceTarget(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	const href = cleanCitationHref(trimmed);
	if (/^https?:\/\//i.test(href)) return true;
	if (isAgentCitationHref(href) || isVaultPdfHref(href)) return true;
	const { path } = splitCitationHref(href);
	if (!path) return false;
	return isTextOpenable(path);
}
