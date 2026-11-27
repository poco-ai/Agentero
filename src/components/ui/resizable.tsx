import type { ComponentProps, ComponentPropsWithRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/core/utils";

/**
 * Panes own their scrolling (tree/rail `.agentero-scroll`, Dockview, editors),
 * so the panel wrapper must never scroll.
 *
 * The library hard-codes `overflow: auto` on the inner element it wraps around
 * `children` and spreads the `style` prop *after* that default, so only an
 * inline `overflow` can override it — a Tailwind `overflow-hidden` class loses
 * to the inline style. Leaving it scrollable makes a pane whose content exactly
 * fills it oscillate: a sub-pixel rounding makes the content 1px larger, the
 * wrapper gains classic scrollbars, its client box shrinks by their width, the
 * content re-fits, the bars vanish, and the pane repeats that at frame rate.
 * macOS hides it because overlay scrollbars take no layout space; Windows
 * (WebView2) shows it as a violently flickering right rail, with Dockview
 * rewriting its layout styles every frame.
 */
const PANEL_CONTENT_STYLE = { overflow: "hidden" } as const;

export function ResizablePanel({
	style,
	...props
}: ComponentProps<typeof Panel>) {
	return <Panel style={{ ...PANEL_CONTENT_STYLE, ...style }} {...props} />;
}

export function ResizableGroup({
	className,
	...props
}: ComponentPropsWithRef<typeof Group>) {
	return <Group className={cn("isolate", className)} {...props} />;
}

/**
 * Editor-style sash (VS Code / Cursor): 1px line, wider invisible hit target.
 */
export function ResizableHandle({
	className,
	...props
}: ComponentProps<typeof Separator>) {
	return (
		<Separator
			className={cn(
				// Visual: single 1px rule; hit area via ::after (~5px)
				"relative z-10 w-px shrink-0 bg-border outline-none transition-colors",
				"hover:bg-foreground/25 data-[separator=active]:bg-foreground/35",
				"after:absolute after:inset-y-0 after:left-1/2 after:w-[5px] after:-translate-x-1/2",
				"after:content-['']",
				className,
			)}
			{...props}
		/>
	);
}
