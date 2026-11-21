/** Read-only annotation references captured on a sent message. */
import { ImageIcon, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultRemarkPlugins } from "streamdown";
import { AnnotationSnapshotCards } from "@/components/agent/annotation-snapshot-cards";
import { MessageResponse } from "@/components/agent/message";
import { REFERENCE_CHIP_CLASS } from "@/components/agent/reference-chip-style";
import { AgentCitationLink } from "@/components/agent/rendering/agent-citation-link";
import { QuoteIcon } from "@/components/icons/quote-icon";
import { SelectionSourceButton } from "@/components/selection/selection-source-button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import type { AnnotationSnapshot } from "@/lib/agent/annotation-snapshot";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { cn } from "@/lib/core/utils";
import { remarkHighlightToHtml } from "@/lib/markdown/highlight-to-html";

export function SentAnnotationChip({
	snapshot,
	selection,
	image,
}: {
	snapshot: AnnotationSnapshot;
	selection?: SelectionContext;
	image?: ChatVisualAnnotation["image"];
}) {
	const { t } = useTranslation("agent");
	const [open, setOpen] = useState(false);
	const label =
		(snapshot.quote || snapshot.comment)?.replace(/\s+/g, " ").trim() ||
		(snapshot.page
			? t("composer.visualAnnotationPage", { page: snapshot.page })
			: t("transcript.annotationLabel", { n: snapshot.n }));
	const visual = snapshot.kind === "visual";
	const buildLog = selection?.surface === "build-log";
	const Icon = buildLog ? TriangleAlert : visual ? ImageIcon : QuoteIcon;
	return (
		<HoverCard
			open={open}
			onOpenChange={setOpen}
			openDelay={150}
			closeDelay={180}
		>
			<HoverCardTrigger asChild>
				<button
					type="button"
					data-composer-chip={visual ? "visual" : "selection"}
					data-annotation-snapshot={snapshot.n}
					className={REFERENCE_CHIP_CLASS}
					onFocus={() => setOpen(true)}
					onBlur={() => setOpen(false)}
					onClick={() => setOpen(true)}
				>
					<span className="flex max-w-full items-center gap-0.5">
						<Icon
							className={cn(
								"size-3 shrink-0",
								buildLog ? "text-destructive" : "text-muted-foreground",
							)}
							aria-hidden
						/>
						<span className="min-w-0 truncate">{label}</span>
					</span>
				</button>
			</HoverCardTrigger>
			<HoverCardContent
				data-annotation-ui
				align="end"
				collisionPadding={8}
				className="max-h-[min(24rem,var(--radix-hover-card-content-available-height))] w-[min(28rem,calc(100vw-1rem))] overflow-y-auto"
			>
				{selection ? <SelectionSourceButton selection={selection} /> : null}
				{image?.data ? (
					<img
						src={`data:${image.mimeType || "image/png"};base64,${image.data}`}
						alt={t("composer.visualAnnotationPreviewAlt", {
							page: snapshot.page,
						})}
						className="mb-2 max-h-48 w-full rounded-md object-contain"
					/>
				) : null}
				<AnnotationSnapshotCards snapshots={[snapshot]} />
			</HoverCardContent>
		</HoverCard>
	);
}

export function selectionSnapshot(
	selection: SelectionContext,
	n: number,
): AnnotationSnapshot {
	return {
		n,
		kind: "text",
		quote: selection.text,
		comment: selection.comment,
		source: selection.sourceTitle || selection.sourcePath,
		page: selection.page,
		translation: selection.context?.translation,
	};
}

/** Render numbered markers as references while preserving Markdown around them. */
export function AnnotationMarkerText({
	text,
	snapshots,
}: {
	text: string;
	snapshots: readonly AnnotationSnapshot[];
}) {
	const byN = new Map(snapshots.map((snapshot) => [snapshot.n, snapshot]));
	return (
		<MessageResponse
			className="text-base leading-relaxed"
			remarkPlugins={[
				...Object.values(defaultRemarkPlugins),
				remarkHighlightToHtml,
				annotationReferences,
			]}
			components={{
				a: (props) => {
					const { href } = props;
					const n = Number(href?.match(/^#agentero-annotation-(\d+)$/)?.[1]);
					const snapshot = byN.get(n);
					return snapshot ? (
						<SentAnnotationChip snapshot={snapshot} />
					) : Number.isFinite(n) ? (
						<span>{props.children}</span>
					) : (
						<AgentCitationLink {...props} />
					);
				},
			}}
		>
			{text}
		</MessageResponse>
	);
}

type MarkdownNode = {
	type: string;
	value?: string;
	url?: string;
	children?: MarkdownNode[];
};

export function LooseSelectionChips({
	selections,
}: {
	selections: readonly SelectionContext[];
}) {
	return (
		<>
			{selections.map((selection, index) => (
				<SentAnnotationChip
					key={selection.id}
					selection={selection}
					snapshot={selectionSnapshot(selection, index + 1)}
				/>
			))}
		</>
	);
}

// Transform only Markdown text nodes, keeping code and link destinations intact.
function annotationReferences() {
	return (tree: MarkdownNode) => {
		const walk = (node: MarkdownNode) => {
			if (
				!node.children ||
				node.type === "link" ||
				node.type === "linkReference"
			)
				return;
			node.children = node.children.flatMap((child) => {
				if (child.type !== "text" || !child.value) {
					walk(child);
					return [child];
				}
				const parts: MarkdownNode[] = [];
				let last = 0;
				for (const match of child.value.matchAll(/\[Annotation (\d+)\]/g)) {
					const n = Number(match[1]);
					const index = match.index ?? 0;
					if (index > last)
						parts.push({ type: "text", value: child.value.slice(last, index) });
					parts.push({
						type: "link",
						url: `#agentero-annotation-${n}`,
						children: [{ type: "text", value: match[0] }],
					});
					last = index + match[0].length;
				}
				if (last === 0) return [child];
				if (last < child.value.length)
					parts.push({ type: "text", value: child.value.slice(last) });
				return parts;
			});
		};
		walk(tree);
	};
}
