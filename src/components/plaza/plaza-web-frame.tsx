/**
 * Embedded web page for a Plaza source, with in-frame browsing.
 *
 * Sources that set `embedOrigin` are served through a Host proxy scheme, which
 * retargets the site's `target="_blank"` links so clicks navigate in place and
 * posts each navigation back here. That message stream is the history stack
 * behind Back / Forward — the frame's own `history` object is not usable once it
 * follows a link off to a third-party origin.
 *
 * Navigation is applied by remounting the frame at the target path, so it never
 * pushes entries onto the app's own session history.
 */

import {
	ArrowLeft,
	ArrowRight,
	ExternalLink,
	RotateCw,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIframeDragShield } from "@/hooks/use-iframe-drag-shield";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { importPlazaPaper, type PlazaImportRequest } from "@/lib/plaza/import";
import { importedIdsInLibrary } from "@/lib/plaza/imported";
import { usePlazaFrameZoom } from "./use-plaza-frame-zoom";

/** No `allow-popups`: every link must resolve inside this frame. */
const SANDBOX = "allow-scripts allow-same-origin allow-forms";

type NavMessage = {
	source: "agentero-plaza";
	/** In-frame navigation that just happened. */
	path?: string;
	/** Third-party link the frame refused to follow; open it outside. */
	external?: string;
	/**
	 * Same-origin path the frame declined to render in place (a feed). Reopened
	 * against the upstream site, since the browser cannot resolve our scheme.
	 */
	externalPath?: string;
	/** A paper row's `[入库]` was clicked. */
	importPaper?: PlazaImportRequest;
	/** Paper ids on screen; the host answers which of them are already imported. */
	queryImported?: string[];
	/** Horizontal wheel delta the frame could not consume in its own document. */
	panX?: number;
	/** Scale ratio from Ctrl/Cmd+wheel or a trackpad pinch inside the frame. */
	zoomRatio?: number;
};

function isNavMessage(data: unknown): data is NavMessage {
	if (typeof data !== "object" || data === null) return false;
	const value = data as Partial<NavMessage>;
	if (value.source !== "agentero-plaza") return false;
	return (
		(typeof value.panX === "number" && Number.isFinite(value.panX)) ||
		(typeof value.zoomRatio === "number" &&
			Number.isFinite(value.zoomRatio) &&
			value.zoomRatio > 0) ||
		typeof value.path === "string" ||
		typeof value.external === "string" ||
		typeof value.externalPath === "string" ||
		typeof value.importPaper === "object" ||
		Array.isArray(value.queryImported)
	);
}

