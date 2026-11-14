import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useSettings } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	applyLayoutTranslateSidecar,
	currentLayoutTranslateCacheKey,
	listTranslatableLayoutRegions,
	readLayoutTranslateSidecar,
	subscribeLayoutTranslateSidecarWrite,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import {
	layoutAnalysisStore,
	layoutDocumentKey,
	normalizeLayoutPaperKey,
} from "@/lib/pdf/layout/store";
import type { TranslationSnapshot } from "@/lib/pdf/layout/translation-job";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	buildReadingBlocks,
	type ReadingBlock,
} from "@/lib/pdf/reading/blocks";
import {
	normalizeReadingSettings,
	READING_SETTINGS_EVENT,
	type ReadingSettings,
	readReadingSettings,
	writeReadingSettings,
} from "@/lib/pdf/reading/settings";
import { createReflowIrCache } from "@/lib/pdf/reflow/cache";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";

const EMPTY_ITEMS: LayoutTranslateItem[] = [];
type Options = {
	docId: string;
	currentPage?: number;
	paperAbsPath: string | null;
	available: boolean;
	regions: PdfLayoutRegion[] | null;
	context: () => { engine: PdfEngine; document: PdfDocumentObject } | null;
	startAnalysis: (signal: AbortSignal) => void;
	paperKey?: string | null;
	pdfBytes?: ArrayBuffer | null;
	translation?: Pick<TranslationSnapshot, "cacheKey" | "items"> | null;
};
export type PdfContinuousReaderState = {
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
	settings: ReadingSettings;
	updateSettings: (patch: Partial<ReadingSettings>) => void;
	blocks: ReadingBlock[];
	hasTranslations: boolean;
	preparing: boolean;
	analysisRunning: boolean;
	preparingLayoutBackend:
		| import("@/lib/pdf/layout/settings").LayoutBackend
		| null;
	error: string | null;
	retryPreparation: () => void;
};
export function usePdfContinuousReader({
	docId,
	currentPage = 1,
	paperAbsPath,
	available,
	regions,
	context,
	startAnalysis,
	paperKey,
	pdfBytes,
	translation,
}: Options): PdfContinuousReaderState {
	const { t, i18n } = useTranslation("viewer");
	const [enabledDocument, setEnabledDocument] = useState<string | null>(null);
	const enabled = available && enabledDocument === docId;
	const setEnabled = useCallback(
		(value: boolean) => setEnabledDocument(value && available ? docId : null),
		[docId, available],
	);
	useEffect(() => {
		if (!available) setEnabledDocument(null);
	}, [available]);
	const [settings, setSettings] = useState(readReadingSettings);
	const [prepared, setPrepared] = useState<{
		docId: string;
		regions: PdfLayoutRegion[];
		retry: number;
		items: LayoutTranslateItem[];
		complete: boolean;
		pageIndexes?: ReadonlySet<number>;
	} | null>(null);
	const [cache, setCache] = useState<{
		docId: string;
		key: string;
		items: LayoutTranslateItem[];
		hasTranslations: boolean;
	} | null>(null);
	const [preparing, setPreparing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const translateSettings = useSettings((state) => state.translate);
	const current = useRef({
		context,
		startAnalysis,
		paperKey,
		pdfBytes,
		currentPage,
		translateSettings,
	});
	current.current = {
		context,
		startAnalysis,
		paperKey,
		pdfBytes,
		currentPage,
		translateSettings,
	};
	// Subscribe to both provider settings and UI language (the automatic target).
	const cacheKey = useMemo(() => {
		void translateSettings;
		void i18n.language;
		return currentLayoutTranslateCacheKey();
	}, [translateSettings, i18n.language]);
	const cacheIdentity = JSON.stringify(cacheKey);
	const analysis = useStore(layoutAnalysisStore, (state) => state.ui);
	const activeDoc = useStore(
		layoutAnalysisStore,
		(state) => state.activeDocumentId,
	);
	const activePaper = useStore(
		layoutAnalysisStore,
		(state) => state.activePaperAbsPath,
	);
	const analysisMatches =
		(activeDoc != null &&
			layoutDocumentKey(activeDoc) === layoutDocumentKey(docId)) ||
		(paperAbsPath != null &&
			activePaper === normalizeLayoutPaperKey(paperAbsPath));
	const analysisRunning = analysisMatches && analysis.stage === "running";
	const analysisError =
		analysisMatches &&
		(analysis.stage === "error" || analysis.stage === "cancelled")
			? analysis.stage === "error"
				? analysis.message
				: t("pdf.reading.failed")
			: null;
	const requested = useRef<string | null>(null);
	const ownedAnalysis = useRef<AbortController | null>(null);
	const startOwnedAnalysis = useCallback(() => {
		ownedAnalysis.current?.abort();
		const controller = new AbortController();
		ownedAnalysis.current = controller;
		requested.current = docId;
		current.current.startAnalysis(controller.signal);
	}, [docId]);
	// Ownership follows the reader session, not the analysis progress updates.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reader session identity owns analysis cancellation.
	useEffect(
		() => () => {
			ownedAnalysis.current?.abort();
			ownedAnalysis.current = null;
			requested.current = null;
		},
		[enabled, docId, paperAbsPath],
	);

	useEffect(() => {
		const receive = (event: Event) =>
			setSettings(
				normalizeReadingSettings((event as CustomEvent<unknown>).detail),
			);
		const storage = () => setSettings(readReadingSettings());
		window.addEventListener(READING_SETTINGS_EVENT, receive);
		window.addEventListener("storage", storage);
		return () => {
			window.removeEventListener(READING_SETTINGS_EVENT, receive);
			window.removeEventListener("storage", storage);
		};
	}, []);
	const updateSettings = useCallback((patch: Partial<ReadingSettings>) => {
		const next = normalizeReadingSettings({
			...readReadingSettings(),
			...patch,
		});
		setSettings(next);
		writeReadingSettings(next);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset state when document identity changes.
	useEffect(() => {
		setEnabledDocument(null);
		setPrepared(null);
		setCache(null);
		setError(null);
		setPreparing(false);
		requested.current = null;
	}, [docId]);
	useEffect(() => {
		if (
			!enabled ||
			regions ||
			analysisRunning ||
			(analysisError && analysis.stage !== "cancelled") ||
			requested.current === docId
		)
			return;
		startOwnedAnalysis();
	}, [
		enabled,
		docId,
		regions,
		analysisRunning,
		analysisError,
		analysis.stage,
		startOwnedAnalysis,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Read completed preparation on session changes; publishing it must not restart this effect.
	useEffect(() => {
		if (!enabled || !regions) return;
		if (
			prepared?.docId === docId &&
			prepared.regions === regions &&
			prepared.retry === retry &&
			prepared.complete
		) {
			setPreparing(false);
			return;
		}
		const ctx = current.current.context();
		if (!ctx) return;
		const controller = new AbortController();
		const readyPages = new Map<number, LayoutTranslateItem[]>();
		let publishTimer: ReturnType<typeof setTimeout> | undefined;
		const publish = () => {
			publishTimer = undefined;
			if (!controller.signal.aborted)
				setPrepared({
					docId,
					regions,
					retry,
					items: [...readyPages.values()].flat(),
					complete: false,
					pageIndexes: new Set(readyPages.keys()),
				});
		};
		setPreparing(true);
		setError(null);
		const seed = toLayoutTranslateItems(listTranslatableLayoutRegions(regions));
		const irCache = createReflowIrCache(
			{
				includeReferences: true,
				paperKey: current.current.paperKey ?? paperAbsPath,
				paperAbsPath,
				pdfBytes: current.current.pdfBytes,
				items: seed,
				regions,
			},
			{
				writesEnabled: () =>
					current.current.translateSettings?.cacheReflowIr ?? false,
			},
		);
		void prepareReflowItems(
			ctx.engine,
			ctx.document,
			seed,
			regions,
			controller.signal,
			irCache,
			{
				includeUnselectedPages: true,
				includeReferences: true,
				priorityPageIndex: current.current.currentPage - 1,
				onPagePrepared: (pageIndex, items) => {
					if (controller.signal.aborted) return;
					readyPages.set(pageIndex, items);
					if (readyPages.size === 1) publish();
					else publishTimer ??= setTimeout(publish, 80);
				},
			},
		)
			.then((items) => {
				clearTimeout(publishTimer);
				if (!controller.signal.aborted)
					setPrepared({ docId, regions, retry, items, complete: true });
			})
			.catch((cause) => {
				if (controller.signal.aborted) return;
				const message = errorText(cause);
				setError(message);
				notifyError(t("pdf.reading.failed"), { description: message });
			})
			.finally(() => {
				if (!controller.signal.aborted) setPreparing(false);
			});
		return () => {
			clearTimeout(publishTimer);
			controller.abort();
		};
	}, [enabled, docId, paperAbsPath, regions, retry, t]);
	const currentPrepared =
		prepared?.docId === docId && prepared.regions === regions ? prepared : null;
	const sources = currentPrepared?.items ?? EMPTY_ITEMS;
	useEffect(() => {
		let cancelled = false;
		let request = 0;
		const load = async () => {
			const sequence = ++request;
			// The sidecar validates disk provenance. Shared progress below carries
			// its own cache key and is matched against the prepared source.
			const sidecar = await readLayoutTranslateSidecar(paperAbsPath, cacheKey);
			if (!cancelled && sequence === request)
				setCache({
					docId,
					key: cacheIdentity,
					items: applyLayoutTranslateSidecar(sources, sidecar),
					hasTranslations: Boolean(
						sidecar?.items.some((item) => item.translated.trim()),
					),
				});
		};
		void load();
		const unsubscribe = subscribeLayoutTranslateSidecarWrite((paper) => {
			if (
				paperAbsPath &&
				normalizeLayoutPaperKey(paper) === normalizeLayoutPaperKey(paperAbsPath)
			)
				void load();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [docId, paperAbsPath, sources, cacheKey, cacheIdentity]);
	const cached =
		cache?.docId === docId && cache.key === cacheIdentity
			? cache.items
			: EMPTY_ITEMS;
	const blocks = useMemo(() => {
		const key = translation?.cacheKey;
		const live =
			key &&
			key.providerId === cacheKey.providerId &&
			key.sourceLang === cacheKey.sourceLang &&
			key.targetLang === cacheKey.targetLang &&
			key.serviceKey === cacheKey.serviceKey
				? translation.items
				: EMPTY_ITEMS;
		const byId = new Map(
			live
				.filter((item) => item.status === "done" && item.translated?.trim())
				.map((item) => [item.id, item]),
		);
		const cachedById = new Map(cached.map((item) => [item.id, item]));
		const combined = sources.map((source) => {
			const item = byId.get(source.id);
			return item?.source === source.source
				? {
						...source,
						status: "done" as const,
						translated: item.translated,
						sentences: item.sentences,
					}
				: (cachedById.get(source.id) ?? source);
		});
		const readyRegions = currentPrepared?.complete
			? (regions ?? [])
			: (regions ?? []).filter((region) =>
					currentPrepared?.pageIndexes?.has(region.pageIndex),
				);
		return buildReadingBlocks(readyRegions, sources, combined);
	}, [regions, sources, currentPrepared, cached, translation, cacheKey]);
	const retryPreparation = useCallback(() => {
		setError(null);
		if (!enabled) return;
		if (!regions) startOwnedAnalysis();
		else setRetry((value) => value + 1);
	}, [enabled, regions, startOwnedAnalysis]);
	return {
		enabled,
		setEnabled,
		settings,
		updateSettings,
		blocks,
		hasTranslations:
			(cache?.docId === docId &&
				cache.key === cacheIdentity &&
				cache.hasTranslations) ||
			blocks.some((block) => Boolean(block.translated?.trim())),
		preparing: enabled && (preparing || (!regions && !analysisError)),
		analysisRunning,
		preparingLayoutBackend:
			enabled && !regions && analysis.stage === "running" && analysisMatches
				? (analysis.backend ?? null)
				: null,
		error: error ?? analysisError,
		retryPreparation,
	};
}
