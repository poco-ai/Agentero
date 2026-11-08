/**
 * Sent-message view of composer @ / $ / / chips.
 * The ACP body is plain text; this redraws the chips from the stored draft.
 */
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import {
	commandInvocationLabel,
	commandPrefix,
	displaySkillName,
	mentionChipLabel,
	parseInlineTokenParts,
} from "@/lib/agent/composer-inline-tokens";
import { isPlazaMentionPath } from "@/lib/agent/plaza-mention";
import { cn } from "@/lib/core/utils";

const CHIP_CLASS =
	"mx-0.5 inline-flex max-w-[12rem] min-w-0 shrink-0 items-center gap-0.5 rounded-md border border-border/80 bg-muted/40 px-1 align-middle text-[0.8125em] leading-[1.25] text-foreground";

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
			<span data-composer-chip="true" className={CHIP_CLASS} title={title}>
				{prefix}
				<span className="min-w-0 truncate">{label}</span>
			</span>
		);
	}
	return (
		<button
			type="button"
			data-composer-chip="true"
			className={cn(CHIP_CLASS, "cursor-pointer hover:bg-muted")}
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
	chipsOnly = false,
}: {
	markup: string;
	onOpenPath?: (path: string) => void;
	/** Edit box: chips only, the textarea holds the prose. */
	chipsOnly?: boolean;
}) {
	const parts = parseInlineTokenParts(markup);
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
		}
	});
	if (nodes.length === 0) return null;
	return (
		<span className="whitespace-pre-wrap break-words text-base leading-relaxed">
			{nodes}
		</span>
	);
}
