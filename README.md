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
| 2. Connect a parent agent | **Buttons** that run `claude mcp add` / `codex mcp add` for you over **stdio** (auto-start) and install **usage guidance**: a global skill for Claude Code, a fenced section in Codex's `AGENTS.md`. Locates the CLI binaries automatically; safe to click again |
| 3. Allowed models | **Checkboxes** to enable/disable each model; a disabled model is refused if requested |
| 4. Recent delegations | Every run with model, status, **why it stopped / what it is doing now**, duration, tokens in/out, **cache-hit ratio** and changed files; hover a row for the task and session id |

The control panel is also reachable from a floating link inside the DSH UI.

### Every run is a session in the DSH UI

Each delegation runs as an ordinary top-level harness session: it appears in the DSH sidebar grouped under your repo's workspace, titled `[Research] - <project folder>: …` or `[Code] - <project folder>: …`, and you can open it to read the full transcript and every tool call. The repo is registered as a workspace automatically.

**Stopping a run:** from the parent, `deepseek_cancel` (or Esc on a foreground call); from the DSH UI, open the session and press **Stop** in the composer. Both call the same `agent.cancel` the harness uses for its own sessions, which aborts the turn and kills any command the agent is running (verified: a `Start-Sleep 120` was killed at cancel time and the tool returned `stopReason: aborted`). The MCP result carries the changed-file evidence and the reason. A stopped session is not dead: `deepseek_continue` resumes it with its memory intact — also while it is open in the UI, since opening a session there turns it into a live agent the UI keeps; the follow-up then runs on that agent and you watch it in the UI.

### Teaching the parent how to delegate

Registering the server only makes the tools exist. The connect buttons also install guidance on *when and how* to use them:

- **Claude Code:** `skills/claude/deepseek-subagent/SKILL.md` is copied to `~/.claude/skills/deepseek-subagent/` (respects `CLAUDE_CONFIG_DIR`). Its `allowed-tools` pre-approves all the MCP tools so there are no permission prompts.
- **Codex CLI:** `skills/codex/AGENTS.snippet.md` is inserted into `~/.codex/AGENTS.md` between `<!-- dsh-sub-mcp:start/end -->` markers (respects `CODEX_HOME`). Re-connecting replaces the section; your own content around it is untouched.

Edit the files under `skills/` and click connect again to redeploy them.

This is deliberate. The harness's own subagent mechanism tags children with `origin: "subagent"`, and the DSH sidebar hides those unconditionally (they only render nested under a parent web session). So instead of `ctx.subagents.start`, `src/delegate.mjs` does what the in-process subagent driver does internally — create an agent, apply the persona and tool restriction in its setup window, send one user turn, read the result from the event log — but as a normal session.

### Running a second instance

`DSH_SUB_HOME` and `DSH_SUB_PORT` override the state directory and port, so you can run an isolated instance (for testing, or a second key) beside the live one:

```cmd
set DSH_SUB_HOME=C:\path\to\other-home
set DSH_SUB_PORT=3084
npm start
```

### Cost and caching

Every tool result ends with a line like:

```
tokens: 6,653 in (86.6% cache hit, 893 uncached) / 295 out
```

DeepSeek caches prompt prefixes server-side per account, and cache-hit input is ~50× cheaper than uncached (`deepseek-flash`: $0.003 vs $0.15 per 1M). Parallel sub-agents share the same prefix — the DSH system prompt, tool definitions and this project's task framing — so they benefit from each other, and each agent's own multi-turn loop hits the cache on every turn. The DSH system prompt contains nothing that varies per request (no timestamps), so the prefix stays stable. Accounting is read from the harness's own token meter, not estimated.

After connecting once, **you never start anything by hand again**: launching Claude Code or Codex brings the server up in the background.

## Daily use

1. Open Claude Code in any repo.
2. Ask naturally:
   - *"use deepseek to review the auth module for bugs"* → `deepseek_research`
   - *"use deepseek to fix the off-by-one in math.js"* → `deepseek_code`
   - *"ask deepseek to carry on where it stopped"* → `deepseek_continue`
   - *"what is deepseek doing?"* → `deepseek_sessions`
3. Nothing to shut down. To stop the server completely, end the node process holding port 3083.

## The MCP tools

### Delegating

| Tool | Tools available to the agent | Use for |
|---|---|---|
| `deepseek_models(refresh?)` | — | Current DeepSeek models, fetched live from the API |
| `deepseek_research(task, workspace, …)` | `read, read_image, glob, grep` | Analysis, review, exploration — **never writes** |
| `deepseek_code(task, workspace, allowDirty?, …)` | plus `write, edit, bash, pwsh` | Actual code changes |

