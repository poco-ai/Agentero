import type { ElementNode } from "@openuidev/lang-core";
import { isElementNode } from "@openuidev/lang-core";

export function stringProp(
	props: Record<string, unknown>,
	key: string,
): string {
	const value = props[key];
	return typeof value === "string" ? value : "";
}

export function optionalStringProp(
	props: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = props[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function stringMatrix(value: unknown): string[][] {
	if (!Array.isArray(value)) return [];
	return value.map((row) => stringList(row));
}

export function numberList(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is number =>
					typeof item === "number" && Number.isFinite(item),
			)
		: [];
}

export function numberProp(
	props: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = props[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function booleanProp(
	props: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = props[key];
	return typeof value === "boolean" ? value : undefined;
}

export function childNodes(value: unknown): ElementNode[] {
	return Array.isArray(value) ? value.filter(isElementNode) : [];
}

export function gapClass(value: unknown): string {
	switch (value) {
		case "sm":
			return "gap-2";
		case "lg":
			return "gap-5";
		default:
			return "gap-3";
	}
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
