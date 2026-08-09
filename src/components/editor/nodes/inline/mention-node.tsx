"use client";

import type { TMentionElement } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useSelected,
} from "platejs/react";
import { cn } from "@/lib/core/utils";

export function MentionElement(props: PlateElementProps<TMentionElement>) {
	const selected = useSelected();

	return (
		<PlateElement
			{...props}
			as="span"
			className={cn(
				"inline-block rounded-sm bg-muted px-1.5 py-0.5 align-baseline font-medium text-sm",
				selected && "ring-2 ring-ring",
			)}
		>
			<span contentEditable={false}>@{props.element.value}</span>
			{props.children}
		</PlateElement>
	);
}
