// Mermaid renders its own SVG markup; strict mode strips scripts and event handlers.
// biome-ignore-all lint/security/noDangerouslySetInnerHtml: rendered SVG is the diagram output.

"use client";

import {
	Check,
	Code,
	Copy,
	LoaderCircle,
	Maximize2,
	Scan,
	Workflow,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
	type ComponentPropsWithoutRef,
	type CSSProperties,
	forwardRef,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { BundledLanguage } from "shiki";
import type { CustomRendererProps } from "streamdown";
import { CodeBlockContent } from "@/components/agent/rendering/code-block";
import { Button } from "@/components/ui/button";
import {
	CodeBlock,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ui/code-block";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInView } from "@/hooks/use-in-view";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";
import {
	getMermaidConfig,
	type MermaidThemeMode,
} from "@/lib/markdown/mermaid-theme";
import { bindZoomGesture, type ZoomGesturePoint } from "@/lib/pdf/wheel-zoom";

/** Interactive fenced blocks belong to the note/chat reading surface. */
const ICON_BUTTON_CLASS =
	"size-6 opacity-70 hover:opacity-100 focus-visible:opacity-100";

/** Streaming tokenizes Mermaid code every frame; render once it settles. */
const RENDER_DEBOUNCE_MS = 200;

/** Diagrams are expensive to compile and survive scroll/re-mount cycles. */
const MAX_CACHED_SVGS = 24;
const svgCache = new Map<string, string>();

function cacheSvg(key: string, svg: string) {
	svgCache.set(key, svg);
	if (svgCache.size > MAX_CACHED_SVGS) {
		const oldest = svgCache.keys().next().value;
		if (oldest !== undefined) svgCache.delete(oldest);
	}
}

export type MermaidStatus = "empty" | "pending" | "ready" | "error";

/**
 * Compile Mermaid source for the active theme.
 *
 * Mirrors the editor preview's behavior: work is deferred until the block is
 * near the viewport (Mermaid is a multi-megabyte dynamic import) and an older
 * in-flight render is discarded when the source or theme changes.
 */
export function useMermaidSvg(
	source: string,
	rootRef: RefObject<Element | null>,
	options?: { defer?: boolean; enabled?: boolean },
): { svg: string | null; status: MermaidStatus } {
	const { resolvedTheme } = useTheme();
	const mode: MermaidThemeMode = resolvedTheme === "dark" ? "dark" : "light";
	const config = useMemo(() => getMermaidConfig(mode), [mode]);
	const enabled = options?.enabled ?? true;
	const inView = useInView(rootRef, {
		enabled: enabled && (options?.defer ?? true),
	});
	const renderId = useId().replace(/:/g, "");
	const [svg, setSvg] = useState<string | null>(null);
	const [status, setStatus] = useState<MermaidStatus>("pending");
	const versionRef = useRef(0);
	const cacheKey = `${mode}\u0000${source}`;

	useEffect(() => {
		if (!enabled || !inView) return;
		const text = source.trim();
		if (!text) {
			setSvg(null);
			setStatus("empty");
			return;
		}

		const cached = svgCache.get(cacheKey);
		if (cached) {
			setSvg(cached);
			setStatus("ready");
			return;
		}

		const version = ++versionRef.current;
		// Keep the last successful diagram visible while a new source or theme
		// render is compiling; this prevents the message from collapsing.
		setStatus("pending");
		const timeout = window.setTimeout(() => {
			void (async () => {
				try {
					// Mermaid stays out of the main chunk: notes and chats without
					// diagrams never download it.
					const { mermaid } = await import("@streamdown/mermaid");
					const result = await mermaid
						.getMermaid(config)
						.render(`agentero-mermaid-${renderId}-${version}`, text);
					if (versionRef.current !== version) return;
					cacheSvg(cacheKey, result.svg);
					setSvg(result.svg);
					setStatus("ready");
				} catch {
					if (versionRef.current !== version) return;
					setSvg(null);
					setStatus("error");
				}
			})();
		}, RENDER_DEBOUNCE_MS);

		return () => {
			versionRef.current += 1;
			window.clearTimeout(timeout);
		};
	}, [cacheKey, config, enabled, inView, renderId, source]);

	return { svg, status };
}

/**
 * Mermaid writes its intrinsic size into the SVG (`max-width: <px>` plus a
 * matching viewBox). Reading it back lets us fit wide diagrams to the pane
 * without measuring the DOM after injection.
 */
function intrinsicWidth(svg: string): number {
	const maxWidth = svg.match(/max-width:\s*([\d.]+)px/);
	if (maxWidth) return Number.parseFloat(maxWidth[1]);
	const viewBox = svg.match(/viewBox="([^"]+)"/);
	const width = viewBox
		? Number.parseFloat(viewBox[1].trim().split(/[\s,]+/)[2])
		: 0;
	return Number.isFinite(width) ? width : 0;
}

function intrinsicSize(svg: string): { width: number; height: number } {
	const viewBox = svg.match(/viewBox="([^"]+)"/);
	if (viewBox) {
		const values = viewBox[1]
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		const width = values[2];
		const height = values[3];
		if (
			Number.isFinite(width) &&
			Number.isFinite(height) &&
			width > 0 &&
			height > 0
		) {
			return { width, height };
		}
	}
	const width = intrinsicWidth(svg);
	const heightMatch =
		svg.match(/height:\s*([\d.]+)px/) ?? svg.match(/height="([\d.]+)"/);
	const height = heightMatch ? Number.parseFloat(heightMatch[1]) : width * 0.6;
	return {
		width: width > 0 ? width : 1,
		height: Number.isFinite(height) && height > 0 ? height : 1,
	};
}

