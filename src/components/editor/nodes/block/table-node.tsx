"use client";

import { PlateElement, type PlateElementProps } from "platejs/react";

export function TableElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="table"
			className="my-2 w-full table-fixed border-collapse border border-border text-sm"
		>
			<tbody>{props.children}</tbody>
		</PlateElement>
	);
}

export function TableRowElement(props: PlateElementProps) {
	return <PlateElement {...props} as="tr" className="border-border border-b" />;
}

export function TableCellElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="td"
			className="border border-border px-3 py-1.5 align-top"
		>
			{props.children}
		</PlateElement>
	);
}

export function TableCellHeaderElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="th"
			className="border border-border bg-muted/50 px-3 py-1.5 text-left align-top font-semibold"
		>
			{props.children}
		</PlateElement>
	);
}
