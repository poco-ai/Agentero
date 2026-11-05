"use client";

import type { DragItemNode } from "@platejs/dnd";
import type { SlateEditor, TElement } from "platejs";
import { useLayoutEffect, useRef, useState } from "react";
import { useDragLayer } from "react-dnd";
import { createPortal } from "react-dom";

type DragAnchor = {
	offsetX: number;
	offsetY: number;
	width: number;
};

const DEFAULT_ANCHOR: DragAnchor = { offsetX: 16, offsetY: 8, width: 0 };

let dragAnchor: DragAnchor = { ...DEFAULT_ANCHOR };

export function setBlockDragAnchor(next: DragAnchor): void {
	dragAnchor = next;
}

function isElementDragItem(
	item: DragItemNode | null,
): item is Extract<DragItemNode, { element: TElement }> {
	return Boolean(item && "element" in item && item.element);
}

function cloneDraggedBlocks(
	item: Extract<DragItemNode, { element: TElement }>,
) {
	const editor = item.editor as SlateEditor | undefined;
	if (!editor) return [];
	const ids = Array.isArray(item.id) ? item.id : item.id ? [item.id] : [];
	const nodes: HTMLElement[] = [];
	for (const id of ids) {
		const entry = editor.api.node({ id, at: [] });
		const node = entry?.[0] ?? (id === item.element.id ? item.element : null);
		if (!node) continue;
		const dom = editor.api.toDOMNode(node);
		if (!dom) continue;
		nodes.push(dom.cloneNode(true) as HTMLElement);
	}
	if (nodes.length === 0) {
		const dom = editor.api.toDOMNode(item.element);
		if (dom) nodes.push(dom.cloneNode(true) as HTMLElement);
	}
	return nodes;
}

/** Follows the pointer with a clone of the dragged block (Touch backend has no HTML5 ghost). */
export function BlockDragPreview() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const itemRef = useRef<DragItemNode | null>(null);
	const [width, setWidth] = useState(0);
	const { isDragging, item, currentOffset } = useDragLayer((monitor) => ({
		currentOffset: monitor.getClientOffset(),
		isDragging: monitor.isDragging(),
		item: monitor.getItem() as DragItemNode | null,
	}));
	itemRef.current = item;
	const dragKey = isElementDragItem(item)
		? `${item.editorId}:${Array.isArray(item.id) ? item.id.join(",") : item.id}`
		: "";

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren();
		const current = itemRef.current;
		if (!isDragging || !isElementDragItem(current)) {
			setWidth(0);
			return;
		}
		const clones = cloneDraggedBlocks(current);
		for (const [index, clone] of clones.entries()) {
			clone.style.pointerEvents = "none";
			// Drop the first clone's document-level top margin so card padding is even.
			if (index === 0) clone.style.marginTop = "0";
			host.append(clone);
		}
		setWidth(dragAnchor.width);
		void dragKey;
	}, [dragKey, isDragging]);

	if (!isDragging || typeof document === "undefined") {
		return null;
	}

	const left = (currentOffset?.x ?? 0) - dragAnchor.offsetX;
	const top = (currentOffset?.y ?? 0) - dragAnchor.offsetY;

	return createPortal(
		<div
			className="pointer-events-none fixed z-[9999]"
			style={{
				left: 0,
				top: 0,
				width: width || undefined,
				transform: `translate(${left}px, ${top}px)`,
			}}
		>
			{/* Card chrome expands around the clone so the grab point on the text stays put. */}
			<div className="relative">
				<div className="absolute -inset-1 rounded-md bg-background/95 shadow-overlay ring-1 ring-foreground/15" />
				<div ref={hostRef} className="relative" />
			</div>
		</div>,
		document.body,
	);
}
