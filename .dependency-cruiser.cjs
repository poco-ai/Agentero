/**
 * Dependency layering rules (run: pnpm deps:check).
 * Guards the src/lib domain architecture:
 *   core = leaf utilities; ui = presentation tokens; lib never imports components.
 */
module.exports = {
	forbidden: [
		{
			name: "ai-primitives-stay-generic",
			comment: "Upstream AI primitives must remain independently upgradeable.",
			severity: "error",
			from: {
				path: "^src/components/ui/(message|bubble|code-block|attachment|trace|marker|message-scroller|questionnaire)\\.tsx$",
			},
			to: {
				path: "^src/(components/(?!ui/)|lib/(agent|paper|pdf|vault|wiki|workspace|settings|translate)|hooks/use-app-stores)",
			},
		},
		{
			name: "no-circular",
			comment: "Module cycles make init order fragile (see lib barrel cycles).",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			name: "core-stays-leaf",
			comment: "lib/core must not depend on domain packages or components.",
			severity: "error",
			from: { path: "^src/lib/core" },
			to: {
				path: "^src/(components|lib/(paper|pdf|vault|wiki|workspace|agent|shell|markdown|settings|translate|ui))",
			},
		},
		{
			name: "lib-no-components",
			comment: "Business logic must not reach into React components.",
			severity: "error",
			from: { path: "^src/lib" },
			to: { path: "^src/components" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		exclude: { path: "\\.(test|spec)\\.tsx?$" },
	},
};
