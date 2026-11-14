/**
 * In-text citation / internal PDF link behaviour for the EmbedPDF viewer:
 * activating a link (GoTo destination → scroll, URI → system browser) and the
 * hover reference card.
 *
 * The card shows the reference a citation points at. Resolution order:
 * 1. Unambiguous dest coordinate → key (hyperref `cite.<bibtexKey>` /XYZ).
 * 2. Link annotation rect → dest key (`mk:ref12`) when ACS `/FitR`
 *    bibliography entries collide on one page.
 * 3. Key → sidecar via `rawKey`, or ACS `mk:refN` → `id: "ref-N"`.
 * Links that cannot be resolved show nothing.
 *
 * Its own hook because the preview is a self-contained hover state machine —
 * a short hide delay lets the pointer travel from the link into the card.
 * Nothing else in the viewer reads it.
 *
 * The per-page link hit-target map (`citationLinks` in the highlights cluster)
 * is *not* owned here: it is a by-product of the annotation rebuild, so it
 * stays with its single writer and is passed straight into the page layers.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import type { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	pageElByIndex,
	rectBottomCenterScreen,
} from "@/components/viewer/pdf/coords";
import { EPHEMERAL_PREVIEW_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import { useStickyHoverHide } from "@/components/viewer/pdf/hooks/use-sticky-hover-hide";
import { getLinkDestination } from "@/components/viewer/pdf/layers/citation-links";
import type {
	CitationPreviewState,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import { useVaultStore } from "@/hooks/use-app-stores";
import { useCitationImport } from "@/hooks/use-citation-import";
import { usePaperRefsSidecar } from "@/hooks/use-paper-refs-sidecar";
import { usePapersOrgFolders } from "@/hooks/use-papers-org-folders";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { lookupSubmit } from "@/lib/paper/import-actions";
import type { Citation } from "@/lib/paper/refs";
import {
	type CitationDestKeyMap,
	type CitationLinkKeyList,
	citationDestKey,
	citationRefNumber,
	citationSidecarKeysForDest,
	destinationInPageBox,
	expandCitationLinkCluster,
	matchCitationLinkKey,
	type PageOrigin,
} from "@/lib/pdf/citation-dest-keys";
import { schedulePdfDestMapsBuild } from "@/lib/pdf/citation-dest-map";

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

const EMPTY_PAGE_ORIGINS: readonly PageOrigin[] = [];

export type UsePdfCitationsOptions = {
	docId: string;
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	hostRef: RefObject<HTMLDivElement | null>;
	/** Current zoom, mirrored so the preview anchor never re-creates handlers. */
	zoomRef: RefObject<number>;
	/** Vault root; with `paperPath` enables sidecar-backed preview matching. */
	vaultPath: string | null;
	/** Vault-relative paper folder of the open PDF, or null when not a paper. */
	paperPath: string | null;
	/** Absolute paper folder; used to read PDF bytes for the cite-key map. */
	paperAbsPath: string | null;
	/**
	 * PDF bytes the viewer already holds (`tab.pdfBytes`). Reused (copied) by
	 * the cite-key map build so opening a paper never reads the PDF twice.
	 */
	sourceBytes?: ArrayBuffer | null;
	/**
	 * True for remote arXiv papers with no local sidecar. Enables citation-link
	 * previews from the PDF alone and shows an import-to-library surface.
	 */
	isRemotePaper?: boolean;
	/**
	 * Identifier used by the remote-paper import surface. Usually the arXiv
	 * abs/source URL.
	 */
	importIdentifier?: string;
	/**
	 * Fired when a citation card is about to show. Used by the viewer to clear
	 * sibling ephemeral overlays (crossref preview).
	 */
	onPreviewShow?: () => void;
	/**
	 * Jump-back pairing (#505): read the viewport right before an internal
	 * link navigates, then commit only when it actually did. URI links never
	 * commit, so external opens do not pollute the origin stack.
	 */
	onBeforeInternalJump?: () => void;
	/**
	 * Fired with the destination anchor when a link actually navigated, in
	 * page-box space (see `destinationInPageBox`).
	 */
	onInternalJump?: (target: {
		pageIndex: number;
		pdfX: number | null;
		pdfY: number;
	}) => void;
};

