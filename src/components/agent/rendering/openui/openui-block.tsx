"use client";

import type { ElementNode, StreamParser } from "@openuidev/lang-core";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PlainCodeBlockView } from "@/components/agent/rendering/plain-code-block";
import {
	createOpenUiParser,
	type OpenUiBlockView,
	type OpenUiFailureReason,
	resolveOpenUiBlock,
} from "@/lib/agent/openui/parse";
import { OpenUiNode } from "./openui-node";

function useOpenUiView(source: string, streaming: boolean): OpenUiBlockView {
	const parserRef = useRef<StreamParser | null>(null);
	const lastValidRef = useRef<ElementNode | null>(null);
	const previousSourceRef = useRef(source);
	const parser = parserRef.current ?? createOpenUiParser();
	parserRef.current = parser;

	if (
		previousSourceRef.current !== source &&
		!source.startsWith(previousSourceRef.current)
	) {
		parserRef.current = createOpenUiParser();
		lastValidRef.current = null;
	}
	previousSourceRef.current = source;

	return useMemo(() => {
		const result = parserRef.current?.set(source, !streaming);
		if (!result) return { kind: "streaming", root: null, source };
		const resolved = resolveOpenUiBlock({
			source,
			result,
			streaming,
			lastValid: lastValidRef.current,
		});
		lastValidRef.current = resolved.lastValid;
		return resolved.view;
	}, [source, streaming]);
}

/**
 * Streamdown replaces the fenced code block with this read-only renderer.
 * While streaming it keeps the last structurally valid props; after the fence
 * settles every failure path shows the source plus a short reason.
 */
export function OpenUiBlock({
	source,
	streaming,
}: {
	source: string;
	streaming: boolean;
}) {
	const view = useOpenUiView(source, streaming);

	if (view.kind === "failed") {
		return <OpenUiFallback source={source} reason={view.reason} />;
	}

	return (
		<div
			className="my-4 min-w-0 max-w-full"
			data-openui-block
			data-openui-state={view.kind}
		>
			{view.root ? <OpenUiNode node={view.root} /> : <StreamingPlaceholder />}
		</div>
	);
}

function StreamingPlaceholder() {
	const { t } = useTranslation("agent");
	return (
		<div
			className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
			data-openui-streaming
		>
			<LoaderCircle className="size-3.5 animate-spin" />
			<span>{t("uiBlock.streaming")}</span>
		</div>
	);
}

const FAILURE_COPY = {
	empty: "uiBlock.empty",
	invalid: "uiBlock.invalid",
	tooLarge: "uiBlock.tooLarge",
	incomplete: "uiBlock.incomplete",
} as const;

function OpenUiFallback({
	source,
	reason,
}: {
	source: string;
	reason: OpenUiFailureReason;
}) {
	const { t } = useTranslation("agent");
	return (
		<div className="my-4 min-w-0 max-w-full" data-openui-fallback={reason}>
			<div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
				<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
				<span className="min-w-0">{t(FAILURE_COPY[reason])}</span>
			</div>
			<PlainCodeBlockView
				code={source.replace(/\s+$/u, "")}
				language="openui-lang"
			/>
		</div>
	);
}
