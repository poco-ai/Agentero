import { Languages, MinusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";

type TranslateCardProps = {
	screen: ScreenPoint;
	preferRight?: boolean;
	/** Translation text (may stream in) */
	result: string;
	streaming: boolean;
	error: string | null;
	/** Open Translate settings from an API failure state. */
	onOpenSettings: () => void;
	/** Hide card; pin remains for reopen */
	onHide: () => void;
	/** Delete persisted translate record + pin */
	onDelete: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/**
 * PDF selection translation — shared SelectionCard shell with hide/delete
 * (same persistence model as ask: hide keeps pin, delete removes record).
 */
export function TranslateCard({
	screen,
	preferRight = true,
	result,
	streaming,
	error,
	onOpenSettings,
	onHide,
	onDelete,
	onPointerEnter,
	onPointerLeave,
}: TranslateCardProps) {
	const { t } = useTranslation("viewer");
	const showResult = result.trim().length > 0;
	const showLoading = streaming && !showResult;

	return (
		<SelectionCard
			screen={screen}
			width={320}
			height={280}
			// Content-sized: follow the selection pin while the PDF scrolls.
			trackPin
			preferRight={preferRight}
			title={t("selection.translateTitle")}
			icon={Languages}
			ariaLive="polite"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			actions={[
				{
					label: t("selection.translateDelete"),
					onClick: onDelete,
					icon: <Trash2Icon className="size-3.5" />,
					destructive: true,
				},
				{
					label: t("selection.translateHide"),
					onClick: onHide,
					icon: <MinusIcon className="size-3.5" />,
				},
			]}
			bodyClassName="gap-2 px-3 py-2.5"
		>
			{showLoading ? (
				<Shimmer className="text-sm" as="p">
					{t("selection.translating")}
				</Shimmer>
			) : null}

			{showResult ? (
				<MessageResponse className="min-w-0 whitespace-pre-wrap break-words text-[13px] text-foreground leading-relaxed">
					{result}
				</MessageResponse>
			) : null}

			{!showLoading && !showResult && !error ? (
				<p className="text-muted-foreground text-xs">
					{t("selection.translating")}
				</p>
			) : null}

			{error ? (
				<div className="flex flex-col items-start gap-2">
					<p className="text-destructive text-xs" role="alert">
						{error}
					</p>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="h-7 gap-1.5 px-2 text-xs"
						onClick={onOpenSettings}
					>
						<Settings2Icon className="size-3.5" />
						{t("selection.translateOpenSettings")}
					</Button>
				</div>
			) : null}
		</SelectionCard>
	);
}
