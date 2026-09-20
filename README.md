# DSH-Sub-MCP

**The DeepSeek Harness as a sub-agent for Claude Code and Codex CLI — on DeepSeek, GLM or any provider you configure there.**

Claude Code (or Codex) stays the parent orchestrator with all of its native capabilities. When you say *"use deepseek for this"*, it delegates a self-contained task to a real agent — one with file and shell tools, running locally inside the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) on whichever provider/model you pick (DeepSeek, or a custom route such as GLM added under Settings → Models) — and gets the result back over MCP. It can also hand the parent's own skills (SKILL.md files) to the sub-agent by name.

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

`http://127.0.0.1:3083/` is the **stock DeepSeek Harness GUI** — chat with DeepSeek directly, manage your API key, browse session history. This project adds one page to it: **Settings → Sub-agent**, where you connect Claude Code / Codex, choose the allowed models and watch the delegations. Nothing else to learn.

## Requirements

- Node.js 20+ on PATH (tested on v22)
- A DeepSeek API key
- Claude Code and/or Codex CLI

## Setup

```cmd
npm install
```

Then double-click **`Start.vbs`** (no console window; opens the DSH UI on Settings → Sub-agent), or run `npm start` for a foreground process with live logs.

Everything else happens on that settings page:

| Card | What it does |
|---|---|
| Status | Whether a DeepSeek API key is configured (add one under Settings → Models), the MCP endpoint URL, how many delegations are running. **Restart server** relaunches the harness in place (refused while a delegation is running); the page reloads when it is back |
| Parent agents | **Connect** runs `claude mcp add` / `codex mcp add` for you over **stdio** (auto-start) and installs **usage guidance**: a global skill for Claude Code, a fenced section in Codex's `AGENTS.md`. **Verify** asks the CLI whether the registration is still there. Locates the CLI binaries automatically; safe to click again |
| Allowed models | Every provider active in the harness, grouped, with its API-key status, and a **switch** per model (`provider/model`). A model switched off is refused if the parent requests it. With **one** model on, the parent uses it silently; with **two or more**, a call without `model` is refused and the parent must ask you which to use. **Refresh DeepSeek** re-probes the DeepSeek API for retired ids |
| Recent delegations | Every run with role, model, status, **why it stopped / what it is doing now**, duration, tokens in/out, **cache-hit ratio** and changed files. **Click a row to open that session's conversation**; the chevron shows the task, workspace, session id and — for an isolated run — the worktree with a **Remove worktree** button; a running row has a **Stop** button. Tick rows and **Delete** to drop them from the list and their stored reports (the harness archives the transcript — hidden from the sidebar, never erased) |
| How to use | The phrases that trigger each tool |

The page is a DSH client plugin (`src/client.js`, declared as `dsh.client` in `package.json`), rendered by the harness's own Settings dialog with its own components and theme; the host half serves it JSON under `/dsh-sub/*`. It is also reachable from any browser as `http://127.0.0.1:3083/setup?key=<mcp token>`, which signs you into the UI and opens the section.

### Every run is a session in the DSH UI

Each delegation runs as an ordinary top-level harness session: it appears in the DSH sidebar grouped under your repo's workspace, titled `[Research] - <project folder>: …` or `[Code] - <project folder>: …`, and you can open it to read the full transcript and every tool call. The repo is registered as a workspace automatically and the session is attached to it explicitly (the registry only groups sessions that were attached; on boot, runs recorded by earlier versions are attached retroactively so nothing stays under "Ungrouped").

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
| `deepseek_models(refresh?)` | — | Every active provider with its models, key status and enabled flags (`enabled` = the usable `provider/model` keys) |
| `deepseek_skills(workspace?, refresh?)` | — | The parent's skills (SKILL.md files) that can be attached to a delegation by name |
| `deepseek_research(task, workspace, …)` | `read, read_image, glob, grep` | Analysis, review, exploration — **never writes** |
| `deepseek_code(task, workspace, allowDirty?, isolation?, …)` | plus `write, edit, bash, pwsh` | Actual code changes — in place, or in a git worktree of their own (below) |
| `deepseek_worktree(sessionId, action, message?)` | — | `status` / `diff` / `commit` / `apply` / `remove` the worktree a session ran in |

Shared options: `model?` (`provider/model`), `reasoningEffort?` (default `high`; `max` for hard tasks), `skills?` (names), `timeoutSec?` (default 900, max 3600), `maxToolCalls?` (default 150, 20–400), `background?`.

