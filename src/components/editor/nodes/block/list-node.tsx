"use client";

import { isOrderedList } from "@platejs/list";
import {
	useTodoListElement,
	useTodoListElementState,
} from "@platejs/list/react";
import type { TListElement } from "platejs";
import {
	type PlateElementProps,
	type RenderNodeWrapper,
	useReadOnly,
} from "platejs/react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/core/utils";

type ListProps = PlateElementProps & { lineBreakBadge?: React.ReactNode };

/**
 * Ordered + todo lists need a real `<ol>` / `<ul>` wrapper (for `start` and the
 * checkbox). Unordered lists use inject `display:list-item` instead — see
 * `MarkdownEditorKit` ListPlugin config — so they must not be wrapped here
 * (that would paint a second bullet).
 */
export const BlockList: RenderNodeWrapper = (props) => {
	const styleType = props.element.listStyleType as string | undefined;
	if (!styleType) return;
	if (!isOrderedList(props.element) && styleType !== "todo") return;

	return (childProps: ListProps) => <List {...childProps} />;
};

function List(props: ListProps) {
	const { listStart, listStyleType } = props.element as TListElement;
	const isTodo = listStyleType === "todo";
	const Tag = isOrderedList(props.element) ? "ol" : "ul";

	return (
		<Tag
			className={cn(
				"relative m-0 py-0",
				// Tailwind preflight sets list-style:none; restore markers and
				// leave room for outside bullets/numbers (overflow-x-hidden on the
				// editor would otherwise clip them).
				isTodo ? "list-none p-0" : "list-outside ps-[1.5em]",
			)}
			style={{ listStyleType: isTodo ? "none" : listStyleType }}
			start={listStart}
		>
			{isTodo ? (
				<TodoLi {...props} />
			) : (
				<li className="ps-0">
					{props.children}
					{props.lineBreakBadge}
				</li>
			)}
		</Tag>
	);
}

function TodoLi(props: ListProps) {
	const state = useTodoListElementState({ element: props.element });
	const { checkboxProps } = useTodoListElement(state);
	const readOnly = useReadOnly();

	return (
		<li
			className={cn(
				"relative list-none",
				Boolean(props.element.checked) && "text-muted-foreground line-through",
			)}
		>
			{/*
			 * Plate `belowNodes` wraps *inside* the block (e.g. `<p class="py-1">`),
			 * so the list already sits in the content box after paragraph padding.
			 * Center the checkbox in the first line box (`1lh`) from `top-0` — do
			 * not also apply `top-1` (that double-counts py-1 and drops the box
			 * below the text, especially visible when zoomed; #143).
			 */}
			<div
				contentEditable={false}
				className="absolute top-0 -left-6 flex h-[1lh] w-4 items-center justify-center"
			>
				<Checkbox
					className={cn(readOnly && "pointer-events-none")}
					{...checkboxProps}
				/>
			</div>
			{props.children}
			{props.lineBreakBadge}
		</li>
	);
}
