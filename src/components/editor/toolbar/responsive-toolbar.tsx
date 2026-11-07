"use client";

import { MoreHorizontal } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/core/utils";

import { fitToolbarActions } from "./fit-actions";
import { Toolbar, ToolbarButton } from "./primitives";

/* shrink-0 in the flex editor column — avoid sticky+z-50 so the bar cannot
 * paint over dockview tab chrome if content height overflows. */
const fixedBarClassName =
	"h-9 w-full shrink-0 items-center justify-between rounded-none border-b border-b-border bg-background/95 p-1 backdrop-blur-sm supports-backdrop-blur:bg-background/60";

export type ToolbarAction = {
	id: string;
	icon: React.ReactNode;
	label: string;
	pressed?: boolean;
	disabled?: boolean;
	onClick: () => void;
	/** Keep focus in the editor surface (source mode) when clicking. */
	onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
	/** Group index; separators are inserted between different groups. */
	group: number;
};

function ActionButton({
	action,
	showSeparator,
}: {
	action: ToolbarAction;
	showSeparator: boolean;
}) {
	return (
		<div className="flex shrink-0 items-center">
			{showSeparator && (
				<Separator orientation="vertical" className="mx-1.5 h-5" />
			)}
			<ToolbarButton
				tooltip={action.label}
				aria-label={action.label}
				pressed={action.pressed}
				disabled={action.disabled}
				onMouseDown={action.onMouseDown}
				onClick={action.onClick}
			>
				{action.icon}
			</ToolbarButton>
		</div>
	);
}

export function ResponsiveFixedToolbar({
	actions,
	className,
	trailing,
}: {
	actions: ToolbarAction[];
	className?: string;
	/** Pinned at the right end; never collapses into the overflow menu. */
	trailing?: React.ReactNode;
}) {
	const { t } = useTranslation("editor");
	const barRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const trailingRef = useRef<HTMLDivElement>(null);
	const [visibleCount, setVisibleCount] = useState(actions.length);
	const [open, setOpen] = useState(false);

	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	// Re-fit only when the action set or a label changes; widths come from the
	// measurement row, so a per-render effect would just add layout reads to
	// every keystroke (the toolbar re-renders on each selection change).
	const actionKey = actions
		.map((action) => `${action.id}\u0000${action.label}`)
		.join("\u0001");

	// biome-ignore lint/correctness/useExhaustiveDependencies: actionKey refits when the action set or labels change; widths come from the measurement row, so this must not run per render.
	useLayoutEffect(() => {
		const bar = barRef.current;
		const measure = measureRef.current;
		if (!bar || !measure) return;

		let frame = 0;

		const update = () => {
			frame = 0;
			// Whole pixels: sub-pixel jitter between frames would otherwise flip
			// the count back and forth on fractional pane widths.
			const width = Math.round(bar.clientWidth);
			// A collapsed or not-yet-laid-out pane reports 0. Keep the current
			// count instead of collapsing: the observer below refits as soon as
			// the bar has a real width, whereas a collapse has nothing to undo it.
			if (width <= 0) return;

			const style = window.getComputedStyle(bar);
			const inner =
				width -
				(Number.parseFloat(style.paddingLeft) || 0) -
				(Number.parseFloat(style.paddingRight) || 0);
			const items = Array.from(measure.children) as HTMLElement[];
			const overflowWidth = items[items.length - 1]?.offsetWidth ?? 32;
			const widths = actionsRef.current.map(
				(_, index) => items[index]?.offsetWidth ?? 0,
			);
			const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
			setVisibleCount(
				fitToolbarActions(widths, inner - trailingWidth, overflowWidth),
			);
		};

		// Off the observer callback: writing the fit back into the DOM from the
		// same delivery re-enters the observer (see fit-actions.ts).
		const schedule = () => {
			if (frame) return;
			frame = window.requestAnimationFrame(update);
		};

		const observer = new ResizeObserver(schedule);
		// Bar: pane/width changes. Measure row: labels or fonts reflow.
		// Trailing: the pinned cluster can appear after async paper metadata.
		observer.observe(bar);
		observer.observe(measure);
		if (trailingRef.current) observer.observe(trailingRef.current);
		update();

		return () => {
			observer.disconnect();
			if (frame) window.cancelAnimationFrame(frame);
		};
	}, [actionKey]);

	const visible = actions.slice(0, visibleCount);
	const hidden = actions.slice(visibleCount);

	return (
		<Toolbar
			ref={barRef}
			className={cn(fixedBarClassName, "overflow-hidden", className)}
		>
			<div className="flex min-w-0 flex-1 items-center overflow-hidden">
				{visible.map((action, index) => (
					<ActionButton
						key={action.id}
						action={action}
						showSeparator={
							index > 0 && action.group !== visible[index - 1].group
						}
					/>
				))}
			</div>

			{hidden.length > 0 && (
				<DropdownMenu open={open} onOpenChange={setOpen}>
					<DropdownMenuTrigger asChild>
						<ToolbarButton
							tooltip={t("toolbar.more")}
							aria-label={t("toolbar.more")}
						>
							<MoreHorizontal />
						</ToolbarButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{hidden.map((action, index) => {
							const showSeparator =
								index > 0 && action.group !== hidden[index - 1].group;
							return (
								<Fragment key={action.id}>
									{showSeparator && <DropdownMenuSeparator />}
									<DropdownMenuItem
										disabled={action.disabled}
										onSelect={() => {
											action.onClick();
											setOpen(false);
										}}
									>
										<span className="mr-2 flex size-4 items-center justify-center">
											{action.icon}
										</span>
										{action.label}
									</DropdownMenuItem>
								</Fragment>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			{trailing ? (
				<div
					ref={trailingRef}
					className="ml-auto flex shrink-0 items-center gap-0.5"
				>
					{/* Always rendered: a separator that comes and goes with the
					    visible count changes the trailing width, which changes the
					    fit, which changes the visible count. */}
					<Separator orientation="vertical" className="mx-1.5 h-5" />
					{trailing}
				</div>
			) : null}

			{/* Invisible measurement row so we can decide what fits without
			    causing a visible reflow loop. */}
			<div
				ref={measureRef}
				className="pointer-events-none invisible absolute -z-50 flex"
				aria-hidden="true"
			>
				{actions.map((action, index) => (
					<ActionButton
						key={`m-${action.id}`}
						action={action}
						showSeparator={
							index > 0 && action.group !== actions[index - 1].group
						}
					/>
				))}
				<div className="flex shrink-0 items-center">
					<ToolbarButton>
						<MoreHorizontal />
					</ToolbarButton>
				</div>
			</div>
		</Toolbar>
	);
}
