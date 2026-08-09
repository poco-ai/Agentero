"use client";

import {
	type TocSideBarProps,
	useTocSideBar,
	useTocSideBarState,
} from "@platejs/toc/react";
import i18n from "@/i18n";
import { cn } from "@/lib/core/utils";

const markerWidthByDepth = {
	1: "w-8",
	2: "w-6",
	3: "w-[18px]",
	4: "w-3",
	5: "w-2.5",
	6: "w-2",
} as const;

/**
 * Mounting this component costs two full-document walks per edit (both
 * `useTocSideBarState` and its observer call `getHeadingList`), so the caller
 * gates on this threshold instead of letting the component render null.
 */
export const MINIMUM_TOC_HEADINGS = 3;

export function TocSidebar(props: TocSideBarProps) {
	const state = useTocSideBarState(props);
	const { navProps, onContentClick } = useTocSideBar(state);

	if (state.headingList.length < MINIMUM_TOC_HEADINGS) return null;

	return (
		<nav
			{...navProps}
			aria-label={i18n.t("editor:toc.label")}
			className={cn(
				"group/toc absolute top-1/4 right-2 z-20 w-12",
				"transition-[width] duration-200 ease-out hover:w-64 focus-within:w-64 motion-reduce:transition-none",
			)}
		>
			<div
				className={cn(
					"rounded-lg border border-transparent bg-transparent p-2",
					"transition-[background-color,border-color,box-shadow] duration-200 ease-out",
					"group-hover/toc:border-border/60 group-hover/toc:bg-background/95 group-hover/toc:shadow-md",
					"group-focus-within/toc:border-border/60 group-focus-within/toc:bg-background/95 group-focus-within/toc:shadow-md",
				)}
			>
				<div
					id="toc_wrap"
					className="agentero-scroll max-h-[min(46vh,28rem)] overflow-y-auto overscroll-contain"
				>
					{state.headingList.map((item) => {
						const active = item.id === state.activeContentId;

						return (
							<button
								key={item.id}
								id={active ? "toc_item_active" : undefined}
								type="button"
								aria-current={active ? "location" : undefined}
								aria-label={item.title}
								data-active={active}
								className={cn(
									"group/item flex h-6 w-full items-center justify-between gap-2 rounded-sm px-1 outline-none",
									"transition-[background-color,color] duration-200 ease-out",
									"text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
									active && "text-foreground hover:text-foreground",
								)}
								onClick={(event) => onContentClick(event, item, "smooth")}
							>
								<span
									className={cn(
										"pointer-events-none min-w-0 flex-1 truncate text-left text-xs",
										"translate-x-1 opacity-0 transition-[transform,opacity] duration-200 ease-out",
										"group-hover/toc:translate-x-0 group-hover/toc:opacity-100",
										"group-focus-within/toc:translate-x-0 group-focus-within/toc:opacity-100",
										"motion-reduce:transition-none",
										active ? "font-semibold" : "font-normal",
									)}
								>
									{item.title}
								</span>
								<span
									aria-hidden="true"
									className={cn(
										"h-0.5 shrink-0 rounded-full bg-muted-foreground/35",
										"transition-[height,width,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
										markerWidthByDepth[
											item.depth as keyof typeof markerWidthByDepth
										] ?? markerWidthByDepth[6],
										"group-hover/item:bg-muted-foreground/70",
										active &&
											"h-1 bg-foreground ring-2 ring-foreground/15 group-hover/item:bg-foreground",
									)}
								/>
							</button>
						);
					})}
				</div>
			</div>
		</nav>
	);
}
