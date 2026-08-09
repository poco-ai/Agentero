"use client";

import { createPlatePlugin } from "platejs/react";
import { WikiLinkElement } from "@/components/editor/nodes/inline/wikilink-node";

/**
 * Stable inline `[[wikilink]]` / `![[embed]]` node.
 *
 * Its text child owns the portable source syntax. Selection only changes how
 * the component projects that child.
 */
export const WikiLinkPlugin = createPlatePlugin({
	key: "wikiLink",
	node: { isElement: true, isInline: true },
}).withComponent(WikiLinkElement);