Shared options: `model?`, `timeoutSec?` (default 900, max 3600), `maxToolCalls?` (default 150, 20–400), `background?`.

- `workspace` is **required** and absolute. Claude/Codex fills in its own cwd.
- `task` must be **self-contained** — the DeepSeek agent cannot see the parent's conversation.
- `deepseek_code` **refuses a dirty git tree** (unless `allowDirty: true`) so a rollback point always exists.
- Every result, including failures, carries `stopReason`, the **session id**, and the list of changed files.
- `background: true` returns at once with the session id; the agent keeps working and the report is read later with `deepseek_result`.

### Sessions: list, read, continue, steer, cancel

Every delegation is a persisted DSH session, and the parent can keep working with it:

| Tool | What it does |
|---|---|
| `deepseek_sessions(workspace?, status?, limit?)` | Running sessions first (elapsed, tool calls so far, last tool), then finished ones newest first with status, **why they stopped**, duration, cost and changed-file count. |
| `deepseek_result(sessionId, waitSec?)` | The full report of a session — after a background run, after the parent's own timeout, or to re-read an old one. For a running session it waits up to `waitSec`, then reports progress instead. |
| `deepseek_continue(sessionId, message, role?, …)` | Sends a **follow-up turn to a finished session**. The agent resumes with everything it already read and did — "carry on where you stopped", "now also handle X", or a follow-up question to a research agent. `role` can switch capability for that turn; `allowDirty` defaults to true because the tree is usually dirty from the previous turn. If the session is open in the DSH UI, the turn runs on the agent the UI holds (its model and preset, narrowed to the role's tools) and shows up there live. |
| `deepseek_steer(sessionId, message)` | Injects a message into a **running** session; the agent reads it at its next step. |
| `deepseek_cancel(sessionId)` | Stops a running session. Files already written stay; the record says it was cancelled and it can be continued later. |

Reports live in `.dsh-sub/results/<sessionId>.json`; the run list in `.dsh-sub/delegations.json` (a run is recorded when it starts, so a harness crash leaves it marked `interrupted`, not lost).

### Guardrails

The workspace is rejected if it is a drive root, the user profile, or contains the harness's own `.dsh-sub` credential store. The sub-agent is forbidden from deploying, pushing, using SSH, reading secrets, or spawning nested agents.

The **loop guard** is cooperative rather than a kill switch:

- **Budget** — default 150 tool calls (`maxToolCalls`). The agent is told its budget up front, warned at 80%, and once it is spent every further call is *blocked with a message* telling it to write its final report. Only an agent that keeps calling tools after that is stopped.
- **Repeats** — the same call three times within the last 12 calls **with no file edit in between** is blocked (its result cannot change). Edit → typecheck → edit → typecheck is fine.
- After three blocked calls the run is stopped, and the record says why (`tool-call-limit` / `repeat-loop`).

Every early stop carries its reason in the result, the sessions list and the control panel: timeout, loop guard, `deepseek_cancel`, or the parent disconnecting.

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

A foreground call runs for as long as the agent needs, up to `timeoutSec` (default 900, max 3600). While it runs the bridge streams **progress notifications** to the parent (elapsed time, tool calls, the current tool), which Claude Code shows live and which keep its idle timer from firing.

For anything that may take more than a few minutes, prefer `background: true` and collect the report with `deepseek_result({ sessionId, waitSec })`: the parent is free to do other work meanwhile, and nothing is lost if the parent's own timeout fires.

Cancelling (Esc) in the parent aborts the DeepSeek agent — the bridge turns the parent's `notifications/cancelled` into a dropped connection, and the harness stops that run. Files already written are **not** rolled back — which is why `deepseek_code` insists on a clean tree — and the session can be resumed with `deepseek_continue`.

> **Why the bridge does not use `fetch()`.** Node's built-in fetch caps the wait for response headers at 300 s, and with a buffered JSON response nothing is sent until the tool finishes. Every delegation longer than five minutes was silently aborted at ~305 s. The bridge now uses `node:http` with no timeout and the harness streams SSE, so the only limits are `timeoutSec` and the parent's own settings (Claude Code: `MCP_TOOL_TIMEOUT`, and a 30-minute stdio idle timeout that progress notifications reset).

## Layout

```
src/bootstrap.mjs    scaffolds the DSH profile and generates .dsh-sub/sub.patch.json (absolute paths)
src/serve.mjs        runs the harness (foreground, or background with --no-open)
src/mcp-stdio.mjs    stdio bridge for Claude/Codex; auto-starts the harness
src/mcp-plugin.mjs   DSH plugin: /mcp endpoint, /setup control panel, the eight tools, run history and results
src/delegate.mjs     runs each DeepSeek delegation as a top-level harness session (create or resume), with the loop guard
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
