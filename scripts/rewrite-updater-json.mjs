#!/usr/bin/env node
// Node 24 + gh; no project dependencies required. See docs/test/release.md.
//
// tauri-action fills latest.json with api.github.com asset URLs. Anonymous API
// requests share a 60/hour per-IP quota (public repos included), so updater
// downloads fail with HTTP 403 behind shared NATs while the version check still
// succeeds. Rewrite the entries to the release CDN URLs; the embedded minisign
// signatures keep authenticating the payload.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_ASSET =
	/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/;

export function buildAssetNameMap(assets) {
	return new Map(
		assets.map((asset) => [asset.apiUrl.split("/").pop(), asset.name]),
	);
}

export function rewriteManifest(manifest, { repository, tag, idToName }) {
	const platforms = Object.entries(manifest.platforms ?? {});
	if (platforms.length === 0) throw new Error("latest.json has no platforms");
	const releaseBase = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;

	let rewritten = 0;
	let already = 0;
	for (const [platform, entry] of platforms) {
		const url = entry.url ?? "";
		const match = url.match(API_ASSET);
		const assetId =
			match &&
			`${match[1]}/${match[2]}`.toLowerCase() === repository.toLowerCase()
				? match[3]
				: null;
		if (!assetId) {
			// A rerun sees its own output; anything else means tauri-action changed
			// the manifest format and the rewrite would silently stop working.
			if (url.startsWith(`${releaseBase}/`)) {
				already++;
				continue;
			}
			throw new Error(`${platform}: unexpected url ${url}`);
		}
		const name = idToName.get(assetId);
		if (!name) {
			throw new Error(`${platform}: asset ${assetId} is not in release ${tag}`);
		}
		entry.url = `${releaseBase}/${encodeURIComponent(name)}`;
		rewritten++;
	}
	return { rewritten, already };
}

async function main() {
	const tag = process.env.TAG;
	const repository = process.env.REPOSITORY;
	if (!tag || !repository) throw new Error("TAG and REPOSITORY are required");
	const dryRun = process.env.DRY_RUN === "1";

	const gh = (args) =>
		execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		});
	const { assets } = JSON.parse(
		gh(["release", "view", tag, "--repo", repository, "--json", "assets"]),
	);

	const dir = await mkdtemp(join(tmpdir(), "agentero-updater-"));
	try {
		const manifestPath = join(dir, "latest.json");
		gh([
			"release",
			"download",
			tag,
			"--repo",
			repository,
			"--pattern",
			"latest.json",
			"--dir",
			dir,
			"--clobber",
		]);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const { rewritten, already } = rewriteManifest(manifest, {
			repository,
			tag,
			idToName: buildAssetNameMap(assets),
		});
		console.log(
			`rewrote ${rewritten} platform urls (${already} already rewritten)`,
		);
		if (dryRun) {
			console.log(JSON.stringify(manifest, null, 2));
			return;
		}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		gh([
			"release",
			"upload",
			tag,
			manifestPath,
			"--repo",
			repository,
			"--clobber",
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
