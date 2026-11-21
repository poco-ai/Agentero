import { ArrowUpRight } from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import {
	computePreviewPlacement,
	PREVIEW_VIEWPORT_PADDING,
} from "@/components/viewer/pdf/preview-placement";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { parseWebBridgeMessage } from "@/components/viewer/web-view/bridge-message";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { httpUrl, resolveLinkPreviewTarget } from "@/lib/pdf/link-preview";
import { PDF_PAPER_SHELL_CLASS } from "@/lib/pdf/page-theme";
import { webViewProxyOrigins, webViewProxyUrl } from "@/lib/web-view/proxy-url";

/** Same width for the URL tip and both previews: replacing one with the other
 * must not move the card sideways under the pointer. */
const CARD_WIDTH = 320;
const PAGE_PREVIEW_HEIGHT = 220;
/**
 * Layout the framed page at 2× and scale it back down. Most sites switch to a
 * cramped mobile layout at the card's inner width (~304px); a 608px viewport
 * shows the desktop page, and the 0.5 scale keeps the same on-screen size while
 * fitting far more of the page into the preview.
 */
const PAGE_PREVIEW_SCALE = 0.5;
const IMAGE_MAX_HEIGHT = 240;
const IMAGE_SKELETON_HEIGHT = 180;
/**
 * Reserve the tallest card body when placing. The card owns a fixed anchor
 * edge (top when it opens below the link, bottom when above), so using the
 * final size up front keeps the card under the pointer while the URL tip turns
 * into a preview (or falls back) instead of flipping to the other side.
 */
const CARD_ESTIMATED_HEIGHT = IMAGE_MAX_HEIGHT + 16;
/** Card padding around preview content (`p-2`). */
const PREVIEW_CHROME_HEIGHT = 16;
/**
 * Delay after the card opens (the hover-intent gate already waited 300ms)
 * before the proxy request starts: ~500ms of rest total before any third-party
 * traffic, and no request at all when the pointer just crosses a link.
 */
const PREVIEW_LOAD_DELAY_MS = 200;
/** Give the page / image time to load, then fall back to the URL card. */
const PREVIEW_LOAD_TIMEOUT_MS = 7000;
/**
 * Bridge `ready` normally arrives before the iframe `load` event. If it does
 * not (non-HTML response, un-injected document, proxy error page), the frame
 * did load but cannot be previewed — fail faster than the full timeout.
 */
const FRAME_READY_GRACE_MS = 800;
/** Pointer travel above which a press is a drag (selection / scrollbar). */
const CLICK_DRAG_PX = 4;

type PreviewPhase = "idle" | "loading" | "ready" | "failed";

/**
 * Hover card for an external link. The full URL shows immediately; when the
 * link looks previewable the text is replaced after a short dwell by either a
 * small framed page (via the `agentero-web` proxy) or an image thumbnail. Any
 * failed / timed-out / refused load puts the URL tip back, without an extra
 * error toast.
 *
 * The framed page is interactive for reading (wheel scroll, in-page links);
 * external links are relayed to the system browser and the corner button opens
 * the original URL. No popups / forms / top navigation are granted.
 */
