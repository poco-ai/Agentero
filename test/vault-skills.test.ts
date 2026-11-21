import { describe, expect, it } from "vitest";
import { seededSkillIdsFromCreated } from "@/lib/vault";

describe("seededSkillIdsFromCreated", () => {
	it("extracts unique skill package ids from created paths", () => {
		const ids = seededSkillIdsFromCreated([
			"papers/",
			".agents/skills/README.md",
			".agents/skills/agentero-cli/SKILL.md",
			".agents/skills/deep-research/SKILL.md",
			".agents/skills/deep-research/LICENSE",
			".agents/skills/deep-research/references/quality-gates.md",
			".agents/skills/idea-evaluator/SKILL.md",
			".agents/skills/paper-reader/SKILL.md",
			".agents/skills/paper-reader/author-lookup.md",
			".agents/skills/research-paper-writing/references/method.md",
		]);
		expect(ids).toEqual([
			"agentero-cli",
			"deep-research",
			"idea-evaluator",
			"paper-reader",
			"research-paper-writing",
		]);
	});

	it("returns empty when no skill packages were created", () => {
		expect(
			seededSkillIdsFromCreated([
				"AGENTS.md",
				".agents/README.md",
				".agents/skills/README.md",
			]),
		).toEqual([]);
	});

	it("normalizes backslashes", () => {
		expect(
			seededSkillIdsFromCreated([".agents\\skills\\agentero-cli\\SKILL.md"]),
		).toEqual(["agentero-cli"]);
	});
});
