/**
 * Preview of the annotation text stored on a sent user message.
 * The quote is the send-time snapshot, rendered as plain text.
 */
import { ScanSearch, TextQuote } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AnnotationSnapshot } from "@/lib/agent/annotation-snapshot";

export function AnnotationSnapshotCards({
	snapshots,
}: {
	snapshots: readonly AnnotationSnapshot[];
}) {
	const { t } = useTranslation("agent");
	if (snapshots.length === 0) return null;
	return (
		<div className="flex w-full min-w-0 flex-col gap-1.5">
			{snapshots.map((snapshot) => {
				const Icon = snapshot.kind === "visual" ? ScanSearch : TextQuote;
				const bare =
					snapshot.kind === "visual" &&
					!snapshot.quote &&
					!snapshot.comment &&
					!snapshot.page;
				return (
					<article
						key={snapshot.n}
						data-annotation-snapshot={snapshot.n}
						className="w-full rounded-lg border border-border/80 bg-background/80 px-3 py-2 text-sm"
					>
						<div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
							<Icon className="size-3.5 shrink-0" aria-hidden />
							<span className="font-medium">
								{t("transcript.annotationLabel", { n: snapshot.n })}
							</span>
							{snapshot.page ? (
								<span>
									{"· "}
									{t("composer.visualAnnotationPage", {
										page: snapshot.page,
									})}
								</span>
							) : null}
						</div>
						{snapshot.source ? (
							<p
								className="mt-1 truncate text-muted-foreground text-xs"
								title={snapshot.source}
							>
								{snapshot.source}
							</p>
						) : null}
						{snapshot.quote ? (
							<blockquote className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-border border-l-2 pl-2 text-foreground">
								{snapshot.quote}
							</blockquote>
						) : null}
						{snapshot.translation ? (
							<p className="mt-1.5 whitespace-pre-wrap break-words text-muted-foreground text-xs">
								<span className="font-medium">
									{t("transcript.annotationTranslation")}
								</span>
								{": "}
								{snapshot.translation}
							</p>
						) : null}
						{snapshot.comment ? (
							<p className="mt-1.5 whitespace-pre-wrap break-words text-foreground/90">
								{snapshot.comment}
							</p>
						) : null}
						{bare ? (
							<p className="mt-1 text-muted-foreground text-xs">
								{t("transcript.annotationVisual")}
							</p>
						) : null}
					</article>
				);
			})}
		</div>
	);
}