export function PdfLinkPreviewCard({
	url,
	screen,
	onPointerEnter,
	onPointerLeave,
}: {
	url: string;
	screen: ScreenPoint;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const { pdfTone } = usePdfPaperTone();
	const rootRef = useRef<HTMLDivElement>(null);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const frameLoadTimerRef = useRef<number | null>(null);
	const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
	const previewTarget = useMemo(() => resolveLinkPreviewTarget(url), [url]);
	const kind = previewTarget.kind;
	const [phase, setPhase] = useState<PreviewPhase>("idle");
	const [frameSrc, setFrameSrc] = useState<string | null>(null);
	const [imageSrc, setImageSrc] = useState<string | null>(null);
	const openable = useMemo(() => httpUrl(url) !== null, [url]);

	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const showPreview = kind !== "none" && phase !== "idle" && phase !== "failed";
	const cardWidth = Math.min(
		CARD_WIDTH,
		viewportWidth - PREVIEW_VIEWPORT_PADDING * 2,
	);
	const { placement, left, top, bottom, arrowLeft, maxContentHeight } =
		computePreviewPlacement({
			screen,
			cardWidth,
			cardEstimatedHeight: CARD_ESTIMATED_HEIGHT,
			cardChromeHeight: PREVIEW_CHROME_HEIGHT,
			viewportWidth,
			viewportHeight,
		});
	const imageMaxHeight = Math.max(
		80,
		Math.min(IMAGE_MAX_HEIGHT, maxContentHeight),
	);
	const pageHeight = Math.max(
		80,
		Math.min(PAGE_PREVIEW_HEIGHT, maxContentHeight),
	);
	const pageWidth = Math.max(120, cardWidth - PREVIEW_CHROME_HEIGHT);

	// Mount under an existing pointer skips pointerenter — re-arm sticky hover.
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	// Dwell first, then ask the Host to allow the public host and point the
	// frame / image at the proxy. Only one card exists at a time, and leaving
	// the card unmounts it (timer + request cleanup below).
	const beginPreview = useCallback(async () => {
		const resolved = httpUrl(previewTarget.url);
		if (!resolved) {
			setPhase("failed");
			return;
		}
		let proxied: string;
		try {
			proxied = webViewProxyUrl(resolved.href);
		} catch {
			setPhase("failed");
			return;
		}
		setPhase("loading");
		try {
			const accepted = await callApiResult(() =>
				commands.webProxyAllowHost({ host: resolved.hostname }),
			);
			if (!accepted) {
				setPhase("failed");
				return;
			}
			if (kind === "image") setImageSrc(proxied);
			else setFrameSrc(proxied);
		} catch {
			setPhase("failed");
		}
	}, [kind, previewTarget.url]);

	useEffect(() => {
		if (kind === "none") return;
		const timer = window.setTimeout(() => {
			void beginPreview();
		}, PREVIEW_LOAD_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [beginPreview, kind]);

	// The injected selection bridge posts `ready` only for real HTML documents;
	// a proxy error page (plain text) never does. The payload carries the
	// upstream status, so 4xx/5xx HTML error pages also fall back to the tip.
	useEffect(() => {
		if (kind !== "page") return;
		const onMessage = (event: MessageEvent) => {
			if (!webViewProxyOrigins().includes(event.origin)) return;
			if (
				!iframeRef.current ||
				event.source !== iframeRef.current.contentWindow
			)
				return;
			const message = parseWebBridgeMessage(event.data);
			if (message?.type === "external") {
				openExternalUrl(message.url);
				return;
			}
			if (message?.type !== "ready") return;
			if (frameLoadTimerRef.current != null) {
				window.clearTimeout(frameLoadTimerRef.current);
				frameLoadTimerRef.current = null;
			}
			if (message.proxyStatus != null && message.proxyStatus >= 400) {
				setPhase("failed");
				return;
			}
			setPhase("ready");
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			if (frameLoadTimerRef.current != null) {
				window.clearTimeout(frameLoadTimerRef.current);
				frameLoadTimerRef.current = null;
			}
		};
	}, [kind]);

	// Loaded but no bridge handshake: not a previewable document. One short
	// grace keeps a valid page whose `ready` is still in flight from flickering
	// back to the URL tip.
	const handleFrameLoad = () => {
		if (frameLoadTimerRef.current != null) return;
		frameLoadTimerRef.current = window.setTimeout(() => {
			frameLoadTimerRef.current = null;
			setPhase((current) => (current === "loading" ? "failed" : current));
		}, FRAME_READY_GRACE_MS);
	};

	// Unmount the frame / image on timeout so a hanging request cannot keep the
	// skeleton up forever; the fallback URL card takes over. Starts with the
	// loading phase so the allow-host round trip is covered too.
	useEffect(() => {
		if (phase !== "loading") return;
		const timer = window.setTimeout(() => {
			setFrameSrc(null);
			setImageSrc(null);
			setPhase("failed");
		}, PREVIEW_LOAD_TIMEOUT_MS);
		return () => window.clearTimeout(timer);
	}, [phase]);

	const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		onPointerLeave();
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		pointerDownRef.current = { x: event.clientX, y: event.clientY };
	};

	// A click opens the system browser. Presses that travelled (text selection /
	// scrollbar drag) are ignored, as is a click that ends an in-card selection.
	const handleOpen = (event: ReactMouseEvent<HTMLButtonElement>) => {
		const start = pointerDownRef.current;
		pointerDownRef.current = null;
		if (
			start &&
			Math.hypot(event.clientX - start.x, event.clientY - start.y) >
				CLICK_DRAG_PX
		)
			return;
		if (!httpUrl(url)) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) {
			const node = selection.anchorNode;
			if (node && rootRef.current?.contains(node)) return;
		}
		openExternalUrl(url);
	};

	return (
		<div
			ref={rootRef}
			role="dialog"
			aria-label={showPreview ? t("pdf.linkPreview") : t("pdf.linkUrl")}
			aria-busy={phase === "loading" ? true : undefined}
			data-pdf-chrome
			className={cn(
				"fixed z-50 p-2 text-xs leading-relaxed",
				PDF_FLOAT_CARD,
				placement === "bottom" ? "origin-top" : "origin-bottom",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-reduce:animate-none",
			)}
			style={{ left, top, bottom, width: cardWidth }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
			onPointerDown={handlePointerDown}
		>
			<PreviewArrow placement={placement} left={arrowLeft} />
			{showPreview && kind === "page" ? (
				<PagePreview
					width={pageWidth}
					height={pageHeight}
					phase={phase}
					frameSrc={frameSrc}
					iframeRef={iframeRef}
					onFrameLoad={handleFrameLoad}
					onOpenLink={() => {
						if (httpUrl(url)) openExternalUrl(url);
					}}
				/>
			) : null}
			{showPreview && kind === "image" ? (
				<ImagePreview
					pdfTone={pdfTone}
					maxHeight={imageMaxHeight}
					phase={phase}
					imageSrc={imageSrc}
					onOpen={handleOpen}
					onLoad={() => setPhase("ready")}
					onError={() => setPhase("failed")}
				/>
			) : null}
			{showPreview ? null : openable ? (
				<button
					type="button"
					tabIndex={-1}
					className="agentero-scroll block max-h-60 w-full cursor-pointer overflow-y-auto break-all text-left whitespace-pre-wrap select-text"
					onClick={handleOpen}
				>
					{url}
				</button>
			) : (
				<p className="agentero-scroll max-h-60 overflow-y-auto break-all whitespace-pre-wrap select-text">
					{url}
				</p>
			)}
		</div>
	);
}

function PagePreview({
	width,
	height,
	phase,
	frameSrc,
	iframeRef,
	onFrameLoad,
	onOpenLink,
}: {
	width: number;
	height: number;
	phase: PreviewPhase;
	frameSrc: string | null;
	iframeRef: React.RefObject<HTMLIFrameElement | null>;
	onFrameLoad: () => void;
	onOpenLink: () => void;
}) {
	const { t } = useTranslation("viewer");
	return (
		<div
			className="relative overflow-hidden rounded-md border border-border/40 bg-background"
			style={{ height }}
		>
			{frameSrc ? (
				<iframe
					ref={iframeRef}
					title={t("pdf.linkPreview")}
					src={frameSrc}
					// Keep the frame out of the tab order (the PDF keeps keyboard
					// focus until the reader clicks into the preview).
					tabIndex={-1}
					// Interactive preview: scroll and page links work, but no popups
					// / forms / top navigation. External links are relayed by the
					// injected bridge to the system browser. `allow-same-origin`
					// keeps the proxy origin so the bridge messages validate; the
					// proxy itself only serves allowlisted public hosts.
					sandbox="allow-scripts allow-same-origin"
					referrerPolicy="no-referrer"
					onLoad={onFrameLoad}
					className={cn(
						"absolute top-0 left-0 block border-0 bg-background transition-opacity duration-200",
						phase === "ready" ? "opacity-100" : "pointer-events-none opacity-0",
					)}
					style={{
						colorScheme: "light dark",
						width: width / PAGE_PREVIEW_SCALE,
						height: height / PAGE_PREVIEW_SCALE,
						transform: `scale(${PAGE_PREVIEW_SCALE})`,
						transformOrigin: "top left",
					}}
				/>
			) : null}
			{phase === "loading" ? (
				<Skeleton className="absolute inset-0 rounded-none" />
			) : null}
			<button
				type="button"
				tabIndex={-1}
				aria-label={t("references.openLink")}
				title={t("references.openLink")}
				onClick={onOpenLink}
				className="absolute top-1 right-1 z-20 flex size-6 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground"
			>
				<ArrowUpRight className="size-3.5" aria-hidden />
			</button>
		</div>
	);
}

function ImagePreview({
	pdfTone,
	maxHeight,
	phase,
	imageSrc,
	onOpen,
	onLoad,
	onError,
}: {
	pdfTone: keyof typeof PDF_PAPER_SHELL_CLASS;
	maxHeight: number;
	phase: PreviewPhase;
	imageSrc: string | null;
	onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
	onLoad: () => void;
	onError: () => void;
}) {
	const { t } = useTranslation("viewer");
	return (
		<div
			className={cn(
				"relative flex items-center justify-center overflow-hidden rounded-md border border-border/40",
				PDF_PAPER_SHELL_CLASS[pdfTone],
			)}
			style={{ maxHeight, minHeight: phase === "loading" ? 80 : undefined }}
		>
			{imageSrc ? (
				<img
					src={imageSrc}
					alt=""
					referrerPolicy="no-referrer"
					className={cn(
						"max-w-full object-contain transition-opacity duration-200",
						phase === "ready" ? "opacity-100" : "opacity-0",
					)}
					style={{ maxHeight }}
					onLoad={onLoad}
					onError={onError}
				/>
			) : null}
			{phase === "loading" ? (
				<Skeleton
					className="w-full"
					style={{ height: Math.min(IMAGE_SKELETON_HEIGHT, maxHeight) }}
				/>
			) : null}
			<button
				type="button"
				tabIndex={-1}
				aria-label={t("pdf.linkPreview")}
				onClick={onOpen}
				className="absolute inset-0 z-10 cursor-pointer rounded-md border-0 bg-transparent p-0 focus-visible:outline-none"
			/>
		</div>
	);
}