- `workspace` is **required** and absolute. Claude/Codex fills in its own cwd.
- `task` must be **self-contained** — the sub-agent cannot see the parent's conversation.
- `model` is one string, `provider/model` (`deepseek-official/deepseek-flash`, `zai/glm-5.3`). A bare id is accepted only when it is unique across providers. **Ask-first rule:** when more than one model is enabled and `model` is omitted, the call is refused with `MODEL REQUIRED` and the list, so the parent asks the user instead of guessing. `deepseek_continue` never asks — it stays on its session's model unless `model` is passed.
- `reasoningEffort` is validated against the levels the model offers (`deepseek_models` lists them; DeepSeek: off/low/high/max). Default `high`; the parent's guidance says to use `max` for hard tasks. A continuation keeps the session's previous effort unless one is passed. The header shows it as `effort: …`.
- `skills: ["name", …]` attaches the parent's own skills (see below).
- `deepseek_code` **refuses a dirty git tree** (unless `allowDirty: true`, or `isolation: "worktree"`) so a rollback point always exists.
- Every result, including failures, carries `stopReason`, the **session id**, and the list of changed files.
- `background: true` returns at once with the session id; the agent keeps working and the report is read later with `deepseek_result`.

### Worktree isolation: let the sub-agent code on its own branch

The parent decides, per `deepseek_code` call, whether the agent edits the parent's checkout (`isolation: "inplace"`, the default) or a **git worktree of its own** (`isolation: "worktree"`) — the same choice Claude Code offers its subagents, and one Codex CLI's `spawn_agent` cannot make yet. The installed guidance tells the parent when to pick which: a dirty tree, several code delegations at once, a large or risky change, or the user asking for a branch → worktree; a small edit the user wants to see right away → in place.

What the server does for a worktree run:

