import { Library } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import type { AgentTemplate } from "@/lib/agent";
import { cn } from "@/lib/core/utils";

export type MobileTab = "library" | "agent";

const TAB_GAP = "0.25rem";

export function MobileNav({
	tab,
	onTab,
	variant = "rail",
	agentTemplate,
}: {
	tab: MobileTab;
	onTab: (tab: MobileTab) => void;
	variant?: "rail" | "sidebar";
	agentTemplate?: AgentTemplate | string | null;
}) {
	const { t } = useTranslation("mobile");
	const sidebar = variant === "sidebar";
	const tabs: MobileTab[] = ["library", "agent"];
	const activeIndex = Math.max(0, tabs.indexOf(tab));

	return (
		<nav
			aria-label={t("tabs.navigation")}
			className={cn(
				"relative flex select-none gap-1",
				sidebar ? "flex-col" : "mt-10 flex-col",
			)}
		>
			{/* One highlight for the whole nav: it slides between tabs instead of
			    each row snapping its own background on and off. */}
			<span
				aria-hidden
				className="absolute inset-x-0 top-0 rounded-lg bg-muted/80 transition-transform duration-200 ease-out"
				style={{
					height: `calc((100% - ${tabs.length - 1} * ${TAB_GAP}) / ${tabs.length})`,
					transform: `translateY(calc(${activeIndex} * (100% + ${TAB_GAP})))`,
				}}
			/>
			<TabButton
				id="library"
				icon={Library}
				tab={tab}
				onTab={onTab}
				sidebar={sidebar}
			/>
			<TabButton
				id="agent"
				tab={tab}
				onTab={onTab}
				sidebar={sidebar}
				agentTemplate={agentTemplate}
			/>
		</nav>
	);
}

function TabButton({
	id,
	icon: Icon,
	tab,
	onTab,
	sidebar,
	agentTemplate,
}: {
	id: MobileTab;
	icon?: typeof Library;
	tab: MobileTab;
	onTab: (tab: MobileTab) => void;
	sidebar: boolean;
	agentTemplate?: AgentTemplate | string | null;
}) {
	const { t } = useTranslation("mobile");
	const active = tab === id;

	return (
		<button
			key={id}
			type="button"
			onClick={() => onTab(id)}
			className={cn(
				"relative flex items-center rounded-lg outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
				sidebar
					? "h-12 w-full gap-3 px-3 text-base"
					: "size-10 justify-center px-0",
				active
					? "font-medium text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
			aria-current={active ? "page" : undefined}
		>
			{id === "agent" ? (
				<AgentLogo
					template={agentTemplate}
					className="size-5"
					iconClassName="size-5"
					plain
				/>
			) : Icon ? (
				<Icon className="size-5 shrink-0" strokeWidth={active ? 2.25 : 2} />
			) : null}
			{sidebar ? <span>{t(`tabs.${id}`)}</span> : null}
		</button>
	);
}