export type PdfCitations = {
	citationPreview: CitationPreviewState | null;
	cancelCitationHide: () => void;
	scheduleCitationHide: () => void;
	/** Keep the card open while the pointer is over it (or the import menu). */
	markCitationHoverEnter: () => void;
	/** Drop the preview immediately (overlay exclusivity / suppress). */
	clearCitationPreview: () => void;
	handleCitationLinkActivate: (link: PdfLinkAnnoObject) => void;
	handleCitationLinkHover: (
		link: PdfLinkAnnoObject | null,
		clientPoint?: ScreenPoint | null,
	) => void;
	/** True when this link resolves to at least one known citation in the sidecar. */
	hasCitationMatch: (link: PdfLinkAnnoObject) => boolean;
	/** Library-import surface for the hover card; null when not a vault paper. */
	citationImport: {
		folders: string[];
		lastImportParentDir: string;
		importingId: string | null;
		importCitation: (citation: Citation, parentDir: string) => void;
	} | null;
	/** Visible-box origins. Empty until the destination map has been parsed. */
	pageOrigins: readonly PageOrigin[];
};

/**
 * Match a PDF destination key to a sidecar citation. Hyperref keys hit
 * `rawKey`; ACS `mk:refN` hits sidecar `id: "ref-N"` (no rawKey on S2 parses).
 */
function findCitationByDestKey(
	destKey: string,
	citations: Citation[],
): Citation | undefined {
	const candidates = new Set(citationSidecarKeysForDest(destKey));
	return citations.find(
		(citation) =>
			(citation.rawKey != null && candidates.has(citation.rawKey)) ||
			candidates.has(citation.id),
	);
}

/**
 * Which reference(s) a citation link points at. Prefers unambiguous dest-coord
 * keys (hyperref `/XYZ`); falls back to the link-annotation dest name when ACS
 * `/FitR` bibliography entries collide. Nearby ACS superscripts are clustered
 * so `14-18` expands to refs 14…18 (comma-separated neighbours stay separate).
 * Returns an empty list when nothing resolves, so the card does not appear.
 */
function resolveCitations(
	link: PdfLinkAnnoObject,
	destKeys: CitationDestKeyMap | null,
	citationLinks: CitationLinkKeyList | null,
	citations: Citation[],
): Citation[] {
	const destination = getLinkDestination(link.target);
	if (destination) {
		const byCoord = destKeys?.get(
			citationDestKey(destination.pageIndex, destination.pdfY),
		);
		if (byCoord) {
			const matched = findCitationByDestKey(byCoord, citations);
			if (matched) return [matched];
		}
	}

	const clusterKeys = expandCitationLinkCluster(
		citationLinks,
		link.pageIndex,
		link.rect,
	);
	if (clusterKeys.length === 0) {
		const byLink = matchCitationLinkKey(
			citationLinks,
			link.pageIndex,
			link.rect,
		);
		if (!byLink) return [];
		const matched = findCitationByDestKey(byLink, citations);
		return matched ? [matched] : [];
	}

	const out: Citation[] = [];
	const seen = new Set<string>();
	for (const key of clusterKeys) {
		const matched = findCitationByDestKey(key, citations);
		if (!matched || seen.has(matched.id)) continue;
		seen.add(matched.id);
		out.push(matched);
	}
	return out;
}

/** Build a minimal read-only Citation from a PDF destination key. */
function remoteCitationFromDestKey(key: string, index: number): Citation {
	const refNum = citationRefNumber(key);
	return {
		id: `remote-${key}`,
		rawKey: key,
		display: refNum != null ? `[${refNum}]` : `[${index + 1}]`,
		metadata: {},
		source: "pdf",
		status: "unresolved",
	};
}

/**
 * Fill in read-only citations for a remote paper when there is no parsed
 * sidecar. Uses the in-text link order when available, falling back to the
 * unique dest-key map entries.
 */
function buildRemoteCitations(
	destKeys: CitationDestKeyMap | null,
	citationLinks: CitationLinkKeyList | null,
): Citation[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	const pushKey = (key: string) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		keys.push(key);
	};
	for (const link of citationLinks ?? []) {
		pushKey(link.key);
	}
	for (const key of destKeys?.values() ?? []) {
		pushKey(key);
	}
	return keys.map((key, index) => remoteCitationFromDestKey(key, index));
}

