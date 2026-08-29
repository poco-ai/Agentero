export {
	type AliasRepairCandidate,
	type DoctorIssue,
	type DoctorReport,
	doctorApplyAliases,
	doctorApplyVisualMarks,
	doctorApplyWikilinks,
	doctorCheck,
	doctorFixCatalogDuplicates,
	doctorIgnoreAliases,
	doctorPlanWikilinks,
	doctorSetDirtyPaths,
	type VisualMarkCandidate,
	type WikiCheckIssue,
	type WikilinkRepairResidual,
	type WikilinkRepairSuggestion,
} from "@/lib/doctor/api";
export { buildDoctorWikilinkAgentPrompt } from "@/lib/doctor/wikilink-prompt";
