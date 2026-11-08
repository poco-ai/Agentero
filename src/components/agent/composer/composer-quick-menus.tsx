import { Sparkles } from "lucide-react";
import { cleanSkillDisplayName } from "@/components/agent/composer/composer-inline-dom";
import { COMPOSER_MENU_SURFACE } from "@/components/agent/composer/composer-menu-surface";
import { PopoverContent } from "@/components/ui/popover";
import type { AgentSkill } from "@/lib/agent";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import { cn } from "@/lib/core/utils";

/** Both menus must render inside the composer `Popover` subtree — `PopoverContent` needs its context. */
export function ComposerSkillMenu({
	skillOptions,
	skillActiveIndex,
	onAttachSkill,
	onSkillActiveIndexChange,
}: {
	skillOptions: AgentSkill[];
	skillActiveIndex: number;
	onAttachSkill: (skill: AgentSkill) => void;
	onSkillActiveIndexChange: (index: number) => void;
}) {
	return (
		<PopoverContent
			id="agent-skill-menu"
			role="listbox"
			side="top"
			align="start"
			sideOffset={8}
			onOpenAutoFocus={(event) => event.preventDefault()}
			className={COMPOSER_MENU_SURFACE}
		>
			{skillOptions.map((skill, index) => (
				<button
					key={skill.id}
					id={`agent-skill-option-${index}`}
					type="button"
					role="option"
					aria-selected={skillActiveIndex === index}
					className={cn(
						"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none",
						skillActiveIndex === index ? "bg-muted" : "hover:bg-muted/70",
					)}
					onMouseEnter={() => onSkillActiveIndexChange(index)}
					onClick={() => onAttachSkill(skill)}
				>
					<Sparkles
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="min-w-0 flex-1 truncate">
						{cleanSkillDisplayName(skill.name)}
					</span>
					{skill.description ? (
						<span className="max-w-40 truncate text-muted-foreground text-xs">
							{skill.description}
						</span>
					) : null}
				</button>
			))}
		</PopoverContent>
	);
}

export function ComposerSlashMenu({
	slashOptions,
	slashActiveIndex,
	onAttachSlashCommand,
	onSlashActiveIndexChange,
}: {
	slashOptions: AcpCommand[];
	slashActiveIndex: number;
	onAttachSlashCommand: (command: AcpCommand) => void;
	onSlashActiveIndexChange: (index: number) => void;
}) {
	return (
		<PopoverContent
			id="agent-slash-menu"
			role="listbox"
			side="top"
			align="start"
			sideOffset={8}
			onOpenAutoFocus={(event) => event.preventDefault()}
			className={COMPOSER_MENU_SURFACE}
		>
			{slashOptions.map((command, index) => {
				const isSkill = command.kind === "skill";
				return (
					<button
						key={command.id}
						id={`agent-slash-option-${index}`}
						type="button"
						role="option"
						aria-selected={slashActiveIndex === index}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none",
							slashActiveIndex === index ? "bg-muted" : "hover:bg-muted/70",
						)}
						onMouseEnter={() => onSlashActiveIndexChange(index)}
						onClick={() => onAttachSlashCommand(command)}
					>
						{isSkill ? (
							<Sparkles
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
						) : (
							<span className="shrink-0 font-mono text-muted-foreground">
								{command.prefix}
							</span>
						)}
						<span className="flex min-w-0 flex-1 items-center truncate">
							<span className="shrink-0 whitespace-nowrap">
								{isSkill ? cleanSkillDisplayName(command.title) : command.title}
							</span>
						</span>
						{command.description ? (
							<span className="min-w-0 max-w-40 flex-1 truncate text-muted-foreground text-xs">
								{command.description}
							</span>
						) : null}
					</button>
				);
			})}
		</PopoverContent>
	);
}
