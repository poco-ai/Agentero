import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAssetNameMap, rewriteManifest } from "./rewrite-updater-json.mjs";

const repository = "poco-ai/Agentero";
const tag = "v1.2.3";

function manifest(platforms) {
	return { version: "1.2.3", platforms };
}

test("rewrites api asset urls to release download urls", () => {
	const idToName = buildAssetNameMap([
		{
			apiUrl: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/7",
			name: "Agentero 1.2.3_aarch64.app.tar.gz",
		},
	]);
	const doc = manifest({
		"darwin-aarch64": {
			signature: "sig",
			url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/7",
		},
	});

	const result = rewriteManifest(doc, { repository, tag, idToName });

	assert.deepEqual(result, { rewritten: 1, already: 0 });
	assert.equal(
		doc.platforms["darwin-aarch64"].url,
		"https://github.com/poco-ai/Agentero/releases/download/v1.2.3/Agentero%201.2.3_aarch64.app.tar.gz",
	);
	assert.equal(doc.platforms["darwin-aarch64"].signature, "sig");
});

test("rerun keeps rewritten urls untouched", () => {
	const doc = manifest({
		"linux-x86_64": {
			signature: "sig",
			url: "https://github.com/poco-ai/Agentero/releases/download/v1.2.3/Agentero_1.2.3_amd64.AppImage",
		},
	});

	const result = rewriteManifest(doc, {
		repository,
		tag,
		idToName: new Map(),
	});

	assert.deepEqual(result, { rewritten: 0, already: 1 });
});

test("fails when an asset id is missing from the release", () => {
	const doc = manifest({
		"windows-x86_64": {
			signature: "sig",
			url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/9",
		},
	});

	assert.throws(
		() => rewriteManifest(doc, { repository, tag, idToName: new Map() }),
		/asset 9 is not in release v1\.2\.3/,
	);
});

test("fails on an unexpected url shape", () => {
	const doc = manifest({
		"darwin-x86_64": { signature: "sig", url: "https://example.com/file" },
	});

	assert.throws(
		() => rewriteManifest(doc, { repository, tag, idToName: new Map() }),
		/unexpected url https:\/\/example\.com\/file/,
	);
});

for (const [scenario, url] of [
	[
		"different repository",
		"https://api.github.com/repos/another/repo/releases/assets/7",
	],
	[
		"non-GitHub host",
		"https://example.com/repos/poco-ai/Agentero/releases/assets/7",
	],
]) {
	test(`rejects asset urls from a ${scenario}`, () => {
		const doc = manifest({
			"darwin-aarch64": { signature: "sig", url },
		});
		assert.throws(
			() =>
				rewriteManifest(doc, {
					repository,
					tag,
					idToName: new Map([["7", "Agentero.tar.gz"]]),
				}),
			/unexpected url/,
		);
		assert.equal(doc.platforms["darwin-aarch64"].url, url);
	});
}
