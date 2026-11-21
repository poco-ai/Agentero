/**
 * Sent-message view of composer chips and annotation snapshots.
 * The ACP body is plain text; this redraws the chips from the stored draft.
 */
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { SENT_MESSAGE_CHIP_CLASS } from "@/components/agent/reference-chip-style";
import {
	SentAnnotationChip,
	selectionSnapshot,
} from "@/components/agent/sent-annotation-chip";
import { planAnnotationRefs } from "@/lib/agent/annotation-prompt";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";
import {
	commandInvocationLabel,
	commandPrefix,
	displaySkillName,
	mentionChipLabel,
	parseInlineTokenParts,
} from "@/lib/agent/composer-inline-tokens";
import { isPlazaMentionPath } from "@/lib/agent/plaza-mention";
import { cn } from "@/lib/core/utils";

function ChipShell({
	label,
	title,
	prefix,
	onOpen,
}: {
	label: string;
	title: string;
	prefix: ReactNode;
	onOpen?: () => void;
}) {
	if (!onOpen) {
		return (
			<span
				data-composer-chip="true"
				className={SENT_MESSAGE_CHIP_CLASS}
				title={title}
			>
				{prefix}
				<span className="min-w-0 truncate">{label}</span>
			</span>
		);
	}
	return (
		<button
			type="button"
			data-composer-chip="true"
			className={cn(SENT_MESSAGE_CHIP_CLASS, "cursor-pointer hover:bg-muted")}
			title={title}
			onClick={onOpen}
		>
			{prefix}
			<span className="min-w-0 truncate">{label}</span>
		</button>
	);
}

export function InlineChipText({
	markup,
	onOpenPath,
	visuals = [],
	chipsOnly = false,
}: {
	markup: string;
	onOpenPath?: (path: string) => void;
	/** Send-time crops, used to label `{{vis}}` chips. */
	visuals?: readonly ChatVisualAnnotation[];
	/** Edit box: chips only, the textarea holds the prose. */
	chipsOnly?: boolean;
}) {
	const parts = parseInlineTokenParts(markup);
	const ordinals = new Map(
		planAnnotationRefs(markup).map((ref) => [
			ref.kind === "selection"
				? `selection:${ref.selection.id}`
				: `visual:${ref.id}`,
			ref.n,
		]),
	);
	const visualsById = new Map(visuals.map((item) => [item.id, item]));
	const nodes: ReactNode[] = [];
	parts.forEach((part, index) => {
		const key = `${part.type}-${index}`;
		if (part.type === "text") {
			if (chipsOnly || !part.value) return;
			nodes.push(<span key={key}>{part.value}</span>);
			return;
		}
		if (part.type === "mention") {
			const label = mentionChipLabel(part.path);
			const open =
				onOpenPath && !isPlazaMentionPath(part.path)
					? () => onOpenPath(part.path)
					: undefined;
			nodes.push(
				<ChipShell
					key={key}
					label={label}
					title={part.path}
					prefix={<span className="font-mono text-muted-foreground">@</span>}
					onOpen={open}
				/>,
			);
			return;
		}
		if (part.type === "skill") {
			const label = displaySkillName(part.skillId);
			nodes.push(
				<ChipShell
					key={key}
					label={label}
					title={part.skillId}
					prefix={
						<Sparkles className="size-3 shrink-0 text-muted-foreground" />
					}
				/>,
			);
			return;
		}
		if (part.type === "command") {
			const label = displaySkillName(part.name);
			if (!label) return;
			nodes.push(
				<ChipShell
					key={key}
					label={label}
					title={commandInvocationLabel(part.name)}
					prefix={
						<span className="font-mono text-muted-foreground">
							{commandPrefix(part.name)}
						</span>
					}
				/>,
			);
			return;
		}
		if (part.type === "selection") {
			nodes.push(
				<SentAnnotationChip
					key={key}
					selection={part.selection}
					snapshot={selectionSnapshot(
						part.selection,
						ordinals.get(`selection:${part.selection.id}`) ?? index + 1,
					)}
				/>,
			);
			return;
		}
		if (part.type === "visual") {
			const visual = visualsById.get(part.id);
			nodes.push(
				<SentAnnotationChip
					key={key}
					snapshot={{
						n: ordinals.get(`visual:${part.id}`) ?? index + 1,
						kind: "visual",
						page: visual?.page,
						comment: visual?.comment,
						source: visual?.paperPath,
					}}
					image={visual?.image}
				/>,
			);
		}
	});
	if (nodes.length === 0) return null;
	return (
		<span className="whitespace-pre-wrap break-words text-base leading-relaxed">
			{nodes}
		</span>
	);
}
