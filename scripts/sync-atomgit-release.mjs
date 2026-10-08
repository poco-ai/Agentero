#!/usr/bin/env node
// Node 24 + gh; no project dependencies required. See docs/test/release.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const encode = encodeURIComponent;

export class HttpError extends Error {
	constructor(label, status) {
		// Never print signed upload URLs, response bodies or credentials.
		super(`${label}: HTTP ${status}`);
		this.status = status;
	}
}

export async function retry(operation, pause = sleep) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (
				attempt === 2 ||
				(error instanceof HttpError &&
					error.status < 500 &&
					![408, 429].includes(error.status))
			) {
				throw error;
			}
			console.warn(
				`Retry ${attempt + 1}/2 after ${error instanceof HttpError ? error.message : error.name}`,
			);
			await pause(2000 * 2 ** attempt);
		}
	}
}

export async function digest(stream) {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		hash.update(chunk);
	}
	return { size, sha256: hash.digest("hex") };
}

// A fixed total transfer timeout kills large assets: GitHub runners push the
// ~120 MB AppImage to AtomGit at roughly 100 KB/s, so a 10-minute cap can never
// finish it (#694). Abort only when no bytes move for this long instead; the
// job-level timeout still bounds the overall run.
const TRANSFER_STALL_TIMEOUT = 300_000;

class StallError extends Error {
	constructor() {
		super("AtomGit transfer stalled");
		this.name = "StallError";
	}
}

export function stallWatchdog(timeout = TRANSFER_STALL_TIMEOUT) {
	const controller = new AbortController();
	let timer;
	const progress = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new StallError()), timeout);
	};
	progress();
	return {
		signal: controller.signal,
		progress,
		stop: () => clearTimeout(timer),
	};
}

async function* trackProgress(source, progress) {
	for await (const chunk of source) {
		progress();
		yield chunk;
	}
}

export function selectRelease(releases, tag) {
	// The GitHub "get release by tag name" endpoint returns published releases
	// only. While the build jobs upload assets the release is still a draft, so
	// it can only be resolved from the releases list (which includes drafts for
	// tokens with push access).
	const release = releases.find((item) => item.tag_name === tag);
	if (!release) throw new Error(`GitHub Release not found: ${tag}`);
	return release;
}

export function validateAssets(assets) {
	if (!assets.length) throw new Error("GitHub Release has no uploaded assets");
	const names = new Set();
	for (const asset of assets) {
		if (
			!asset.name ||
			/[\\/]/.test(asset.name) ||
			Array.from(asset.name).some(
				(character) => character.charCodeAt(0) < 32,
			) ||
			[".", ".."].includes(asset.name) ||
			names.has(asset.name) ||
			!Number.isSafeInteger(asset.id) ||
			!Number.isSafeInteger(asset.size) ||
			asset.size < 0 ||
			asset.state !== "uploaded"
		) {
			throw new Error("Invalid, duplicate or incomplete GitHub Release asset");
		}
		names.add(asset.name);
	}
}

export class AtomGit {
	constructor(repository, token, request = fetch) {
		this.base = `https://api.atomgit.com/api/v5/repos/${repository.split("/").map(encode).join("/")}`;
		this.token = token;
		this.request = request;
	}

