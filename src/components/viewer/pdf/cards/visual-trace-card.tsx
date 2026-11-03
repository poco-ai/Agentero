import { MessagesSquare, MinusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/agent/message";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import { tracePreview } from "@/lib/pdf/agent-trace";
import { traceMessages } from "@/lib/pdf/agent-trace/schema";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace/types";

type VisualTraceCardProps = {
	trace: PdfVisualSessionTrace;
	screen: ScreenPoint;
	preferRight?: boolean;
	onHide: () => void;
	onDelete: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/**
 * Floating conversation card for a visual mark that carries an Agent thread but
 * no user comment. Displays the stored transcript next to the gutter pin so the
 * dialogue is visible without cluttering the right-rail comment column.
 */
export function VisualTraceCard({
	trace,
	screen,
	preferRight = true,
	onHide,
	onDelete,
	onPointerEnter,
	onPointerLeave,
}: VisualTraceCardProps) {
	const { t } = useTranslation("viewer");
	const title = tracePreview(trace, t("pdfExplain.visualAnnotation"));
	const messages = useMemo(() => traceMessages(trace), [trace]);

	return (
		<SelectionCard
			screen={screen}
			width={320}
			height={360}
			lockHeight
			preferRight={preferRight}
			title={title}
			icon={MessagesSquare}
			ariaLabel={t("pdfExplain.traceCardTitle")}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			bodyClassName="min-h-0 overflow-hidden p-0"
			actions={[
				{
					label: t("pdfExplain.traceDelete"),
					onClick: onDelete,
					icon: <Trash2Icon className="size-3.5" />,
					destructive: true,
				},
				{
					label: t("pdfExplain.traceHide"),
					onClick: onHide,
					icon: <MinusIcon className="size-3.5" />,
				},
			]}
		>
			<div
				className={cn(
					"agentero-scroll h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
					"[scrollbar-gutter:stable]",
				)}
				role="log"
			>
				<div className="flex flex-col gap-3 px-3 py-2.5">
					{messages.length === 0 ? (
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("pdfExplain.traceEmptyMessages")}
						</p>
					) : (
						messages.map((m) => {
							const from =
								m.role === "user" ? ("user" as const) : ("assistant" as const);
							const bodyText = m.content.trim();
							if (from === "user" && !bodyText) return null;
							return (
								<Message
									key={m.id}
									id={`pdf-visual-msg-${m.id}`}
									from={from}
									className="max-w-full"
								>
									<MessageContent
										className={cn(
											"text-sm",
											from === "user" && "px-3 py-2",
											from === "assistant" && "w-full max-w-full",
										)}
									>
										{bodyText ? (
											from === "assistant" ? (
												<MessageResponse>{bodyText}</MessageResponse>
											) : (
												<span className="whitespace-pre-wrap break-words">
													{bodyText}
												</span>
											)
										) : null}
									</MessageContent>
								</Message>
							);
						})
					)}
					{trace.agent?.status === "failed" && trace.agent.error ? (
						<p
							className="text-destructive text-xs leading-relaxed"
							role="alert"
						>
							{trace.agent.error}
						</p>
					) : null}
				</div>
			</div>
		</SelectionCard>
	);
}
