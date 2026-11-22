import { readFileSync } from "node:fs";

const source = new URL("../src/lib/update/changelog.json", import.meta.url);
const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const headingAndList = /^### \S[^\r\n]*\r?\n(?:[\t ]*\r?\n)*- \S/m;

function validate(tag) {
	if (!stableTag.test(tag ?? "")) throw new Error("Pass a stable tag (vX.Y.Z)");
	const bytes = readFileSync(source);
	if (bytes.length > 1024 * 1024)
		throw new Error("changelog.json exceeds 1 MiB");
	const history = JSON.parse(bytes);
	if (history?.schemaVersion !== 1 || !Array.isArray(history.releases)) {
		throw new Error("Invalid changelog.json schema");
	}
	if (history.releases[0]?.tag !== tag) {
		throw new Error(`The first changelog entry must be ${tag}`);
	}
	let previous;
	for (const release of history.releases) {
		if (!stableTag.test(release?.tag ?? "")) {
			throw new Error(`Invalid stable release tag: ${release?.tag}`);
		}
		if (previous?.localeCompare(release.tag, "en", { numeric: true }) <= 0) {
			throw new Error(
				`Changelog must be in descending version order without duplicates: ${release.tag}`,
			);
		}
		previous = release.tag;
		const { releaseDate } = release;
		const date = new Date(`${releaseDate}T00:00:00Z`);
		if (
			!dateOnly.test(releaseDate ?? "") ||
			!Number.isFinite(date.getTime()) ||
			date.toISOString().slice(0, 10) !== releaseDate
		) {
			throw new Error(`Invalid releaseDate for ${release.tag}; use YYYY-MM-DD`);
		}
		if (release.tag !== tag && release.summary == null) continue;
		for (const language of ["zh-CN", "en"]) {
			const markdown = release.summary?.[language];
			if (typeof markdown !== "string" || !headingAndList.test(markdown)) {
				throw new Error(
					`${release.tag} needs a ${language} summary with a level-three Markdown heading and bullet list`,
				);
			}
		}
	}
}

try {
	const tag = process.argv[2];
	validate(tag);
	console.log(`Validated changelog.json for ${tag}`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
