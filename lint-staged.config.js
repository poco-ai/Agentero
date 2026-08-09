export default {
	// A string command receives the staged file list appended by lint-staged.
	// Do not wrap it in a thunk: that would drop the paths and lint the whole
	// repo, letting unrelated in-progress files block every commit.
	"*.{ts,tsx,js,jsx,json,jsonc,css,html,md}":
		"biome check --write --no-errors-on-unmatched",
	// cargo fmt works per crate, not per file.
	"src-tauri/**/*.rs": () => "pnpm run fix:rs",
};