	async api(path, method = "GET", body) {
		const response = await this.request(`${this.base}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw new HttpError(`AtomGit ${method}`, response.status);
		return response.status === 204 ? null : response.json();
	}

	async findRelease(tag) {
		// Listing avoids treating AtomGit's ambiguous 400/404 responses as an
		// absent release (they can also mean a bad repository or denied access).
		for (let page = 1; ; page++) {
			const releases = await retry(() =>
				this.api(`/releases?per_page=100&page=${page}`),
			);
			if (!Array.isArray(releases))
				throw new Error("Invalid AtomGit releases list");
			const found = releases.find((release) => release.tag_name === tag);
			if (found) return found;
			if (!releases.length) return null;
		}
	}

	async release(tag) {
		return retry(() => this.api(`/releases/tags/${encode(tag)}`));
	}

	async remoteDigest(tag, name, registering = false) {
		console.log(`Checking AtomGit bytes: ${name}`);
		return retry(async () => {
			const watchdog = stallWatchdog();
			try {
				const response = await this.request(
					`${this.base}/releases/${encode(tag)}/attach_files/${encode(name)}/download`,
					{
						headers: { Authorization: `Bearer ${this.token}` },
						signal: watchdog.signal,
					},
				);
				if (registering && [400, 404].includes(response.status)) {
					throw new Error("AtomGit attachment is not downloadable yet");
				}
				if (!response.ok)
					throw new HttpError("AtomGit download", response.status);
				return await digest(trackProgress(response.body, watchdog.progress));
			} finally {
				watchdog.stop();
			}
		});
	}

	async upload(tag, asset, file, expected) {
		// Reconcile before each attempt: an upload may have succeeded even if
		// its HTTP response was lost. Never blindly create duplicate attachments.
		await retry(async () => {
			const release = await this.release(tag);
			const existing = release.assets.filter(
				(item) => item.name === asset.name,
			);
			if (existing.length === 1) {
				const actual = await this.remoteDigest(tag, asset.name);
				if (
					actual.size === expected.size &&
					actual.sha256 === expected.sha256
				) {
					console.log(`Verified: ${asset.name}`);
					return;
				}
			}
			for (const item of existing) {
				if (item.id == null) throw new Error("AtomGit attachment has no id");
				await this.api(
					`/releases/${encode(tag)}/attach_files/${encode(item.id)}`,
					"DELETE",
				);
			}
			const info = await this.api(
				`/releases/${encode(tag)}/upload_url?file_name=${encode(asset.name)}`,
			);
			if (new URL(info.url).protocol !== "https:" || !info.headers) {
				throw new Error("Invalid AtomGit upload response");
			}
			const stream = createReadStream(file);
			console.log(`Uploading: ${asset.name} (${expected.size} bytes)`);
			const watchdog = stallWatchdog();
			try {
				const response = await this.request(info.url, {
					method: "PUT",
					// Only OBS-provided headers go to the signed URL, never our PAT.
					headers: { "Content-Length": String(expected.size), ...info.headers },
					body: trackProgress(stream, watchdog.progress),
					duplex: "half",
					redirect: "error",
					signal: watchdog.signal,
				});
				await response.body?.cancel();
				if (!response.ok)
					throw new HttpError("AtomGit upload", response.status);
			} finally {
				watchdog.stop();
				stream.destroy();
			}
			// Upload success is not sufficient: verify registered, downloadable bytes.
			const actual = await this.remoteDigest(tag, asset.name, true);
			if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
				throw new Error(
					`AtomGit attachment verification failed: ${asset.name}`,
				);
			}
			console.log(`Uploaded and verified: ${asset.name}`);
		});
	}
}

/**
 * Gate a release on the tag already existing on AtomGit.
 *
 * AtomGit's repository mirror can lag GitHub, and unlike GitHub it does not
 * create the tag from `target_commitish`: `POST /releases` answers an opaque
 * HTTP 400 while the tag is absent. Poll the mirrored tag with a bounded
 * backoff so a short lag self-heals, then fail with an actionable message
 * instead of that 400, and reject a tag whose commit disagrees with GitHub.
 */
export async function waitForTag(
	atomgit,
	tag,
	commit,
	{ attempts = 5, pauseMs = 10_000, pause = sleep } = {},
) {
	for (let attempt = 0; ; attempt++) {
		let target;
		try {
			// 5xx/408/429 retry inside `retry`; a 404 means "not mirrored yet".
			target = await retry(() => atomgit.api(`/commits/${encode(tag)}`));
		} catch (error) {
			if (error?.status !== 404) throw error;
			if (attempt >= attempts - 1) {
				throw new Error(
					`AtomGit has not mirrored tag ${tag}; fix the repository mirror, then rerun the sync`,
				);
			}
			await pause(pauseMs * 2 ** attempt);
			continue;
		}
		if (target.sha !== commit) {
			throw new Error(
				"AtomGit tag does not match the GitHub commit; sync repository tags first",
			);
		}
		return;
	}
}

export async function syncRelease({
	atomgit,
	release,
	assets,
	commit,
	latestTag,
	download,
	waitForTag: waitForMirroredTag = waitForTag,
}) {
	validateAssets(assets);
	const tag = release.tag_name;
	const metadata = { name: release.name || tag, body: release.body || "" };
	// Gate on the mirrored tag before creating the release: while the mirror is
	// behind, AtomGit rejects `POST /releases` with HTTP 400 and never tells us
	// why. Waiting here turns that into a clear, actionable failure.
	await waitForMirroredTag(atomgit, tag, commit);
	const existing = await atomgit.findRelease(tag);
	if (!existing) {
		// target_commitish must be the exact GitHub tag commit, never default main.
		await atomgit.api("/releases", "POST", {
			...metadata,
			tag_name: tag,
			target_commitish: commit,
			release_status: "pre",
		});
	}
	for (const asset of assets) {
		const { file, expected, cleanup } = await download(asset);
		try {
			await atomgit.upload(tag, asset, file, expected);
		} finally {
			await cleanup();
		}
	}
	const mirrored = await atomgit.release(tag);
	for (const asset of assets) {
		if (
			mirrored.assets.filter((item) => item.name === asset.name).length !== 1
		) {
			throw new Error(
				`AtomGit attachment missing or duplicated: ${asset.name}`,
			);
		}
	}
	// A backfill of an older stable tag must never replace the current latest.
	if (release.draft || release.prerelease) metadata.release_status = "pre";
	else if (tag === latestTag) metadata.release_status = "latest";
	await atomgit.api(`/releases/${encode(tag)}`, "PATCH", metadata);
	console.log(`Synced ${tag}: ${assets.length} assets and release notes`);
}

function gh(path, options = {}) {
	return execFileSync("gh", ["api", path, ...(options.args || [])], {
		encoding: "utf8",
		timeout: 600_000,
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
}

async function main() {
	const { ATOMGIT_TOKEN, RELEASE_TAG, GITHUB_REPOSITORY, ATOMGIT_REPOSITORY } =
		process.env;
	if (!ATOMGIT_TOKEN || !RELEASE_TAG || !GITHUB_REPOSITORY) {
		throw new Error("Set ATOMGIT_TOKEN, RELEASE_TAG and GITHUB_REPOSITORY");
	}
	const destination = ATOMGIT_REPOSITORY || "poco-ai/Agentero";
	if (!/^[\w.-]+\/[\w.-]+$/.test(destination))
		throw new Error("Invalid ATOMGIT_REPOSITORY");
	const repo = `repos/${GITHUB_REPOSITORY}`;
	// Resolve from the list endpoint: the release is still a draft while the
	// build jobs upload assets, and the tag endpoint only returns published
	// releases. Listing drafts requires push access, so the workflow tasks run
	// with `contents: write`.
	const releases = JSON.parse(
		gh(`${repo}/releases?per_page=100`, {
			args: ["--paginate", "--slurp"],
		}),
	).flat();
	const release = selectRelease(releases, RELEASE_TAG);
	const assets = JSON.parse(
		gh(`${repo}/releases/${release.id}/assets?per_page=100`, {
			args: ["--paginate", "--slurp"],
		}),
	).flat();
	const commit = JSON.parse(gh(`${repo}/commits/${encode(RELEASE_TAG)}`)).sha;
	const hasStableRelease = releases.some(
		(item) => !item.draft && !item.prerelease,
	);
	const latestTag = hasStableRelease
		? JSON.parse(gh(`${repo}/releases/latest`)).tag_name
		: null;
	const directory = await mkdtemp(join(tmpdir(), "agentero-atomgit-"));
	try {
		await syncRelease({
			atomgit: new AtomGit(destination, ATOMGIT_TOKEN),
			release,
			assets,
			commit,
			latestTag,
			download: async (asset) => {
				console.log(
					`Downloading from GitHub: ${asset.name} (${asset.size} bytes)`,
				);
				const file = join(directory, asset.name);
				await retry(async () => {
					const output = await open(file, "w");
					try {
						gh(`${repo}/releases/assets/${asset.id}`, {
							args: ["-H", "Accept: application/octet-stream"],
							stdio: ["ignore", output.fd, "pipe"],
						});
					} finally {
						await output.close();
					}
					if ((await stat(file)).size !== asset.size)
						throw new Error("GitHub asset size mismatch");
				});
				const expected = await digest(createReadStream(file));
				if (asset.digest && asset.digest !== `sha256:${expected.sha256}`) {
					throw new Error(`GitHub asset checksum mismatch: ${asset.name}`);
				}
				return { file, expected, cleanup: () => rm(file) };
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(`AtomGit sync failed: ${error.message}`);
		process.exitCode = 1;
	});
}
