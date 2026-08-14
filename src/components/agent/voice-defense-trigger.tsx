import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { requestOpenViva } from "@/lib/voice-defense/open-request";

/** Title-bar / feature-window trigger. Desktop opens a singleton viva window. */
export function VoiceDefenseTrigger() {
	const { t } = useTranslation("agent");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("voiceDefense.open")}
					onClick={() => requestOpenViva()}
				>
					<Mic className="size-3.5" aria-hidden />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{t("voiceDefense.open")}</TooltipContent>
		</Tooltip>
	);
}
