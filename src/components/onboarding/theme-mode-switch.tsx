import { Monitor, Moon, Sun } from "lucide-react";
import { motion } from "motion/react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import type { ThemePreference } from "@/lib/settings";

type ModeLabelKey = "theme.modeSystem" | "theme.modeLight" | "theme.modeDark";

const MODES: {
	value: ThemePreference;
	icon: typeof Monitor;
	labelKey: ModeLabelKey;
}[] = [
	{ value: "system", icon: Monitor, labelKey: "theme.modeSystem" },
	{ value: "light", icon: Sun, labelKey: "theme.modeLight" },
	{ value: "dark", icon: Moon, labelKey: "theme.modeDark" },
];

/** System / Light / Dark picker as a sliding icon segmented control. */
export function ThemeModeSwitch({
	value,
	onChange,
}: {
	value: ThemePreference;
	onChange: (next: ThemePreference) => void;
}) {
	const { t } = useTranslation("onboarding");
	const { setTheme } = useTheme();

	return (
		<div className="relative flex items-center rounded-lg border bg-muted p-0.5">
			{MODES.map(({ value: mode, icon: Icon, labelKey }) => {
				const selected = value === mode;
				return (
					<button
						key={mode}
						type="button"
						aria-pressed={selected}
						aria-label={t(labelKey)}
						title={t(labelKey)}
						onClick={() => {
							onChange(mode);
							setTheme(mode);
						}}
						className={cn(
							"relative z-10 flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
							selected
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{selected ? (
							<motion.span
								layoutId="theme-mode-indicator"
								className="absolute inset-0 rounded-md bg-background shadow-raised"
								transition={{ type: "spring", bounce: 0.2, duration: 0.3 }}
							/>
						) : null}
						<Icon className="relative size-4" />
					</button>
				);
			})}
		</div>
	);
}
