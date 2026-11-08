"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { resolveTone } from "../styles";
import { stringProp } from "./shared";
import { ToneBadge } from "./tone-badge";

export function BadgeNode({ node }: { node: ElementNode }) {
	const tone = resolveTone(stringProp(node.props, "tone"), "neutral");
	return <ToneBadge tone={tone}>{stringProp(node.props, "label")}</ToneBadge>;
}