- `git worktree add` under `<repo>/.dsh/worktrees/<name>` on a new branch `dsh/<task-slug>-<id>` (or `branch`) from `HEAD` (or `base`), locked while the agent runs. `.dsh/` is added to `.git/info/exclude` (local to the clone, so nothing shows as untracked and ripgrep-based tools skip it), and the session's cwd — and so its **sandbox root** — is the worktree.
- `node_modules` (any gitignored directory in `linkDirs`, default `["node_modules"]`) is junction-linked from the main checkout, read-only for the agent. Files matching a `.worktreeinclude` in the repo root (same file and semantics as Claude Code's; `.env` and the like) are copied. `includeUncommitted: true` also carries the parent's uncommitted changes and untracked files over.
- Absolute paths into the main checkout inside `task` are rewritten to the worktree, and the agent is told it is in a worktree and must not commit.
- When the run ends: a worktree with **no changes is removed automatically**, branch included. One with changes stays; the result names the path and branch and lists the three moves — review (`deepseek_worktree diff`), take (`commit` on the branch, then `git merge`; or `apply`, which copies the changes into the parent's working tree uncommitted and is refused when they do not apply cleanly), drop (`remove`). `deepseek_continue` keeps working in the same worktree until it is removed. Each worktree appears in the DSH sidebar as its own workspace, `<repo> ⎇ <branch>`, dropped again when the worktree is.

Why the agent cannot commit: the DSH sandbox (`workspace-write`) confines every write of the agent to its session cwd. That is what makes the isolation hard — even a confused agent cannot touch the main checkout — but the shared `.git` directory lives outside the worktree, so `git add`/`commit`/`stash`/`checkout` fail there while `git status`/`diff`/`log` work. The server runs the git writes (`commit`, `apply`, `remove`) unconfined on the parent's request. Removal unlinks `node_modules` first: `git worktree remove` does not follow a junction into the main checkout, but leaves it behind.

### Sessions: list, read, continue, steer, cancel

Every delegation is a persisted DSH session, and the parent can keep working with it:

| Tool | What it does |
|---|---|
| `deepseek_sessions(workspace?, status?, limit?)` | Running sessions first (elapsed, tool calls so far, last tool), then finished ones newest first with status, **why they stopped**, duration, cost, changed-file count and the worktree (path, branch, removed or not) for isolated runs. `workspace` matches the repo the parent passed, so worktree runs are listed under it. |
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

Every early stop carries its reason in the result, the sessions list and the settings page: timeout, loop guard, `deepseek_cancel`, or the parent disconnecting.

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

## Model directory

Models come from the harness itself, not from a list of our own: `ctx.llm.listProviders()` / `listModels()` give every route with a registered adapter — `deepseek-official` from the DeepSeek adapter plus whatever you declared under Settings → Models (a `zai` route with GLM models, an OpenAI-compatible gateway, …) — and `ctx.credentials.describe()` says whether each route's `apiKeyEnv` is set, exactly as the harness's Models page computes its green dot. A route without a key is shown but not usable; its models cannot be switched on. The directory is cached for 30 s and dropped on `llm/adapters-updated`, `settings/updated` and `credentials/reference-updated`, so an edit in the DSH settings dialog is visible on the next call.

The per-model switches live in `.dsh-sub/model-catalog.json` (`{ version: 2, enabled: { "provider/model": true } }`). A model the harness gains later is **off** until you switch it on, so adding a provider with a dozen models does not make every delegation ask which one to use. A pre-1.2 catalog (DeepSeek-only rows) is migrated on boot, as are old history entries (`deepseek-flash` → `deepseek-official/deepseek-flash`).

The DSH DeepSeek adapter ships a hardcoded catalog that still lists retired ids, so for `deepseek-official` only, `src/deepseek-live.mjs` still probes `GET https://api.deepseek.com/models` (cached in `.dsh-sub/deepseek-live.json`, background on boot, `deepseek_models({ refresh: true })` or **Refresh DeepSeek** to force, throttled to 60 s). Its result seeds the adapter's model list in `sub.patch.json` and marks a vanished id `listed: false` in the directory. Modality metadata (image support) lives in `CAPABILITIES` in `src/bootstrap.mjs`.

## Skills

The parent can pass `skills: ["docx", "find-skills"]` on `deepseek_research`, `deepseek_code` and `deepseek_continue`. `src/skills.mjs` resolves each name to a `SKILL.md` on disk — workspace `.claude/skills` and `.agents/skills`, `~/.claude/skills` (including `synced/`), `~/.codex/skills` (including `.system/`), `~/.agents/skills`, and the `skills/` folders of installed Claude/Codex plugins; `DSH_SUB_SKILL_DIRS` (`;`-separated) adds more. Only the frontmatter `name`/`description` and the body are used, so Claude Code and Codex skill files work as they are; names are kebab-cased, `plugin:name` picks that plugin's copy, and `deepseek-subagent` itself is never attachable.

Attached skills reach the model the way the harness's own skills do: `delegate.mjs` registers them in the agent's scope (`agentCtx.skills.register`) and mounts `@deepseek-ai/dsh-tool-skill` there, so the session gets an `<available_skills>` catalog (name + description only) and a `skill` tool that loads the full text on demand, with the skill's directory as resource base for its scripts and references. The tool lives in the agent's own layer, so the role's tool restriction does not hide it and nothing changes for other sessions; the task prompt tells the agent which skills were attached and to load them before starting. `deepseek_skills` lists what can be attached; the Status card shows how many were found.

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
src/mcp-plugin.mjs   DSH plugin: /mcp endpoint, the nine tools, ask-first rule, run history and results, /dsh-sub JSON for the settings page, /setup launcher
src/client.js        DSH client plugin: the Settings → Sub-agent page (loaded by the harness, no build step)
src/delegate.mjs     runs each delegation as a top-level harness session (create or resume) on the chosen provider/model, attaches skills, loop guard
src/models.mjs       model directory: active providers + models from the harness, key status, per-model switches, ask-first
src/deepseek-live.mjs live DeepSeek /models probe (retired-id detection; seeds the adapter config)
src/skills.mjs       finds the parent's SKILL.md files and resolves `skills` names
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
| Settings has no Sub-agent entry | The client bundle failed to load; `.dsh-sub/web.err.log` names the `client-modules` error. |

Logs: `.dsh-sub/web.out.log`, `.dsh-sub/web.err.log` (may contain private data).

## Security notes

- The MCP endpoint binds to `127.0.0.1` only, requires a bearer token, and rejects any request carrying an `Origin` header (blocks DNS-rebinding from a browser).
- The settings page API (`/dsh-sub/*`) and the `/setup` launcher accept the same token (`?key=...`) or the signed browser-session cookie the DSH UI holds; cross-origin requests are refused.
- Nothing in `.dsh-sub/` is committed: it holds your API key, session data, and the MCP token.
