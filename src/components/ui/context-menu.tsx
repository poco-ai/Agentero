import { CheckIcon } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/core/utils";

function ContextMenu({
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
	return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
	return (
		<ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
	);
}

function ContextMenuContent({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				data-slot="context-menu-content"
				className={cn(
					"z-50 max-h-(--radix-context-menu-content-available-height) min-w-40 origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-overlay ring-1 ring-foreground/10 duration-150 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuItem({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
	inset?: boolean;
}) {
	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			data-inset={inset}
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

function ContextMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
	return (
		<ContextMenuPrimitive.CheckboxItem
			data-slot="context-menu-checkbox-item"
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			checked={checked}
			{...props}
		>
			<span
				className="pointer-events-none absolute right-2 flex items-center justify-center"
				data-slot="context-menu-checkbox-item-indicator"
			>
				<ContextMenuPrimitive.ItemIndicator>
					<CheckIcon />
				</ContextMenuPrimitive.ItemIndicator>
			</span>
			{children}
		</ContextMenuPrimitive.CheckboxItem>
	);
}

function ContextMenuLabel({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
	inset?: boolean;
}) {
	return (
		<ContextMenuPrimitive.Label
			data-slot="context-menu-label"
			data-inset={inset}
			className={cn(
				"px-2 py-1.5 text-xs font-medium text-muted-foreground data-inset:pl-7",
				className,
			)}
			{...props}
		/>
	);
}

function ContextMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
	return (
		<ContextMenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn("-mx-1.5 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

function ContextMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="context-menu-shortcut"
			className={cn(
				"ml-auto pl-4 text-xs tracking-widest text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
};
