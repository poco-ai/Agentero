// Mermaid renders its own SVG markup; strict mode strips scripts and event handlers.
// biome-ignore-all lint/security/noDangerouslySetInnerHtml: rendered SVG is the diagram output.

"use client";

import { Check, Code, Copy, LoaderCircle, Workflow } from "lucide-react";
import { useTheme } from "next-themes";
import {
	type ComponentPropsWithoutRef,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
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
		setSvg(null);
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

function useContentWidth(ref: RefObject<HTMLDivElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const styles = getComputedStyle(element);
			const padding =
				Number.parseFloat(styles.paddingLeft) +
				Number.parseFloat(styles.paddingRight);
			setWidth(Math.max(0, element.clientWidth - padding));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

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
	const { copied, copy } = useCopySource(source);

	// A broken diagram falls back to its source, which is more useful than
	// hiding the whole block.
	const sourceShown = streaming || showSource || (status === "error" && !svg);

	return (
		<div
			ref={rootRef}
			className={cn(
				"group/mermaid relative my-4 min-w-0 overflow-hidden rounded-md border border-border/60 bg-background",
				className,
			)}
		>
			{sourceShown ? (
				<>
					{status === "error" ? (
						<p className="m-0 border-b border-border/60 px-2.5 py-2 text-muted-foreground text-xs">
							{t("mermaid.error")}
						</p>
					) : null}
					<CodeBlockContent
						className="m-0 max-h-[min(70vh,640px)] rounded-none border-0 bg-transparent pt-11"
						code={source}
						language={"mermaid" as BundledLanguage}
						showLineNumbers={false}
					/>
				</>
			) : svg ? (
				<MermaidCanvas className="p-4" label={t("mermaid.label")} svg={svg} />
			) : (
				<MermaidPlaceholder />
			)}

			<div
				className={cn(
					"absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-1 shadow-raised",
					"opacity-0 transition-opacity focus-within:opacity-100 group-hover/mermaid:opacity-100 pointer-coarse:opacity-100",
				)}
			>
				<TooltipProvider>
					<IconAction label={t("mermaid.copySource")} onClick={copy}>
						{copied ? (
							<Check className="size-4" />
						) : (
							<Copy className="size-4" />
						)}
					</IconAction>
					{streaming || status === "error" ? null : (
						<IconAction
							label={
								showSource ? t("mermaid.viewDiagram") : t("mermaid.viewSource")
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
				</TooltipProvider>
			</div>
		</div>
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