export function PlazaWebFrame({
	homeUrl,
	embedOrigin,
	lastPathStorageKey,
	title,
	className,
	desktopWidth,
}: {
	/** Canonical public URL, used for "open in browser". */
	homeUrl: string;
	/** Proxy scheme origin, or null to embed `homeUrl` directly. */
	embedOrigin: string | null;
	/** Optional localStorage key used to resume a source at its last in-site path. */
	lastPathStorageKey?: string;
	title: string;
	className?: string;
	/** Fixed-layout sources need a virtual desktop viewport when fitting a narrow panel. */
	desktopWidth?: number;
}) {
	const { t } = useTranslation("sidebar");
	const zoom = usePlazaFrameZoom(desktopWidth);
	const home = new URL(homeUrl);
	const homePath = `${home.pathname || "/"}${home.search}`;
	const normalizePath = (value: unknown): string | null => {
		if (
			typeof value !== "string" ||
			!value.startsWith("/") ||
			value.startsWith("//")
		) {
			return null;
		}
		try {
			const restored = new URL(value, homeUrl);
			if (restored.origin !== home.origin) return null;
			return `${restored.pathname}${restored.search}`;
		} catch {
			return null;
		}
	};
	const [initialPath] = useState(() => {
		if (!lastPathStorageKey || typeof window === "undefined") return homePath;
		try {
			const stored = window.localStorage.getItem(lastPathStorageKey);
			if (!stored?.startsWith("/") || stored.startsWith("//")) {
				return homePath;
			}
			return normalizePath(stored) ?? homePath;
		} catch {
			return homePath;
		}
	});
	const historyStorageKey = lastPathStorageKey
		? `${lastPathStorageKey}:history`
		: null;
	/** Visited paths and the cursor into them. Grown by proxy nav messages. */
	const [nav, setNav] = useState<{ stack: string[]; index: number }>(() => {
		const fallback = { stack: [initialPath], index: 0 };
		if (!historyStorageKey || typeof window === "undefined") return fallback;
		try {
			const stored = window.localStorage.getItem(historyStorageKey);
			if (!stored) return fallback;
			const value: unknown = JSON.parse(stored);
			if (typeof value !== "object" || value === null) return fallback;
			const candidate = value as { stack?: unknown; index?: unknown };
			if (
				!Array.isArray(candidate.stack) ||
				typeof candidate.index !== "number" ||
				!Number.isInteger(candidate.index) ||
				candidate.stack.length === 0 ||
				candidate.stack.length > 500 ||
				(candidate.index as number) < 0 ||
				(candidate.index as number) >= candidate.stack.length
			) {
				return fallback;
			}
			const stack = candidate.stack.map(normalizePath);
			if (stack.some((path) => path === null)) return fallback;
			return { stack: stack as string[], index: candidate.index as number };
		} catch {
			return fallback;
		}
	});
	/**
	 * What the frame is mounted at. `epoch` is bumped only by Back / Forward /
	 * Reload: the iframe key depends on it alone, so a link click inside the
	 * frame records history without remounting (which would reload this path and
	 * snap the user back to where the frame started).
	 */
	const [frame, setFrame] = useState({
		path: nav.stack[nav.index] ?? initialPath,
		epoch: 0,
	});
	/** Needed to post import results back into the frame. */
	const frameRef = useRef<HTMLIFrameElement>(null);
	const dragShield = useIframeDragShield();

	useEffect(() => {
		if (!embedOrigin) return;
		const onMessage = (event: MessageEvent) => {
			// Retained tabs can contain other frames from the same origin.
			if (
				event.origin !== embedOrigin ||
				!frameRef.current?.contentWindow ||
				event.source !== frameRef.current.contentWindow ||
				!isNavMessage(event.data)
			)
				return;
			const {
				path,
				external,
				externalPath,
				importPaper,
				queryImported,
				panX,
				zoomRatio,
			} = event.data;
			if (zoomRatio !== undefined) {
				zoom.zoomByRatio(zoomRatio);
				return;
			}
			if (panX !== undefined) {
				zoom.panBy(panX);
				return;
			}
			if (external) {
				openExternalUrl(external);
				return;
			}
			if (externalPath) {
				openExternalUrl(new URL(externalPath, homeUrl).href);
				return;
			}
			if (queryImported) {
				void importedIdsInLibrary(queryImported).then((importedIds) => {
					frameRef.current?.contentWindow?.postMessage(
						{
							source: "agentero-plaza-host",
							importedIds,
						},
						embedOrigin,
					);
				});
				return;
			}
			if (importPaper) {
				void importPlazaPaper(importPaper).then((ok) => {
					frameRef.current?.contentWindow?.postMessage(
						{
							source: "agentero-plaza-host",
							importedId: importPaper.id,
							ok,
						},
						embedOrigin,
					);
				});
				return;
			}
			if (!path) return;
			setNav((prev) => {
				// Already at this entry — either a reload, or the load caused by our
				// own Back / Forward, which moved the cursor before the frame reported.
				if (prev.stack[prev.index] === path) return prev;
				// A new navigation truncates anything ahead of the cursor.
				const stack = [...prev.stack.slice(0, prev.index + 1), path];
				return { stack, index: stack.length - 1 };
			});
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embedOrigin, homeUrl, zoom.panBy, zoom.zoomByRatio]);

	const jump = useCallback((delta: number) => {
		setNav((prev) => {
			const index = prev.index + delta;
			const path = prev.stack[index];
			if (path == null) return prev;
			setFrame((f) => ({ path, epoch: f.epoch + 1 }));
			return { ...prev, index };
		});
	}, []);

	const canGoBack = nav.index > 0;
	const canGoForward = nav.index < nav.stack.length - 1;
	const currentPath = nav.stack[nav.index] ?? homePath;
	const frameSrc = embedOrigin ? `${embedOrigin}${frame.path}` : homeUrl;

	useEffect(() => {
		if (!lastPathStorageKey || typeof window === "undefined") return;
		try {
			const current = new URL(currentPath, homeUrl);
			if (current.origin === home.origin) {
				window.localStorage.setItem(
					lastPathStorageKey,
					`${current.pathname}${current.search}`,
				);
			}
		} catch {
			// Browsing still works when storage is unavailable or a path is invalid.
		}
	}, [currentPath, home.origin, homeUrl, lastPathStorageKey]);

	useEffect(() => {
		if (!historyStorageKey || typeof window === "undefined") return;
		try {
			window.localStorage.setItem(historyStorageKey, JSON.stringify(nav));
		} catch {
			// Browsing still works when storage is unavailable or full.
		}
	}, [historyStorageKey, nav]);

	return (
		<div
			className={cn(
				"flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
				className,
			)}
		>
			<div className="flex min-h-8 shrink-0 flex-wrap select-none items-center gap-0.5 border-b px-1.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.back")}
							disabled={!canGoBack}
							onClick={() => jump(-1)}
						>
							<ArrowLeft className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("plaza.back")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.forward")}
							disabled={!canGoForward}
							onClick={() => jump(1)}
						>
							<ArrowRight className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("plaza.forward")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.reload")}
							onClick={() =>
								setFrame((f) => ({ path: currentPath, epoch: f.epoch + 1 }))
							}
						>
							<RotateCw className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("plaza.reload")}</TooltipContent>
				</Tooltip>
				<span
					className="ml-1 min-w-0 flex-1 truncate text-caption text-muted-foreground"
					title={currentPath}
				>
					{currentPath}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.zoomOut")}
							disabled={!zoom.canZoomOut}
							onClick={zoom.zoomOut}
						>
							<ZoomOut className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.zoomOut")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-6 shrink-0 px-1 text-caption tabular-nums"
							aria-label={t("plaza.fitWidth")}
							aria-pressed={zoom.automatic}
							onClick={zoom.fit}
						>
							{Math.round(zoom.scale * 100)}%
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.fitWidth")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.zoomIn")}
							disabled={!zoom.canZoomIn}
							onClick={zoom.zoomIn}
						>
							<ZoomIn className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.zoomIn")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.openInSystemBrowser")}
							onClick={() =>
								openExternalUrl(new URL(currentPath, homeUrl).href)
							}
						>
							<ExternalLink className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						{t("plaza.openInSystemBrowser")}
					</TooltipContent>
				</Tooltip>
			</div>
			<div
				ref={zoom.viewportRef}
				className="relative min-h-0 min-w-0 flex-1 overflow-auto"
			>
				<div
					className="relative h-full overflow-hidden"
					style={{
						width:
							zoom.pageWidth === undefined
								? "100%"
								: zoom.pageWidth * zoom.scale,
					}}
				>
					<iframe
						// Keyed on the epoch alone: only Back / Forward / Reload remount.
						// Keying on observed navigation would reload `frame.path` on every
						// in-frame click and bounce the user back to the starting page.
						key={frame.epoch}
						ref={frameRef}
						title={title}
						src={frameSrc}
						sandbox={SANDBOX}
						referrerPolicy="no-referrer-when-downgrade"
						className={cn(
							"absolute inset-0 block h-full w-full border-0 bg-background",
							dragShield && "pointer-events-none",
						)}
						style={{
							colorScheme: "light dark",
							width: zoom.pageWidth,
							height: zoom.pageHeight,
							transform: `scale(${zoom.scale})`,
							transformOrigin: "top left",
						}}
					/>
				</div>
			</div>
		</div>
	);
}
