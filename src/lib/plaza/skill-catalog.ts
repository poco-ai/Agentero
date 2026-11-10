/**
 * Curated research Skill repos for the 广场 → Skill 推荐 panel.
 *
 * Stars are static snapshots for display only. Clicking a card feeds
 * the GitHub URL into the existing 魔棒 Skill import (`lookupSubmit`).
 *
 * @see docs/frontend/paper-import.md
 * @see docs/backend/skill-import.md
 */

export type SkillThemeId =
	| "reading"
	| "writing"
	| "figures"
	| "ppt"
	| "reproduce"
	| "submit";

export type SkillRepo = {
	owner: string;
	repo: string;
	url: string;
	/** One-line pitch shown on the card. */
	description: string;
	/** GitHub stars snapshot for ranking/display. */
	stars: number;
};

export type SkillTheme = {
	id: SkillThemeId;
	repos: readonly SkillRepo[];
};

function github(
	owner: string,
	repo: string,
	stars: number,
	description: string,
): SkillRepo {
	return {
		owner,
		repo,
		url: `https://github.com/${owner}/${repo}`,
		stars,
		description,
	};
}

/** Research-lifecycle groups. No Zotero / literature-library packs. */
export const SKILL_THEMES: readonly SkillTheme[] = [
	{
		id: "reading",
		repos: [
			github(
				"WUBING2023",
				"PaperSpine",
				4805,
				"从高水平论文里拆动机、结构和写法，练阅读与选题。",
			),
			github(
				"Weizhena",
				"Deep-Research-skills",
				1948,
				"人在回路的深度调研：先过大纲再检索，适合精读一组文献。",
			),
			github(
				"zsyggg",
				"paper-craft-skills",
				1028,
				"论文精读、要点速览与讲解图，arXiv 链接触发。",
			),
		],
	},
	{
		id: "writing",
		repos: [
			github(
				"Imbad0202",
				"academic-research-skills",
				42400,
				"检索 → 写作 → 审稿 → 改稿的完整学术写作流水线。",
			),
			github(
				"Master-cai",
				"Research-Paper-Writing-Skills",
				6023,
				"ML / CV / NLP 论文段落级写法，改编自彭思达公开笔记。",
			),
			github(
				"zLanqing",
				"codex-claude-academic-skills",
				2872,
				"中文科研流：读文献报告、写作润色、科学计算与出图。",
			),
		],
	},
	{
		id: "figures",
		repos: [
			github(
				"Yuan1z0825",
				"nature-skills",
				35181,
				"Nature 文风与期刊级科研绘图。",
			),
			github(
				"LigphiDonk",
				"academic-figure-generator",
				2082,
				"根据论文内容生成学术配图，可在主流 Agent 里当 Skill 用。",
			),
		],
	},
	{
		id: "ppt",
		repos: [
			github(
				"hugohe3",
				"ppt-master",
				54639,
				"把文档、主题或模板生成原生 PowerPoint deck，支持图表和演讲稿。",
			),
			{
				owner: "Yuan1z0825",
				repo: "nature-paper2ppt",
				url: "https://github.com/Yuan1z0825/nature-skills/tree/main/skills/nature-paper2ppt",
				stars: 41600,
				description: "从科研论文生成中文 PPTX 文献汇报，适合组会和论文展示。",
			},
			github(
				"ningzimu",
				"codex-ppt-skill",
				5900,
				"面向 Codex 的图片式 PPT 生成 Skill，可从论文、笔记或提纲制作演示文稿。",
			),
		],
	},
	{
		id: "reproduce",
		repos: [
			github(
				"wanshuiyin",
				"Auto-claude-code-research-in-sleep",
				14654,
				"轻量 Markdown Skill，驱动 Agent 自动跑实验与复现。",
			),
			github(
				"Orchestra-Research",
				"AI-Research-SKILLs",
				11682,
				"从文献调研、实验到写论文的 AI 研究技能库。",
			),
			github(
				"fcakyon",
				"phd-skills",
				363,
				"论文复现、实验设计和审稿，面向 PhD 工作流。",
			),
		],
	},
	{
		id: "submit",
		repos: [
			github(
				"HKUSTDial",
				"Supervisor-Skills",
				5524,
				"从 Idea 到投稿的「AI 博导」技能包。",
			),
			github(
				"brycewang-stanford",
				"Awesome-Journal-Skills",
				984,
				"按期刊拆开的投稿技能（AER / QJE / Nature 等）。",
			),
			github(
				"Boom5426",
				"Nature-Paper-Skills",
				432,
				"Nature 风格稿件：核稿、投稿预检与审稿回复。",
			),
		],
	},
];
