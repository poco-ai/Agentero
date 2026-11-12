import {
	type PdfAnnotationObject,
	PdfAnnotationSubtype,
	type PdfHighlightAnnoObject,
} from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation";

const HIGHLIGHT_OVERRIDE_FIELDS = [
	"contents",
	"strokeColor",
	"color",
	"opacity",
	"custom",
] as const satisfies readonly (keyof PdfHighlightAnnoObject)[];

export type HighlightAnnotationOverride = {
	pageIndex: number;
	id: string;
	patch: Partial<PdfHighlightAnnoObject>;
};

export type AnnotationImportPlan = {
	imports: AnnotationTransferItem[];
	highlightOverrides: HighlightAnnotationOverride[];
};

type SerializedAnnotation = Omit<
	AnnotationTransferItem["annotation"],
	"created" | "modified"
> & {
	created?: Date | string | null;
	modified?: Date | string | null;
};

function reviveDate(value: unknown): Date | undefined {
	if (value instanceof Date)
		return Number.isNaN(value.getTime()) ? undefined : value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * `annotations.json` is JSON, so a saved annotation's `created` / `modified`
 * Date becomes an ISO string. PDFium calls Date methods directly when creating
 * the annotation, which rejects the whole import. Restore the two fields at the
 * file boundary so reopened highlights commit like freshly created ones.
 */
export function reviveAnnotationDates(
	item: AnnotationTransferItem,
): AnnotationTransferItem {
	const annotation = item.annotation as SerializedAnnotation;
	const created = reviveDate(annotation.created);
	const modified = reviveDate(annotation.modified);
	if (created === annotation.created && modified === annotation.modified)
		return item;
	return {
		...item,
		annotation: {
			...annotation,
			created,
			modified,
		} as AnnotationTransferItem["annotation"],
	};
}

function stableValueKey(value: unknown): string {
	return (
		JSON.stringify(value, (_key, nested) => {
			if (!nested || typeof nested !== "object" || Array.isArray(nested))
				return nested;
			return Object.fromEntries(
				Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
			);
		}) ?? "undefined"
	);
}

/** Native links without /NM get a fresh id on every PDFium open. */
function linkContentKey(item: AnnotationTransferItem): string | null {
	if (item.annotation?.type !== PdfAnnotationSubtype.LINK || item.ctx != null)
		return null;
	const { id: _id, ...annotation } = item.annotation;
	// Ignore only the link's transient id. Keep target ids, styles and metadata.
	// Entries with transfer context are always preserved.
	return stableValueKey({ ...item, annotation });
}

/** Compact exact link copies as well as repeated ids, without mutating input. */
export function dedupeAnnotationItems(
	items: readonly AnnotationTransferItem[],
	existing: readonly PdfAnnotationObject[] = [],
): AnnotationTransferItem[] {
	const ids = new Set(existing.map((annotation) => annotation.id));
	const links = new Set(
		existing
			.map((annotation) => linkContentKey({ annotation }))
			.filter((key): key is string => key !== null),
	);
	const result: AnnotationTransferItem[] = [];
	for (const item of items) {
		const id = item.annotation?.id;
		if (id && ids.has(id)) continue;
		const key = linkContentKey(item);
		if (key !== null && links.has(key)) continue;
		if (id) ids.add(id);
		if (key !== null) links.add(key);
		result.push(item);
	}
	return result;
}

function highlightOverridePatch(
	existing: PdfHighlightAnnoObject,
	saved: PdfHighlightAnnoObject,
): Partial<PdfHighlightAnnoObject> | null {
	const patch: Record<string, unknown> = {};
	for (const key of HIGHLIGHT_OVERRIDE_FIELDS) {
		if (stableValueKey(existing[key]) === stableValueKey(saved[key])) continue;
		patch[key] = saved[key];
	}
	return Object.keys(patch).length
		? (patch as Partial<PdfHighlightAnnoObject>)
		: null;
}

/**
 * Same-id highlights already exist in the native PDF, but their sidecar copy
 * may contain the user's comment, colour and app metadata. Re-importing that
 * id would append a duplicate page entry, so plan those values as updates.
 */
export function planAnnotationItemImport(
	items: readonly AnnotationTransferItem[],
	existing: readonly PdfAnnotationObject[] = [],
): AnnotationImportPlan {
	const existingById = new Map(
		existing.map((annotation) => [annotation.id, annotation]),
	);
	const imports: AnnotationTransferItem[] = [];
	const highlightOverrides = new Map<string, HighlightAnnotationOverride>();

	for (const item of items) {
		const annotation = item.annotation;
		const current = annotation?.id
			? existingById.get(annotation.id)
			: undefined;
		if (
			current?.type === PdfAnnotationSubtype.HIGHLIGHT &&
			annotation?.type === PdfAnnotationSubtype.HIGHLIGHT
		) {
			const patch = highlightOverridePatch(current, annotation);
			if (patch) {
				highlightOverrides.set(`${current.pageIndex}:${current.id}`, {
					pageIndex: current.pageIndex,
					id: current.id,
					patch,
				});
			}
			continue;
		}
		imports.push(item);
	}

	return {
		imports: dedupeAnnotationItems(imports, existing),
		highlightOverrides: [...highlightOverrides.values()],
	};
}
