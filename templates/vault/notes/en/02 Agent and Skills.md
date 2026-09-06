# Agent & Skills

Agentero uses **BYOA** (Bring Your Own Agent): you install and log in to an ACP-compatible agent on your machine, and Agentero passes the current Vault context to it. You do not need to enter a model API key in Agentero.

## Agent Panel

Click the sidebar button in the top-right corner to open the **Agent** panel (`⌘+L`).

When a paper is open, it is added to the Agent context automatically. You can:

- Type a question directly.
- Use `@` to mention any path in the Vault.
- Use `/` to invoke a Skill or another slash command.
- Drag a file or folder from the file tree into the composer as context.
- Select text or annotations in the PDF and send them to the Agent.

You can keep typing while the Agent is responding. Later messages are queued and sent automatically after the current response finishes.

## Skills

### Using Skills

Use `/` in the conversation to invoke a Skill or another slash command.

### Editing a Skill

Edit the corresponding `SKILL.md` directly.

### Adding a Skill

Create a new folder under `.agents/skills/` and add a `SKILL.md` file.

Alternatively, paste the URL of a Skill into the Magic Wand. Agentero downloads and installs it automatically.

### Bundled Skills

Bundled Skills include:

- `paper-reader` — deep-read a paper and write `NOTES.md`.
- `agentero-cli` — run Vault operations through the CLI.
- `vault-normalizer` — reorganize an existing research directory into the Agentero Vault layout.
- `deep-research` — conduct multi-step research with citations.
- `idea-evaluator` — evaluate research ideas from multiple perspectives.

### Example: Reading a Paper

The paper must have a local PDF and readable text, either TeX or `PAPER.md`:

- **Manual reading**: click the **Zap** icon on an unread paper row.
- **Automatic reading**: enable **autoPaperReader** under Settings → Agent. It is disabled by default.

The reading result is written to the paper's `NOTES.md`, and the paper is marked as read when the workflow finishes.

## Settings

### Adding an Agent

1. Open **Settings** (`⌘,`).
2. Go to **Agent**.
3. Choose an automatically detected Agent, or add a custom Agent.
4. If the app cannot detect it, enter the executable's **absolute path**.
5. Choose the default Agent.
6. Start a test conversation.

### Agents not directly supported

The following desktop apps currently **cannot** be used as in-app Agentero agents:

- **OpenAI Codex desktop app**: Agentero connects to **Codex CLI** (the command-line version) through the `@agentclientprotocol/codex-acp` adapter; the standalone Codex desktop app does not expose an interface that Agentero can connect to.
- **WorkBuddy (Tencent)**: Agentero does not yet have an ACP adapter template for WorkBuddy, so it cannot be connected directly.

To use Codex, install Codex CLI and connect it via `codex-acp`. There is no supported way to connect WorkBuddy at this time.

## Troubleshooting

### Q1: An Agent is not detected

Check that the Agent is installed and that its executable is available on your `PATH`. You can also add it manually using its absolute path in **Settings** → **Agent**.

### Q2: The Agent cannot connect or use the network

Check the proxy settings under **Settings** → **General**.

## Next

- [[01 Papers and Import]]
- [[03 Markdown and Wikilinks]]
