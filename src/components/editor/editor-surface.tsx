"use client";
import type { PlateContentProps } from "platejs/react";
import {
	PlateContainer,
	PlateContent,
	useComposedRef,
	useEditorContainerRef,
} from "platejs/react";
import type * as React from "react";

import { cn } from "@/lib/core/utils";

const editorContainerClassName = cn(
	// Neutral selection (not brand blue) so selected text stays readable in light/dark.
	"relative h-full w-full cursor-text select-text overflow-y-auto caret-foreground selection:bg-foreground/15 focus-visible:outline-none",
	"[&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-foreground/20 [&_.slate-selection-area]:bg-foreground/10",
);

export function EditorContainer({
	className,
	ref,
	...props
}: React.ComponentProps<"div">) {
	const plateContainerRef = useEditorContainerRef();
	const composedRef = useComposedRef(plateContainerRef, ref);
	const containerProps: React.ComponentProps<"div"> = {
		...props,
		ref: composedRef,
	};

	return (
		<PlateContainer
			className={cn(
				"ignore-click-outside/toolbar",
				editorContainerClassName,
				className,
			)}
			{...containerProps}
		/>
	);
}

const editorClassName = cn(
	"group/editor",
	"relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words",
	"rounded-md ring-offset-background focus-visible:outline-none",
	"**:data-slate-placeholder:!top-1/2 **:data-slate-placeholder:-translate-y-1/2 placeholder:text-muted-foreground/80 **:data-slate-placeholder:text-muted-foreground/80 **:data-slate-placeholder:opacity-100!",
	"[&_strong]:font-bold",
);

export const Editor = ({
	className,
	ref,
	...props
}: PlateContentProps & { ref?: React.RefObject<HTMLDivElement | null> }) => (
	<PlateContent
		ref={ref}
		className={cn(editorClassName, className)}
		disableDefaultStyles
		{...props}
	/>
);

Editor.displayName = "Editor";
