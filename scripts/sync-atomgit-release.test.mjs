import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	AtomGit,
	digest,
	retry,
	selectRelease,
	syncRelease,
} from "./sync-atomgit-release.mjs";

const asset = {
	id: 7,
	name: "installer + arm64.zip",
	size: 3,
	state: "uploaded",
};
const release = {
	tag_name: "v1.2.3",
	name: "Agentero 1.2.3",
	body: "中文\n\nEnglish",
};

function fixture(overrides = {}) {
	const calls = [];
	const atomgit = {
		findRelease: async () => null,
		api: async (path, method, body) => {
			calls.push({ path, method, body });
			return { sha: "commit" };
		},
		upload: async () => {},
		release: async () => ({ assets: [asset] }),
		...overrides,
	};
	return {
		calls,
		options: {
			atomgit,
			release,
			assets: [asset],
			commit: "commit",
			latestTag: release.tag_name,
			download: async () => ({
				file: "unused",
				expected: {},
				cleanup: async () => {},
			}),
		},
	};
}

test("stage as pre; publish latest only after all assets verify; preserve notes", async () => {
	const { options, calls } = fixture();
	await syncRelease(options);
	assert.equal(calls[0].body.release_status, "pre");
	assert.equal(calls[0].body.target_commitish, "commit");
	assert.equal(calls.at(-1).method, "PATCH");
	assert.equal(calls.at(-1).body.release_status, "latest");
	assert.equal(calls.at(-1).body.body, release.body);
});

test("drafts and prereleases stay pre; historical backfills never promote latest", async () => {
	for (const state of [{ draft: true }, { prerelease: true }, {}]) {
		const { options, calls } = fixture();
		options.release = { ...release, ...state };
		options.latestTag = "v9.0.0";
		await syncRelease(options);
		assert.equal(
			calls.at(-1).body.release_status,
			state.draft || state.prerelease ? "pre" : undefined,
		);
	}
});

test("failed upload cleans up and never promotes or claims success", async () => {
	let cleaned = false;
	const { options, calls } = fixture({
		upload: async () => {
			throw new Error("upload failed");
		},
	});
	options.download = async () => ({
		cleanup: async () => {
			cleaned = true;
		},
	});
	await assert.rejects(syncRelease(options), /upload failed/);
	assert.equal(cleaned, true);
	assert.equal(
		calls.some((call) => call.method === "PATCH"),
		false,
	);
});

test("reject missing attachments and mismatched AtomGit tag commits", async () => {
	const missing = fixture({ release: async () => ({ assets: [] }) });
	await assert.rejects(syncRelease(missing.options), /missing or duplicated/);
	assert.equal(
		missing.calls.some((call) => call.method === "PATCH"),
		false,
	);
	const wrongTag = fixture({ api: async () => ({ sha: "wrong" }) });
	await assert.rejects(syncRelease(wrongTag.options), /does not match/);
});

test("reject unsafe and incomplete source assets before touching AtomGit", async () => {
	for (const assets of [
		[],
		[{ ...asset, name: "../secret" }],
		[asset, asset],
		[{ ...asset, state: "new" }],
	]) {
		const { options, calls } = fixture();
		await assert.rejects(syncRelease({ ...options, assets }));
		assert.equal(calls.length, 0);
	}
});

test("resolves the release from the list so drafts are selectable", () => {
	const draft = { id: 397038165, tag_name: "v0.11.4", draft: true };
	assert.equal(
		selectRelease([{ tag_name: "v0.11.3" }, draft], "v0.11.4"),
		draft,
	);
	assert.throws(
		() => selectRelease([draft], "v9.9.9"),
		/GitHub Release not found: v9\.9\.9/,
	);
});

test("lookup paginates; authentication errors do not masquerade as missing releases", async () => {
	let requests = 0;
	const atomgit = new AtomGit("org/repo", "token", async () => {
		requests++;
		return Response.json(requests === 1 ? [{ tag_name: "other" }] : [release]);
	});
	assert.equal(
		(await atomgit.findRelease(release.tag_name)).tag_name,
		release.tag_name,
	);
	assert.equal(requests, 2);
	atomgit.request = async () => new Response("denied", { status: 403 });
	await assert.rejects(atomgit.findRelease("missing"), /HTTP 403/);
});

test("PUT uses signed headers without PAT; repeated sync skips identical bytes and replaces changed bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "atomgit-test-"));
	const file = join(directory, "asset");
	await writeFile(file, "new");
	let stored = Buffer.from("old");
	let exists = true;
	let puts = 0;
	let deletes = 0;
	const expected = await digest([Buffer.from("new")]);
	const atomgit = new AtomGit(
		"org/repo",
		"private-token",
		async (url, options) => {
			if (url === "https://storage.example/signed") {
				puts++;
				assert.equal(options.headers.Authorization, undefined);
				assert.equal(options.headers["x-obs-test"], "required");
				assert.equal(options.headers["Content-Length"], "3");
				const chunks = [];
				for await (const chunk of options.body) chunks.push(chunk);
				stored = Buffer.concat(chunks);
				exists = true;
				return new Response("success");
			}
			assert.equal(options.headers.Authorization, "Bearer private-token");
			if (url.includes("/upload_url?")) {
				assert.equal(new URL(url).searchParams.get("file_name"), asset.name);
				return Response.json({
					url: "https://storage.example/signed",
					headers: { "x-obs-test": "required" },
				});
			}
			if (url.endsWith("/download")) return new Response(stored);
			if (options.method === "DELETE") {
				deletes++;
				exists = false;
				return new Response(null, { status: 204 });
			}
			return Response.json({ assets: exists ? [asset] : [] });
		},
	);
	try {
		await atomgit.upload(release.tag_name, asset, file, expected);
		await atomgit.upload(release.tag_name, asset, file, expected);
		assert.equal(puts, 1);
		assert.equal(deletes, 1);
		assert.equal(stored.toString(), "new");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("transient errors retry but exhausted retries fail", async () => {
	let attempts = 0;
	await assert.rejects(
		retry(
			async () => {
				attempts++;
				throw new Error("offline");
			},
			async () => {},
		),
		/offline/,
	);
	assert.equal(attempts, 3);
});
