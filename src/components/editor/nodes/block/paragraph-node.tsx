"use client";

import { PlateElement, type PlateElementProps } from "platejs/react";
import { cn } from "@/lib/core/utils";

export function ParagraphElement(props: PlateElementProps) {
	return (
		<PlateElement {...props} className={cn("m-0 px-0 py-1")}>
			{props.children}
		</PlateElement>
	);
}
