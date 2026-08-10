"use client";

import { PlateElement, type PlateElementProps } from "platejs/react";

export function ParagraphElement(props: PlateElementProps) {
	return (
		<PlateElement {...props} className="m-0 px-0 py-1">
			{props.children}
		</PlateElement>
	);
}
