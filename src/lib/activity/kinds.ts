/** Stable activity kinds. Host accepts `[a-z0-9._-]{1,64}`. */

export const ACTIVITY_KINDS = [
	"app.started",
	"app.exited",
	"paper.open",
	"note.open",
	"paper.focus",
	"paper.blur",
	"paper.session",
	"asset.download",
	"paper.import",
	"search.query",
	"agent.run",
	"agent.usage",
	"activity.view",
	"translate.selection",
	"translate.layout",
	"layout.analyze",
	"skill.install",
	"mark.create",
	"mark.update",
	"mark.delete",
	"paper.tag",
	"paper.read",
	"paper.edit-meta",
	"refs.parse",
	"refs.import",
	"zotero.save",
	"vault.open",
	"onboarding.complete",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function isActivityKind(value: string): value is ActivityKind {
	return (ACTIVITY_KINDS as readonly string[]).includes(value);
}
