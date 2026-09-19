# DSH-Sub-MCP

**DeepSeek as a sub-agent for Claude Code and Codex CLI.**

Claude Code (or Codex) stays the parent orchestrator with all of its native capabilities. When you say *"use deepseek for this"*, it delegates a self-contained task to a real DeepSeek agent — one with file and shell tools, running locally inside the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — and gets the result back over MCP.

```
Claude Code / Codex CLI
   └─ spawns src/mcp-stdio.mjs                (stdio MCP, instant)
        ├─ harness not running? → starts it in the background (no window)
        └─ forwards JSON-RPC → 127.0.0.1:3083/mcp
                                   │
                              DSH harness (local)
                                   │
                              DeepSeek API (your key)
```

`http://127.0.0.1:3083/` is also the **stock DeepSeek Harness GUI** — chat with DeepSeek directly, manage your API key, browse session history. Nothing custom to learn.

## Requirements

- Node.js 20+ on PATH (tested on v22)
- A DeepSeek API key
- Claude Code and/or Codex CLI

## Setup

```cmd
npm install
```

Then double-click **`Start.vbs`** (no console window; opens the control panel), or run `npm start` for a foreground process with live logs.

Everything else happens in the control panel:

| Section | What it does |
|---|---|
| 1. API key | Shows whether a key is configured; if not, links to the DSH UI → Settings → Models |
| 2. Connect a parent agent | **Buttons** that run `claude mcp add` / `codex mcp add` for you, over **stdio** so the server auto-starts. Locates the CLI binaries automatically; safe to click again |
| 3. Allowed models | **Checkboxes** to enable/disable each model; a disabled model is refused if requested |

The control panel is also reachable from a floating link inside the DSH UI.

After connecting once, **you never start anything by hand again**: launching Claude Code or Codex brings the server up in the background.

## Daily use

1. Open Claude Code in any repo.
2. Ask naturally:
   - *"use deepseek to review the auth module for bugs"* → `deepseek_research`
   - *"use deepseek to fix the off-by-one in math.js"* → `deepseek_code`
3. Nothing to shut down. To stop the server completely, end the node process holding port 3083.

## The three MCP tools

| Tool | Tools available to the agent | Use for |
|---|---|---|
| `deepseek_models(refresh?)` | — | Current DeepSeek models, fetched live from the API |
| `deepseek_research(task, workspace, model?, timeoutSec?)` | `read, read_image, glob, grep` | Analysis, review, exploration — **never writes** |
| `deepseek_code(task, workspace, model?, timeoutSec?, allowDirty?)` | plus `write, edit, bash, pwsh` | Actual code changes |

- `workspace` is **required** and absolute. Claude/Codex fills in its own cwd.
- `task` must be **self-contained** — the DeepSeek agent cannot see the parent's conversation.
- `deepseek_code` **refuses a dirty git tree** (unless `allowDirty: true`) so a rollback point always exists.
- Every result, including failures, carries `stopReason` and the list of changed files.

### Guardrails

The workspace is rejected if it is a drive root, the user profile, or contains the harness's own `.dsh-sub` credential store. The sub-agent is forbidden from deploying, pushing, using SSH, reading secrets, or spawning nested agents, and a `LoopGuard` aborts runaway loops (default: 80 tool calls, 3 identical repeats).

## Auto-start

The connect buttons register the **stdio** transport, so the parent spawns a small bridge (`src/mcp-stdio.mjs`). The bridge checks for the harness, starts it if needed, and forwards messages.

- **No window appears** — the harness runs as a `DETACHED_PROCESS` with no console.
- The harness **outlives the parent**, so the next session reuses it without waiting for boot.
- The bridge warms the harness while the parent is still starting, so the first tool call rarely waits.
- No bearer tokens or environment variables to manage — stdio is private between parent and bridge.

Verified by stopping the server and running `claude mcp list`: the server comes back up and reports `✔ Connected`.

### CLI discovery

Neither CLI is reliably on PATH. The connect buttons look in `~/.local/bin/`, `%APPDATA%\npm\`, `%LOCALAPPDATA%\Programs\`, and for Codex the Cursor/VS Code ChatGPT extension (`~/.cursor/extensions/openai.chatgpt-*/bin/`). PATH is the last resort.

Claude Code is registered at **user scope**, so it works from every repo, not just this directory.

## Live model catalog

The DSH adapter ships a hardcoded catalog that still lists retired models, so this project **always fetches `GET https://api.deepseek.com/models`** instead:

- On boot, the cached catalog (`.dsh-sub/model-catalog.json`) loads immediately and a live probe runs in the background.
- A model that disappears from the API is kept but marked `listed: false`, with a warning if you use it.
- A new DeepSeek model **works immediately** — the `model` parameter passes straight through to the adapter.
- Offline or no key? The cache is used and flagged `catalogStale: true`. The seed list is only a first-run fallback.
- `deepseek_models({ refresh: true })` forces a re-probe (throttled to 60s).

`GET /models` returns ids only, so modality metadata (image support) lives in `CAPABILITIES` in `src/bootstrap.mjs`. Unknown models default to text-only and fail loudly on image input rather than misbehaving.

## Long-running jobs

Tools run **synchronously** with a default 900s timeout (`timeoutSec`, max 3600).

Claude Code auto-backgrounds calls over 2 minutes. For long jobs, set the per-server timeout in `.claude.json` **above** `timeoutSec`:

```json
{ "mcpServers": { "deepseek": { "timeout": 1200000 } } }
```

Cancelling (Esc) aborts the DeepSeek agent. Files already written are **not** rolled back — which is why `deepseek_code` insists on a clean tree.

## Layout

```
src/bootstrap.mjs    scaffolds the DSH profile and generates .dsh-sub/sub.patch.json (absolute paths)
src/serve.mjs        runs the harness (foreground, or background with --no-open)
src/mcp-stdio.mjs    stdio bridge for Claude/Codex; auto-starts the harness
src/mcp-plugin.mjs   DSH plugin: /mcp endpoint, /setup control panel, the three tools
src/delegate.mjs     runs a DeepSeek sub-agent via ctx.subagents.start('spawn', ...) with LoopGuard
src/models.mjs       live /models probe, cache, retirement detection, enable/disable
src/workspace.mjs    workspace validation and git evidence
.dsh-sub/            private DSH_HOME: profile, credentials, cache, token, logs (git-ignored)
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `stopReason: error`, 0 tool calls | No DeepSeek API key, or quota exhausted. DSH UI → Settings → Models. |
| `Port 3083 is busy` | An old instance is still running. |
| `...cannot be used as the workspace` | You pointed `workspace` at this project's own directory. Use another repo. |
| Claude Code does not list the server | Connect button not clicked yet. Check with `/mcp`. |
| Connect button cannot find a CLI | Installed somewhere unusual. Run `claude mcp add` / `codex mcp add` manually with the command shown on the page. |

Logs: `.dsh-sub/web.out.log`, `.dsh-sub/web.err.log` (may contain private data).

## Security notes

- The MCP endpoint binds to `127.0.0.1` only, requires a bearer token, and rejects any request carrying an `Origin` header (blocks DNS-rebinding from a browser).
- The control panel needs the same token (`/setup?key=...`) or an authenticated DSH browser session.
- Nothing in `.dsh-sub/` is committed: it holds your API key, session data, and the MCP token.
