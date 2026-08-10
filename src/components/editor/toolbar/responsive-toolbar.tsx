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

import { Toolbar, ToolbarButton } from "./primitives";

/* shrink-0 in the flex editor column — avoid sticky+z-50 so the bar cannot
 * paint over dockview tab chrome if content height overflows. */
const fixedBarClassName =
	"h-10 w-full shrink-0 items-center justify-between rounded-none border-b border-b-border bg-background/95 p-1 backdrop-blur-sm supports-backdrop-blur:bg-background/60";

export type ToolbarAction = {
	id: string;
	icon: React.ReactNode;
	label: string;
	pressed?: boolean;
	disabled?: boolean;
	onClick: () => void;
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
	const containerRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const [visibleCount, setVisibleCount] = useState(actions.length);
	const [open, setOpen] = useState(false);

	useLayoutEffect(() => {
		const container = containerRef.current;
		const measure = measureRef.current;
		if (!container || !measure) return;

		const update = () => {
			const available = container.clientWidth;
			const items = Array.from(measure.children) as HTMLElement[];
			const overflowBtn = items[items.length - 1];
			const overflowBtnWidth = overflowBtn?.offsetWidth ?? 32;

			let used = 0;
			let count = 0;
			for (let i = 0; i < actions.length; i++) {
				const width = items[i]?.offsetWidth ?? 0;
				const willHideSome = i < actions.length - 1;
				const needed = width + (willHideSome ? overflowBtnWidth : 0);
				if (used + needed > available) {
					break;
				}
				used += width;
				count++;
			}
			setVisibleCount(count);
		};

		const ro = new ResizeObserver(update);
		ro.observe(container);
		update();
		return () => ro.disconnect();
	}, [actions]);

	const visible = actions.slice(0, visibleCount);
	const hidden = actions.slice(visibleCount);

	return (
		<Toolbar className={cn(fixedBarClassName, "overflow-hidden", className)}>
			<div
				ref={containerRef}
				className="flex min-w-0 flex-1 items-center overflow-hidden"
			>
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
				<div className="ml-auto flex shrink-0 items-center">{trailing}</div>
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
