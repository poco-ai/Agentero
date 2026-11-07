import {
	ElementApi,
	KEYS,
	NodeIdPlugin,
	type SlateEditor,
	type Value,
} from "platejs";
import { IMAGE_GROUP_KEY } from "./image-group";

/**
 * Compare parsed data with its live projection. Plate adds generated node IDs
 * at runtime. An ID that is explicitly present in the new value still matters.
 */
function sameProjection(
	current: unknown,
	parsed: unknown,
	idKey: string,
): boolean {
	if (Object.is(current, parsed)) return true;
	if (Array.isArray(current) || Array.isArray(parsed)) {
		return (
			Array.isArray(current) &&
			Array.isArray(parsed) &&
			current.length === parsed.length &&
			current.every((child, index) =>
				sameProjection(child, parsed[index], idKey),
			)
		);
	}
	if (
		!current ||
		!parsed ||
		typeof current !== "object" ||
		typeof parsed !== "object" ||
		Object.getPrototypeOf(current) !== Object.prototype ||
		Object.getPrototypeOf(parsed) !== Object.prototype
	)
		return false;

	const left = current as Record<string, unknown>;
	const right = parsed as Record<string, unknown>;
	const ignoreGeneratedId =
		ElementApi.isElement(left) && !Object.hasOwn(right, idKey);
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length -
			(ignoreGeneratedId && Object.hasOwn(left, idKey) ? 1 : 0) ===
			rightKeys.length &&
		rightKeys.every(
			(key) =>
				Object.hasOwn(left, key) &&
				sameProjection(left[key], right[key], idKey),
		)
	);
}

/**
 * Apply a full parse while keeping proven-equal top-level nodes on either
 * side. A changed block still goes through Plate's normal transforms. This
 * avoids the per-node work and DOM churn of replacing a whole long note after
 * a small source edit, without making assumptions about Markdown parse scope.
 */
export function applySourceProjection(editor: SlateEditor, parsed: Value) {
	const current = editor.children;
	const idKey = editor.getOptions(NodeIdPlugin).idKey ?? "id";
	let from = 0;
	while (
		from < current.length &&
		from < parsed.length &&
		sameProjection(current[from], parsed[from], idKey)
	)
		from += 1;

	let oldEnd = current.length;
	let newEnd = parsed.length;
	while (
		oldEnd > from &&
		newEnd > from &&
		sameProjection(current[oldEnd - 1], parsed[newEnd - 1], idKey)
	) {
		oldEnd -= 1;
		newEnd -= 1;
	}

	if (from === oldEnd && from === newEnd) return;
	// Image grouping normalizes across neighboring blocks. A delete can
	// make an untouched image on the right merge with its new predecessor.
	const right = current[oldEnd];
	if (
		(right && (right.type === KEYS.img || right.type === IMAGE_GROUP_KEY)) ||
		(from === 0 && oldEnd === current.length && newEnd === parsed.length)
	) {
		editor.tf.setValue(parsed);
		return;
	}
	editor.tf.withoutNormalizing(() => {
		for (let index = oldEnd - 1; index >= from; index -= 1) {
			editor.tf.removeNodes({ at: [index] });
		}
		if (newEnd > from)
			editor.tf.insertNodes(parsed.slice(from, newEnd), { at: [from] });
	});
}
