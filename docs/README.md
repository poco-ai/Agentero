# Agentero documentation

Fumadocs + Next.js static documentation, managed in the root pnpm workspace.

Run from the repository root:

```sh
pnpm install
pnpm docs:dev
pnpm docs:check
pnpm docs:build
pnpm docs:preview
```

Development opens at http://localhost:3000. `docs:preview` serves the built `docs/out/` directory. Deploy that directory to a static host; no Node.js server is required in production.

## Authoring

- Write Markdown/MDX in `docs/content/docs/`.
- Collections use the Fumadocs Macro API in `docs/lib/source.ts`.
- Configure navigation with `meta.json` files and shared layout options in `docs/lib/layout.shared.tsx`.
- Search uses a static index and runs in the browser.
- Root Biome configuration handles formatting and linting. Generated files are ignored.
- Commit the root `pnpm-lock.yaml`; do not create a separate documentation lockfile.

## Next steps

The initial pages are scaffold examples. Replace them with Agentero's task-oriented guides, starting with installation, importing a paper, reading and annotation, notes, and agents. Verify instructions against the current product.

References: [Fumadocs](https://www.fumadocs.dev/docs), [static export](https://www.fumadocs.dev/docs/deploying/static).