function useContentWidth(ref: RefObject<HTMLDivElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const styles = getComputedStyle(element);
			const padding =
				(Number.parseFloat(styles.paddingLeft) || 0) +
				(Number.parseFloat(styles.paddingRight) || 0);
			setWidth(Math.max(0, element.clientWidth - padding));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

function readViewportSize(element: HTMLElement): {
	width: number;
	height: number;
} {
	const rect = element.getBoundingClientRect();
	return {
		width: element.clientWidth || rect.width,
		height: element.clientHeight || rect.height,
	};
}

type MermaidViewportProps = {
	svg: string;
	width: number;
	height: number;
	mode: "inline" | "fullscreen";
	label?: string;
	className?: string;
	style?: CSSProperties;
	onScale?: (scale: number) => void;
};

type MermaidViewportHandle = {
	zoomIn: () => void;
	zoomOut: () => void;
	reset: () => void;
	fit: () => void;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

const MermaidViewport = forwardRef<MermaidViewportHandle, MermaidViewportProps>(
	function MermaidViewport(
		{ svg, width, height, mode, label, className, style, onScale },
		ref,
	) {
		const containerRef = useRef<HTMLDivElement>(null);
		const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
		const viewRef = useRef(view);
		const dragRef = useRef<{
			id: number;
			startX: number;
			startY: number;
			x: number;
			y: number;
		} | null>(null);
		const [dragging, setDragging] = useState(false);

		const applyView = useCallback(
			(next: typeof view) => {
				viewRef.current = next;
				setView(next);
				onScale?.(next.zoom);
			},
			[onScale],
		);
		const fitScale = useCallback(() => {
			const element = containerRef.current;
			if (!element) return 1;
			const box = readViewportSize(element);
			if (box.width <= 0 || box.height <= 0) return 1;
			const horizontal =
				(box.width - (mode === "fullscreen" ? 96 : 32)) / width;
			// Inline graphs are clipped to a fixed height too. Fitting only the
			// width leaves tall graphs cropped even after the Fit action.
			// Leave room above the inline graph for the floating toolbar.
			const vertical =
				(box.height - (mode === "fullscreen" ? 96 : 64)) / height;
			const cap = mode === "fullscreen" ? 2 : 1;
			const scale = Math.min(cap, horizontal, vertical);
			return scale > 0 ? scale : 1;
		}, [height, mode, width]);
		const fitView = useCallback(() => {
			const zoom = fitScale();
			applyView({ zoom, x: 0, y: mode === "inline" ? 16 : 0 });
		}, [applyView, fitScale, mode]);
		const zoomAt = useCallback(
			(target: number, point?: ZoomGesturePoint) => {
				const current = viewRef.current;
				const zoom = Math.max(
					Math.min(MIN_ZOOM, fitScale()),
					Math.min(MAX_ZOOM, target),
				);
				if (Math.abs(zoom - current.zoom) < 0.0001) return;
				const box = containerRef.current?.getBoundingClientRect();
				const ax = point && box ? point.x - box.left - box.width / 2 : 0;
				const ay = point && box ? point.y - box.top - box.height / 2 : 0;
				const ratio = zoom / current.zoom;
				applyView({
					zoom,
					x: ax - (ax - current.x) * ratio,
					y: ay - (ay - current.y) * ratio,
				});
			},
			[applyView, fitScale],
		);
		useImperativeHandle(
			ref,
			() => ({
				zoomIn: () => zoomAt(viewRef.current.zoom * ZOOM_STEP),
				zoomOut: () => zoomAt(viewRef.current.zoom / ZOOM_STEP),
				reset: () => applyView({ zoom: 1, x: 0, y: 0 }),
				fit: fitView,
			}),
			[applyView, fitView, zoomAt],
		);

		useEffect(() => {
			fitView();
			const element = containerRef.current;
			if (!element || typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(fitView);
			observer.observe(element);
			return () => observer.disconnect();
		}, [fitView]);
		useEffect(() => {
			const element = containerRef.current;
			if (!element) return;
			let startZoom = 1;
			let anchor: ZoomGesturePoint | undefined;
			const binding = bindZoomGesture({
				target: element,
				zoomOnWheel: mode === "fullscreen",
				onZoomStart: (point) => {
					startZoom = viewRef.current.zoom;
					anchor =
						Number.isFinite(point.x) && Number.isFinite(point.y)
							? point
							: undefined;
				},
				onZoomChange: (ratio) => {
					zoomAt(startZoom * ratio, anchor);
				},
				onZoomEnd: () => {
					anchor = undefined;
				},
			});
			return () => binding.dispose();
		}, [mode, zoomAt]);
		useEffect(() => {
			if (!dragging) return;
			const onMove = (event: PointerEvent) => {
				const drag = dragRef.current;
				if (!drag || drag.id !== event.pointerId) return;
				applyView({
					zoom: viewRef.current.zoom,
					x: drag.x + event.clientX - drag.startX,
					y: drag.y + event.clientY - drag.startY,
				});
			};
			const onEnd = () => {
				dragRef.current = null;
				setDragging(false);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onEnd);
			window.addEventListener("pointercancel", onEnd);
			window.addEventListener("blur", onEnd);
			return () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onEnd);
				window.removeEventListener("pointercancel", onEnd);
				window.removeEventListener("blur", onEnd);
			};
		}, [applyView, dragging]);

		return (
			<div
				ref={containerRef}
				className={cn(
					"relative touch-none select-none overflow-hidden bg-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
					dragging ? "cursor-grabbing" : "cursor-grab",
					className,
				)}
				style={style}
				role="application"
				aria-label={label}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-operated pan/zoom canvas.
				tabIndex={0}
				data-mermaid-canvas
				onPointerDown={(event) => {
					if (event.pointerType === "mouse" && event.button !== 0) return;
					if (event.isPrimary === false) return;
					event.preventDefault();
					event.currentTarget.focus({ preventScroll: true });
					dragRef.current = {
						id: event.pointerId,
						startX: event.clientX,
						startY: event.clientY,
						x: viewRef.current.x,
						y: viewRef.current.y,
					};
					setDragging(true);
				}}
				onDoubleClick={() =>
					Math.abs(viewRef.current.zoom - fitScale()) < 0.01
						? applyView({ zoom: 1, x: 0, y: 0 })
						: fitView()
				}
				onKeyDown={(event) => {
					if (
						event.metaKey ||
						event.ctrlKey ||
						event.altKey ||
						event.nativeEvent.isComposing
					)
						return;
					if (event.key === "+" || event.key === "=")
						zoomAt(viewRef.current.zoom * ZOOM_STEP);
					else if (event.key === "-") zoomAt(viewRef.current.zoom / ZOOM_STEP);
					else if (event.key === "0") applyView({ zoom: 1, x: 0, y: 0 });
					else if (event.key.toLowerCase() === "f") fitView();
					else if (event.key.startsWith("Arrow")) {
						const { zoom, x, y } = viewRef.current;
						applyView({
							zoom,
							x:
								x +
								(event.key === "ArrowLeft"
									? 40
									: event.key === "ArrowRight"
										? -40
										: 0),
							y:
								y +
								(event.key === "ArrowUp"
									? 40
									: event.key === "ArrowDown"
										? -40
										: 0),
						});
					} else return;
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<div
					className="absolute top-1/2 left-1/2 origin-center [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
					data-mermaid-stage
					role="img"
					aria-label={label}
					style={{
						width: `${width}px`,
						height: `${height}px`,
						marginLeft: `${-width / 2}px`,
						marginTop: `${-height / 2}px`,
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
					}}
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			</div>
		);
	},
);

type MermaidCanvasProps = ComponentPropsWithoutRef<"div"> & {
	svg: string;
	/** Accessible name for the rendered diagram. */
	label?: string;
};

/** Diagram surface: fits wide graphs to the pane and scrolls the overflow. */
export function MermaidCanvas({
	svg,
	label,
	className,
	...props
}: MermaidCanvasProps) {
	const ref = useRef<HTMLDivElement>(null);
	const available = useContentWidth(ref);
	const natural = useMemo(() => intrinsicWidth(svg), [svg]);

	// Mermaid renders at its intrinsic size; scale it down to the column so a
	// wide graph stays whole instead of being clipped at the card edge.
	const fitted =
		available > 0 && natural > 0 ? Math.min(1, available / natural) : 1;
	const width = natural > 0 ? Math.max(1, Math.round(natural * fitted)) : null;

	return (
		<div
			ref={ref}
			className={cn("agentero-scroll-both", className)}
			data-mermaid-canvas
			{...props}
		>
			<div
				className={cn(
					"mx-auto [&_svg]:block [&_svg]:h-auto",
					width
						? "[&_svg]:w-full [&_svg]:max-w-none"
						: "[&_svg]:max-w-full [&_svg]:w-auto",
				)}
				dangerouslySetInnerHTML={{ __html: svg }}
				style={width ? { width: `${width}px` } : undefined}
				{...(label ? { "aria-label": label, role: "img" } : {})}
			/>
		</div>
	);
}

function MermaidPlaceholder() {
	return (
		<div className="flex min-h-24 items-center justify-center text-muted-foreground">
			<LoaderCircle className="size-4 animate-spin" />
		</div>
	);
}

function useCopySource(source: string) {
	const { t } = useTranslation("aiElements");
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(() => {
		void copyTextToClipboard(source, {
			successMessage: t("mermaid.copySource"),
		}).then((ok) => {
			if (!ok) return;
			setCopied(true);
			timer.current = setTimeout(() => setCopied(false), 2000);
		});
	}, [source, t]);
	return { copied, copy };
}

function IconAction({
	label,
	onClick,
	children,
	disabled,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
	disabled?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={ICON_BUTTON_CLASS}
					aria-label={label}
					disabled={disabled}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p>{label}</p>
			</TooltipContent>
		</Tooltip>
	);
}

function ZoomControls({
	scale,
	zoomRef,
}: {
	scale: number;
	zoomRef: RefObject<MermaidViewportHandle | null>;
}) {
	const { t } = useTranslation("aiElements");
	return (
		<>
			<IconAction
				label={t("mermaid.zoomOut")}
				onClick={() => zoomRef.current?.zoomOut()}
			>
				<ZoomOut className="size-4" />
			</IconAction>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-6 min-w-11 px-1 font-mono text-[11px] tabular-nums"
				aria-label={t("mermaid.resetZoom")}
				title={t("mermaid.resetZoom")}
				onClick={() => zoomRef.current?.reset()}
			>
				{Math.round(scale * 100)}%
			</Button>
			<IconAction
				label={t("mermaid.zoomIn")}
				onClick={() => zoomRef.current?.zoomIn()}
			>
				<ZoomIn className="size-4" />
			</IconAction>
			<IconAction
				label={t("mermaid.fitToView")}
				onClick={() => zoomRef.current?.fit()}
			>
				<Scan className="size-4" />
			</IconAction>
		</>
	);
}

function MermaidFullscreen({
	svg,
	onClose,
}: {
	svg: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("aiElements");
	const size = useMemo(() => intrinsicSize(svg), [svg]);
	const zoomRef = useRef<MermaidViewportHandle>(null);
	const [scale, setScale] = useState(1);
	return (
		<DialogContent
			className="inset-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 sm:max-w-none data-open:animate-none data-closed:animate-none"
			showCloseButton={false}
			aria-describedby={undefined}
			data-mermaid-fullscreen
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
				<DialogTitle className="mr-auto flex items-center gap-2 text-sm">
					<Workflow className="size-4 text-muted-foreground" />
					{t("mermaid.label")}
				</DialogTitle>
				<TooltipProvider>
					<div className="flex items-center gap-0.5">
						<ZoomControls scale={scale} zoomRef={zoomRef} />
						<IconAction label={t("mermaid.exitFullscreen")} onClick={onClose}>
							<X className="size-4" />
						</IconAction>
					</div>
				</TooltipProvider>
			</div>
			<MermaidViewport
				ref={zoomRef}
				svg={svg}
				{...size}
				mode="fullscreen"
				className="min-h-0 flex-1"
				label={t("mermaid.label")}
				onScale={setScale}
			/>
		</DialogContent>
	);
}

/**
 * Mermaid block for Markdown/agent output. The diagram is the default view;
 * copy and source actions stay hidden until the block is hovered so a long
 * transcript is not dotted with toolbars.
 */
export function MermaidBlock({
	source,
	className,
	streaming = false,
}: {
	source: string;
	className?: string;
	/** An unfinished fence cannot compile; show the source until it closes. */
	streaming?: boolean;
}) {
	const { t } = useTranslation("aiElements");
	const rootRef = useRef<HTMLDivElement>(null);
	const { svg, status } = useMermaidSvg(source, rootRef, {
		enabled: !streaming,
	});
	const [showSource, setShowSource] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [scale, setScale] = useState(1);
	const zoomRef = useRef<MermaidViewportHandle>(null);
	const size = useMemo(() => (svg ? intrinsicSize(svg) : null), [svg]);
	const availableWidth = useContentWidth(rootRef);
	const viewportHeight = size
		? Math.max(
				190,
				Math.min(
					520,
					Math.round(
						size.height *
							(availableWidth > 0
								? Math.min(1, Math.max(1, availableWidth - 32) / size.width)
								: 1) +
							32,
					),
				),
			)
		: 220;
	const { copied, copy } = useCopySource(source);

	// A broken diagram falls back to its source, which is more useful than
	// hiding the whole block.
	const sourceShown =
		streaming || showSource || status === "error" || status === "empty";

	return (
		<Dialog
			open={fullscreen && !sourceShown && !!svg}
			onOpenChange={setFullscreen}
		>
			<div
				ref={rootRef}
				className={cn(
					"group/mermaid relative my-4 min-w-0 overflow-hidden rounded-md border border-border/60 bg-background",
					className,
				)}
			>
				{sourceShown ? (
					<CodeBlock className="rounded-none border-0 bg-transparent">
						<CodeBlockHeader className="h-11 border-b border-border/60 bg-muted/30 px-2.5 pt-0 pr-24">
							<CodeBlockTitle className="font-mono text-[11px] leading-none text-muted-foreground">
								mermaid
							</CodeBlockTitle>
						</CodeBlockHeader>
						{status === "error" ? (
							<p className="m-0 border-b border-border/60 px-2.5 py-2 text-muted-foreground text-xs">
								{t("mermaid.error")}
							</p>
						) : null}
						<CodeBlockContent
							className="max-h-[min(70vh,640px)]"
							code={source}
							language={"mermaid" as BundledLanguage}
							showLineNumbers={false}
						/>
					</CodeBlock>
				) : svg && size ? (
					<MermaidViewport
						ref={zoomRef}
						svg={svg}
						{...size}
						mode="inline"
						style={{ height: viewportHeight }}
						label={t("mermaid.label")}
						onScale={setScale}
					/>
				) : (
					<MermaidPlaceholder />
				)}

				<div
					className={cn(
						"absolute top-2 right-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-0.5 rounded-md border bg-background/95 p-1 shadow-raised",
						"opacity-0 transition-opacity motion-reduce:transition-none focus-within:opacity-100 group-hover/mermaid:opacity-100 pointer-coarse:opacity-100",
					)}
				>
					<TooltipProvider>
						{sourceShown ? (
							<IconAction label={t("mermaid.copySource")} onClick={copy}>
								{copied ? (
									<Check className="size-4" />
								) : (
									<Copy className="size-4" />
								)}
							</IconAction>
						) : null}
						{streaming || status === "error" ? null : (
							<IconAction
								label={
									showSource
										? t("mermaid.viewDiagram")
										: t("mermaid.viewSource")
								}
								onClick={() => setShowSource((value) => !value)}
							>
								{showSource ? (
									<Workflow className="size-4" />
								) : (
									<Code className="size-4" />
								)}
							</IconAction>
						)}
						{svg && !sourceShown ? (
							<>
								<ZoomControls scale={scale} zoomRef={zoomRef} />
								<Tooltip>
									<TooltipTrigger asChild>
										<DialogTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className={ICON_BUTTON_CLASS}
												aria-label={t("mermaid.viewFullscreen")}
											>
												<Maximize2 className="size-4" />
											</Button>
										</DialogTrigger>
									</TooltipTrigger>
									<TooltipContent>{t("mermaid.viewFullscreen")}</TooltipContent>
								</Tooltip>
							</>
						) : null}
					</TooltipProvider>
				</div>
			</div>
			{svg && !sourceShown ? (
				<MermaidFullscreen svg={svg} onClose={() => setFullscreen(false)} />
			) : null}
		</Dialog>
	);
}

/** Body-only renderer for surfaces that already show the source (editor). */
export function MermaidDiagram({
	source,
	className,
	defer = true,
	errorLabel,
	label,
}: {
	source: string;
	className?: string;
	/** Disable viewport deferral when exporting the whole document. */
	defer?: boolean;
	errorLabel?: string;
	label?: string;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { svg, status } = useMermaidSvg(source, rootRef, { defer });
	return (
		<div
			ref={rootRef}
			className={cn("min-h-8 overflow-hidden", className)}
			contentEditable={false}
		>
			{svg ? (
				<MermaidCanvas className="p-4" label={label} svg={svg} />
			) : status === "error" ? (
				<p className="m-0 px-4 py-3 text-muted-foreground text-xs">
					{errorLabel}
				</p>
			) : null}
		</div>
	);
}

/**
 * Streamdown `renderers` entry: claimed before the diagram plugin path, so
 * `mermaid` fences get this block instead of Streamdown's own card.
 */
export function MermaidCodeRenderer({
	code,
	isIncomplete,
}: Pick<CustomRendererProps, "code" | "isIncomplete">) {
	return <MermaidBlock source={code} streaming={isIncomplete} />;
}
