/**
 * Paper tag semantics (P2-18b: moved down from `lib/ui/tag-colors.ts`,
 * which keeps only the color-token mapping).
 */
import type { PaperTag, PaperTagInput } from "@/lib/paper/types";
import { isTagColorId, type TagColorId } from "@/lib/ui/tag-colors";

export type { PaperTag, PaperTagInput } from "@/lib/paper/types";

/** Internal tags retained for provenance but omitted from user-facing tag UI. */
export const CONNECTOR_TAG_PREFIX = "@zotero:";
export const ARXIV_TAG_PREFIX = "@arxiv:";

/** Zotero arXiv translator `"Archive - Sub-Field"` subject labels. */
const ARXIV_CATEGORY_PREFIXES = [
	"computer science - ",
	"economics - ",
	"electrical engineering and systems science - ",
	"mathematics - ",
	"nonlinear sciences - ",
	"physics - ",
	"quantitative finance - ",
	"statistics - ",
	"astrophysics - ",
	"condensed matter - ",
	"quantitative biology - ",
	"high energy physics - ",
] as const;

export function isConnectorTagName(name: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(CONNECTOR_TAG_PREFIX);
}

export function isArxivTagName(name: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(ARXIV_TAG_PREFIX);
}

/** Unprefixed arXiv subject tags already stored in older catalogs. */
export function isArxivCategoryLabel(name: string): boolean {
	const lower = name.trim().toLocaleLowerCase();
	if (!lower) return false;
	return ARXIV_CATEGORY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isInternalTagName(name: string): boolean {
	return (
		isConnectorTagName(name) ||
		isArxivTagName(name) ||
		isArxivCategoryLabel(name)
	);
}

export function isVisiblePaperTag(tag: PaperTagInput): boolean {
	const name = typeof tag === "string" ? tag : tag?.name;
	return (
		typeof name === "string" &&
		name.trim().length > 0 &&
		!isInternalTagName(name)
	);
}

export function visiblePaperTags(tags: readonly PaperTagInput[]): PaperTag[] {
	return normalizePaperTags(tags.filter(isVisiblePaperTag));
}

export function normalizePaperTag(raw: PaperTagInput): PaperTag | null {
	if (typeof raw === "string") {
		const name = raw.trim();
		return name ? { name } : null;
	}
	if (!raw || typeof raw !== "object") return null;
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name) return null;
	const color = isTagColorId(raw.color) ? raw.color : undefined;
	return color ? { name, color } : { name };
}

/** Dedupe by name (case-insensitive); first casing wins; later color fills if empty. */
export function normalizePaperTags(tags: readonly PaperTagInput[]): PaperTag[] {
	const out: PaperTag[] = [];
	for (const raw of tags) {
		const t = normalizePaperTag(raw);
		if (!t) continue;
		const existing = out.find(
			(x) => x.name.toLocaleLowerCase() === t.name.toLocaleLowerCase(),
		);
		if (existing) {
			if (!existing.color && t.color) existing.color = t.color;
			continue;
		}
		out.push({ ...t });
	}
	return out;
}

export function tagName(t: PaperTagInput): string {
	return typeof t === "string" ? t : t.name;
}

/** Coerce API/catalog tags (string[] or mixed) into PaperTag[]. */
export function coercePaperTags(tags: unknown): PaperTag[] {
	if (!Array.isArray(tags)) return [];
	return normalizePaperTags(tags as PaperTagInput[]);
}

/** Change only one existing tag, retaining invisible provenance tags. */
export function withPaperTagColor(
	tags: unknown,
	name: string,
	color: TagColorId | null,
): PaperTag[] {
	return coercePaperTags(tags).map((tag) =>
		tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()
			? color
				? { ...tag, color }
				: { name: tag.name }
			: tag,
	);
}
