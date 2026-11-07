"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useMemo } from "react";
import { getKatexHtml } from "@/lib/math/katex-cache";
import { booleanProp, stringProp } from "./shared";

const KATEX_OPTIONS = {
	throwOnError: false,
	errorColor: "#cc0000",
	strict: "ignore" as const,
	trust: false,
	output: "html" as const,
};

export function MathNode({ node }: { node: ElementNode }) {
	const tex = stringProp(node.props, "tex");
	const display = booleanProp(node.props, "display") ?? true;
	const html = useMemo(() => {
		try {
			return getKatexHtml(tex, { ...KATEX_OPTIONS, displayMode: display });
		} catch {
			return null;
		}
	}, [display, tex]);

	if (!html) {
		return (
			<pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">
				{tex}
			</pre>
		);
	}
	if (!display) {
		return (
			<span
				className="inline-block align-middle"
				// KaTeX output from local TeX with trust:false.
				// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renderToString
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}
	return (
		<div
			className="overflow-x-auto py-1 text-center"
			// KaTeX output from local TeX with trust:false.
			// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renderToString
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
