---
name: agentero-cli
version: 21
description: Search and read cited research evidence, work with papers and notes, and manage an Agentero Vault using the local CLI.
---

# Agentero CLI

Run `agentero help <command> --json` for its arguments and example. Use the executable provided by the desktop host during a managed turn. Standalone commands resolve the Vault from `--vault`, `AGENTERO_VAULT` or the current directory.

On POSIX, the optional desktop PATH installation exposes `~/.local/bin/agentero`.

## Find and verify evidence

```sh
agentero paper list --state unread --json
agentero search "batch size" --in papers/atlas --limit 1 --plain | agentero read -
agentero read papers/atlas --page 2-3,8 --json
agentero paper regions papers/atlas --kind table --json
agentero paper relations papers/atlas --direction cited-by --json
```

Each search hit includes a short excerpt, its location, revision and cite. Pass the cite unchanged to `read` to verify the passage. On a stale citation, repeat the search. A scoped desktop turn only opens the material assigned to that turn. Use the initial evidence when expansion is unavailable.

## Change an object

```sh
agentero paper import id 1706.03762 --json
agentero paper get papers/atlas --json
agentero read papers/atlas --part notes --json
agentero paper note append papers/atlas --input ./notes.md --request-id note-atlas-1 --json
agentero file remove drafts/obsolete.md --dry-run --json
```

For a replacement, pass the revision of the object being changed. Keep the same request ID when retrying the same append or row change after a lost response. Table revisions come from `table query`. Result JSON goes to stdout, diagnostics to stderr. Check the exit status before using a result.

Inside the desktop chat, `agentero app present outputs/comparison.md` publishes an existing file to the current turn. External MCP clients can discover their available operations via `tools/list`; the local CLI works independently.
