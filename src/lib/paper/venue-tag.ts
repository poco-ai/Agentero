/**
 * Venue tag helpers: `#venue:<published>` (authoritative) and
 * `#submitted:<conference> <year>` (arXiv-template guess) namespaces.
 *
 * Mirrors the `#easyscholar:` convention: the namespace prefix is storage
 * detail and is stripped for display (the raw name stays in the tooltip).
 */

export const VENUE_TAG_PREFIX = "#venue:";
export const SUBMITTED_TAG_PREFIX = "#submitted:";

export function isVenueTagName(name: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(VENUE_TAG_PREFIX);
}

export function isSubmittedTagName(name: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(SUBMITTED_TAG_PREFIX);
}

/** Whether the tag belongs to either venue namespace. */
export function isVenueNamespaceTag(name: string): boolean {
	return isVenueTagName(name) || isSubmittedTagName(name);
}

/** Display label with the namespace prefix removed. */
export function formatVenueTag(name: string): string {
	const trimmed = name.trim();
	const lower = trimmed.toLocaleLowerCase();
	if (lower.startsWith(VENUE_TAG_PREFIX)) {
		return trimmed.slice(VENUE_TAG_PREFIX.length);
	}
	if (lower.startsWith(SUBMITTED_TAG_PREFIX)) {
		return trimmed.slice(SUBMITTED_TAG_PREFIX.length);
	}
	return name;
}
