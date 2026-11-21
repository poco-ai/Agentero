/**
 * Plaza source icon map — the components-layer half of the plaza registry.
 * `lib/plaza/sources.ts` only carries icon names ({@link PlazaSourceIcon});
 * this module resolves them to renderable components so lib stays free of
 * React/component imports.
 */

import {
	CalendarClock,
	Landmark,
	Rss,
	Sparkles,
	Telescope,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { SiHuggingface } from "react-icons/si";
import { CoolPapersIcon } from "@/components/icons/cool-papers-icon";
import { ModelScopeIcon } from "@/components/icons/modelscope-icon";
import type { PlazaSourceIcon } from "@/lib/plaza";

export const PLAZA_SOURCE_ICONS: Record<
	PlazaSourceIcon,
	ComponentType<SVGProps<SVGSVGElement>>
> = {
	coolPapers: CoolPapersIcon,
	modelScope: ModelScopeIcon,
	huggingFace: SiHuggingface,
	conference: Landmark,
	sparkles: Sparkles,
	rss: Rss,
	telescope: Telescope,
	calendarClock: CalendarClock,
};
