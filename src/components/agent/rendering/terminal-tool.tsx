import { TerminalIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import type { ToolUiState } from "@/lib/agent/chat-state";
import type { TerminalToolData } from "@/lib/agent/terminal-tool";
import { cn } from "@/lib/core/utils";

/** Terminal pattern composed from upstream primitives; ACP remains in business code. */
export function TerminalTool({
	data,
	tool,
	open,
	onOpenChange,
	compact,
}: {
	data: TerminalToolData;
	tool: ToolUiState;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	compact: boolean;
}) {
	const { t } = useTranslation("aiElements");
	const failed =
		tool.status === "failed" ||
		(data.exitCode !== undefined && data.exitCode !== 0);
	const running = tool.status === "pending" || tool.status === "in_progress";
	const status = failed ? "error" : running ? "running" : undefined;
	const receivedOutput = useRef(false);
	useEffect(() => {
		if (!running || !data.output || receivedOutput.current) return;
		receivedOutput.current = true;
		// Persist the initial reveal in lifted state across completion and
		// virtual row remounts, while respecting a previously closed row.
		if (open) onOpenChange(true);
	}, [running, data.output, open, onOpenChange]);
	return (
		<Trace className={cn("not-prose", !compact && "mb-1.5")}>
			<TraceCollapsible open={open} onOpenChange={onOpenChange}>
				<TraceCollapsibleTrigger
					className={compact ? "px-2 py-1.5" : undefined}
				>
					<TraceLine status={status}>
						<TraceIcon>
							<TerminalIcon />
						</TraceIcon>
						<TraceTitle className="font-mono text-xs">
							{data.command}
						</TraceTitle>
						<span className="sr-only">
							{t(
								failed
									? "tool.status.error"
									: running
										? "tool.status.running"
										: "tool.status.completed",
							)}
						</span>
						{data.exitCode !== undefined ? (
							<span className="font-mono text-xs">
								{t("tool.exitCode", { code: data.exitCode })}
							</span>
						) : null}
					</TraceLine>
				</TraceCollapsibleTrigger>
				<TraceCollapsibleContent className={compact ? "px-2 py-2" : undefined}>
					{data.cwd ? (
						<p className="break-all font-mono text-muted-foreground text-xs">
							{data.cwd}
						</p>
					) : null}
					<CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
						<CodeBlockContent wrap className="max-h-64">
							{data.output}
						</CodeBlockContent>
					</CodeBlock>
					{data.metadata ? (
						<CodeBlock size="sm">
							<CodeBlockContent wrap className="max-h-32">
								{JSON.stringify(data.metadata, null, 2)}
							</CodeBlockContent>
						</CodeBlock>
					) : null}
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</Trace>
	);
}
