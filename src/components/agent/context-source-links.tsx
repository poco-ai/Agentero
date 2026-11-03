/**
 * Citation URIs returned by the context tools. The same strings the agent is
 * asked to cite, opened through the existing paper jump.
 */
import { FilesIcon, FileTextIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import { openCitation } from "@/lib/workspace/actions";

function sourceLabel(source: string): string {
	const trimmed = source.trim();
	const hash = trimmed.lastIndexOf("#");
	const path = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
	const fragment = hash >= 0 ? trimmed.slice(hash) : "";
	const name = path.split("/").filter(Boolean).pop() || path;
	return `${name}${fragment}`;
}

export function ContextSourceLinks({ sources }: { sources: string[] }) {
	const { t } = useTranslation("aiElements");
	const unique = [
		...new Set(sources.map((source) => source.trim()).filter(Boolean)),
	];
	if (!unique.length) return null;
	return (
		<Trace>
			<TraceCollapsible>
				<TraceCollapsibleTrigger>
					<TraceLine>
						<TraceIcon>
							<FilesIcon />
						</TraceIcon>
						<TraceTitle>
							{t("sources.count", { count: unique.length })}
						</TraceTitle>
					</TraceLine>
				</TraceCollapsibleTrigger>
				<TraceCollapsibleContent>
					<Trace>
						{unique.map((source) => (
							<Button
								key={source}
								type="button"
								variant="ghost"
								size="xs"
								className="h-auto max-w-full justify-start whitespace-normal py-1"
								title={source}
								aria-label={source}
								onClick={() => openCitation(source)}
							>
								<TraceLine>
									<TraceIcon>
										<FileTextIcon />
									</TraceIcon>
									<TraceTitle>{sourceLabel(source)}</TraceTitle>
								</TraceLine>
							</Button>
						))}
					</Trace>
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</Trace>
	);
}