export function usePdfCitations({
	docId,
	annotationCap,
	hostRef,
	zoomRef,
	vaultPath,
	paperPath,
	paperAbsPath,
	sourceBytes = null,
	isRemotePaper = false,
	importIdentifier,
	onPreviewShow,
	onBeforeInternalJump,
	onInternalJump,
}: UsePdfCitationsOptions): PdfCitations {
	const onPreviewShowRef = useRef(onPreviewShow);
	onPreviewShowRef.current = onPreviewShow;
	const onBeforeInternalJumpRef = useRef(onBeforeInternalJump);
	onBeforeInternalJumpRef.current = onBeforeInternalJump;
	const onInternalJumpRef = useRef(onInternalJump);
	onInternalJumpRef.current = onInternalJump;
	const [citationPreview, setCitationPreview] =
		useState<CitationPreviewState | null>(null);
	const hideCitationPreview = useCallback(() => setCitationPreview(null), []);
	/**
	 * Leave link / card. Delay so the pointer can bridge into the card; never
	 * dismiss while the card (or its import menu) is still hovered / focused.
	 */
	const {
		hoverSurfaceRef: citationHoverSurfaceRef,
		cancelHide: cancelCitationHide,
		markHoverEnter: markCitationHoverEnter,
		scheduleHide: scheduleCitationHide,
	} = useStickyHoverHide({
		delayMs: EPHEMERAL_PREVIEW_HIDE_MS,
		hide: hideCitationPreview,
	});
	const { sidecar, setSidecar } = usePaperRefsSidecar(vaultPath, paperPath);
	/** Mirrored so the hover callback identity does not change per sidecar load. */
	const citationsRef = useRef(sidecar?.citations ?? []);
	citationsRef.current = sidecar?.citations ?? [];

	// ---- Library import (shared with the References panel) ----
	const localImport = useCitationImport(vaultPath, paperPath, setSidecar);

	// Remote papers have no sidecar, so the import surface imports the current
	// paper rather than an individual citation.
	const tree = useVaultStore((s) => s.tree);
	const remoteFolders = usePapersOrgFolders(vaultPath, tree);
	const [remoteImportingId, setRemoteImportingId] = useState<string | null>(
		null,
	);
	const remoteImportCitation = useCallback(
		async (_citation: Citation, parentDir: string) => {
			if (!importIdentifier || remoteImportingId) return;
			setRemoteImportingId(_citation.id);
			try {
				await lookupSubmit([importIdentifier], { parentDir });
			} catch (error) {
				notifyError(errorText(error));
			} finally {
				setRemoteImportingId(null);
			}
		},
		[importIdentifier, remoteImportingId],
	);

	const citationImport = useMemo(() => {
		if (vaultPath && paperPath) {
			return {
				folders: localImport.folders,
				lastImportParentDir: localImport.lastImportParentDir,
				importingId: localImport.importingId,
				importCitation: localImport.importCitation,
			};
		}
		if (isRemotePaper && vaultPath && importIdentifier) {
			return {
				folders: remoteFolders,
				lastImportParentDir: "papers",
				importingId: remoteImportingId,
				importCitation: remoteImportCitation,
			};
		}
		return null;
	}, [
		vaultPath,
		paperPath,
		isRemotePaper,
		importIdentifier,
		localImport,
		remoteFolders,
		remoteImportingId,
		remoteImportCitation,
	]);

	/** hyperref `cite.<key>` destinations of the open PDF, by destination coords. */
	const destKeyMapRef = useRef<CitationDestKeyMap | null>(null);
	/**
	 * Link annotation rect → citation dest key. Used when ACS `/FitR`
	 * bibliography destinations collide and the coord map is empty.
	 */
	const citationLinksRef = useRef<CitationLinkKeyList | null>(null);
	/** Visible page box origins; the jump flash is drawn in page space. */
	const pageOriginsRef = useRef<readonly PageOrigin[] | null>(null);
	const [pageOrigins, setPageOrigins] =
		useState<readonly PageOrigin[]>(EMPTY_PAGE_ORIGINS);
	/** Mirrored so a late bytes prop never re-triggers the build effect. */
	const sourceBytesRef = useRef<ArrayBuffer | null>(sourceBytes);
	sourceBytesRef.current = sourceBytes;
	useEffect(() => {
		destKeyMapRef.current = null;
		citationLinksRef.current = null;
		pageOriginsRef.current = null;
		setPageOrigins(EMPTY_PAGE_ORIGINS);
		const canBuildLocal = Boolean(paperAbsPath);
		const canBuildRemote = isRemotePaper && sourceBytesRef.current;
		if (!canBuildLocal && !canBuildRemote) return;
		// Deferred to idle, parsed in a worker, memoized per PDF — the build
		// never blocks the open-PDF critical path (hover previews simply do not
		// resolve until the map is ready).
		return schedulePdfDestMapsBuild({
			paperAbsPath,
			documentId: docId,
			viewerBytes: () => sourceBytesRef.current,
			warnLabel: "citation dest key map failed",
			onMaps: (maps) => {
				destKeyMapRef.current = maps.cites;
				citationLinksRef.current = maps.citationLinks;
				pageOriginsRef.current = maps.pageOrigins;
				setPageOrigins(maps.pageOrigins);
				if (isRemotePaper) {
					citationsRef.current = buildRemoteCitations(
						maps.cites,
						maps.citationLinks,
					);
				}
			},
		});
	}, [paperAbsPath, isRemotePaper, docId]);

	// Reset the hover preview when the active PDF document changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		citationHoverSurfaceRef.current = false;
		setCitationPreview(null);
	}, [docId]);

	const clearCitationPreview = useCallback(() => {
		cancelCitationHide();
		citationHoverSurfaceRef.current = false;
		setCitationPreview(null);
	}, [cancelCitationHide, citationHoverSurfaceRef]);

	/** GoTo/destination → smooth scroll (annotation plugin); URI → browser. */
	const handleCitationLinkActivate = useCallback(
		(link: PdfLinkAnnoObject) => {
			const target = link.target;
			if (!target || !annotationCap) return;
			// Capture the pre-jump position before the scroll starts.
			onBeforeInternalJumpRef.current?.();
			const destination = getLinkDestination(target);
			annotationCap
				.navigateTarget(target, docId)
				.toPromise()
				.then((result) => {
					if (result.outcome === "uri") {
						openExternalUrl(result.uri);
						return;
					}
					if (result.outcome === "navigated") {
						// The page scrolled the link out from under the stationary
						// pointer, so no pointerleave will ever fire — drop the card
						// here or it lingers over the destination (#528).
						clearCitationPreview();
						if (destination) {
							onInternalJumpRef.current?.(
								destinationInPageBox(destination, pageOriginsRef.current),
							);
						}
					}
				})
				.catch(() => {});
		},
		[annotationCap, docId, clearCitationPreview],
	);

	const handleCitationLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null, clientPoint?: ScreenPoint | null) => {
			if (!link) {
				// Delay so the pointer can bridge into the card (import menu,
				// external links, scrolling a multi-entry list).
				scheduleCitationHide();
				return;
			}
			const matched = resolveCitations(
				link,
				destKeyMapRef.current,
				citationLinksRef.current,
				citationsRef.current,
			);
			if (matched.length === 0) {
				scheduleCitationHide();
				return;
			}
			cancelCitationHide();
			// Treat show as an active hover surface so a mount-under-cursor
			// (which skips pointerenter) does not auto-close.
			citationHoverSurfaceRef.current = true;
			const pageEl = pageElByIndex(hostRef.current, link.pageIndex);
			if (!pageEl) return;
			onPreviewShowRef.current?.();
			const zoom = zoomRef.current && zoomRef.current > 0 ? zoomRef.current : 1;
			const screen =
				clientPoint ?? rectBottomCenterScreen(pageEl, link.rect, zoom);
			setCitationPreview({
				screen,
				matched,
			});
		},
		[
			scheduleCitationHide,
			cancelCitationHide,
			hostRef,
			zoomRef,
			citationHoverSurfaceRef,
		],
	);

	const hasCitationMatch = useCallback(
		(link: PdfLinkAnnoObject) =>
			resolveCitations(
				link,
				destKeyMapRef.current,
				citationLinksRef.current,
				citationsRef.current,
			).length > 0,
		[],
	);

	// Clean up the citation preview hide timer when the document changes or unmounts.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(
		() => () => {
			cancelCitationHide();
		},
		[docId, cancelCitationHide],
	);

	return {
		citationPreview,
		cancelCitationHide,
		scheduleCitationHide,
		markCitationHoverEnter,
		clearCitationPreview,
		handleCitationLinkActivate,
		handleCitationLinkHover,
		hasCitationMatch,
		citationImport,
		pageOrigins,
	};
}
