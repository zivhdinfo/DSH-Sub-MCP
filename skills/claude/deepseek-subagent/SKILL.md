---
name: deepseek-subagent
description: Delegate self-contained coding tasks to a local agent running in the DeepSeek Harness (DeepSeek, GLM or any provider configured there) through the `deepseek` MCP server. Use when the user says "use deepseek", asks for a DeepSeek/GLM review or second opinion, wants cheap parallel analysis across a codebase, wants a sub-agent to make a scoped code change, or asks what DeepSeek is doing / to continue, steer or stop a DeepSeek session.
allowed-tools: mcp__deepseek__deepseek_models, mcp__deepseek__deepseek_skills, mcp__deepseek__deepseek_research, mcp__deepseek__deepseek_code, mcp__deepseek__deepseek_worktree, mcp__deepseek__deepseek_sessions, mcp__deepseek__deepseek_result, mcp__deepseek__deepseek_continue, mcp__deepseek__deepseek_steer, mcp__deepseek__deepseek_cancel
---

# DeepSeek Harness sub-agent

The `deepseek` MCP server runs a real agent — with file and shell tools — locally inside the DeepSeek Harness, in a workspace you choose, on any model the user has configured there (DeepSeek, GLM via a custom provider, …). You stay the orchestrator; the sub-agent does delegated work and reports back. Every delegation is a persisted **session** you can list, read, continue, steer and cancel.

## Which tool

| Tool | Agent can | Use for |
|---|---|---|
| `deepseek_research` | read, glob, grep only | Reviews, bug hunts, explaining a module, surveying a codebase. Never writes. |
| `deepseek_code` | read + write, edit, bash, pwsh | An actual scoped code change. In place by default (refuses a dirty git tree unless `allowDirty: true`), or in its own git worktree with `isolation: "worktree"` — see below. |
| `deepseek_worktree` | — | For a session that ran in a worktree: `status`, `diff`, `commit` (on its branch, so you can `git merge`), `apply` (copy the changes into your working tree uncommitted), `remove`. |
| `deepseek_continue` | same as the session's role (or `role` to change it) | A **follow-up turn on a finished session**: "carry on where you stopped", "now also do X", a follow-up question to a research agent. The agent keeps everything it already read and did, so this is far cheaper than a fresh task. Runs on the session's model unless you pass `model`. |
| `deepseek_sessions` | — | What is running now (elapsed, tool calls, current tool) and what finished, with **why it stopped**, cost and changed files. |
| `deepseek_result` | — | The full report of a session: after `background: true`, after your call timed out, or to re-read an old one. `waitSec` waits for a running session. |
| `deepseek_steer` | — | Send a message to a **running** session (add a constraint, redirect, "wrap up and report"). |
| `deepseek_cancel` | — | Stop a running session. Files already written stay; it can be continued later. |
| `deepseek_models` | — | Every provider active on the harness with its models, key status and which are enabled. **Read it when you must pick `model`.** |
| `deepseek_skills` | — | The skills (your own SKILL.md files) the server can attach to a delegation, by name. |

## Choosing the model

`model` is one string, `provider/model` — e.g. `deepseek-official/deepseek-flash`, `zai/glm-5.3`. The user switches models on and off in the DSH UI (Settings → Sub-agent).

- Exactly **one** model enabled → omit `model`; it is used silently.
- **More than one** enabled → a call without `model` is refused with `MODEL REQUIRED` and the list of enabled models. **Ask the user which one to use (AskUserQuestion with that list), then call again with `model` set.** Do not pick one yourself. Remember the choice for the rest of the conversation; ask again only if the user changes their mind or the list changes.
- A model the user switched off, or whose provider has no API key, is refused; the error names the enabled ones.

## Reasoning effort

`reasoningEffort` controls how hard the model thinks. Default **`high`**. Use **`max`** for hard tasks — subtle or intermittent bugs, cross-cutting refactors, security-sensitive changes, anything where a wrong answer costs more than the extra tokens. `low`/`off` only for trivial lookups. Levels depend on the model (`deepseek_models` lists them; DeepSeek offers off/low/high/max). `deepseek_continue` keeps the session's previous effort unless you pass one.

## In place or in a worktree — you decide

`deepseek_code` takes `isolation: "inplace" | "worktree"`. Decide per call, the way you would for your own subagents:

- **`"worktree"`** when: your tree has uncommitted work (prefer this over `allowDirty`); you are about to run **two or more code delegations on the same repo at once**; the change is large or risky enough that you want to review it before it touches your checkout; the user asks for a separate branch. The server creates `<repo>/.dsh/worktrees/<name>` on branch `dsh/<task-slug>-<id>` (or your `branch`) from `HEAD` (or your `base`), shares gitignored `node_modules` into it read-only (`linkDirs`), copies files listed in `.worktreeinclude` (`.env` and the like), and with `includeUncommitted: true` also carries your uncommitted changes over. The agent can only write inside the worktree — your checkout is untouched even if the task goes wrong.
- **`"inplace"`** (default) when: a small edit the user wants to see in the editor right away; the repo is not git; the task needs build artifacts that cannot be shared by link.

After a worktree run the result says `worktree: <path> | branch: <name>` and lists three moves. **Do one of them; never leave a worktree lying around:**

1. **Review** — `deepseek_worktree({ sessionId, action: "diff" })`.
2. **Take** — `action: "commit"` with a message, then `git merge <branch>` yourself (a real 3-way merge); or `action: "apply"` to drop the changes into your working tree uncommitted (refused if they do not apply cleanly — then commit + merge).
3. **Drop** — `action: "remove"` (also deletes the branch unless it holds unmerged commits).

A worktree in which the agent changed nothing is removed automatically. The agent **cannot commit** in a worktree (the shared `.git` is outside its sandbox), so never ask it to; `deepseek_continue` keeps working in the same worktree until you remove it.

## Attaching skills

If one of *your* skills is relevant to the task (a document format, a review checklist, a project convention…), pass its name in `skills: ["name"]` instead of pasting its content into `task`. The server finds the SKILL.md on disk (workspace `.claude/skills`, `~/.claude/skills`, installed plugins, `~/.codex/skills`, `~/.agents/skills`), registers it in the agent's session, and the agent loads it with its own `skill` tool — including any bundled scripts or references. Pick 1–3 relevant skills; unknown names are refused (call `deepseek_skills` when unsure). `deepseek-subagent` itself can never be attached.

## How to call

- `workspace`: the absolute path of the repository you are working in (your current working directory). Never a drive root or a home directory.
- `task`: make it self-contained. The sub-agent cannot see this conversation. Include the relevant file paths, what "done" looks like, and any constraints. One focused objective per call.
- Independent questions → several `deepseek_research` calls in parallel. They share a cached prompt prefix, so parallel calls are cheap.
- `deepseek_code` → one change per call. Read the `Files changed` list in the result and review the diff yourself before building on it. Several changes at once → one call each with `isolation: "worktree"`, then merge or apply them one by one.
- **Long jobs (more than a few minutes, many files, test suites): pass `background: true`**, keep working, then `deepseek_result({ sessionId, waitSec: 120 })`. A foreground call streams progress and runs up to `timeoutSec` (default 900 s), but a background run cannot be lost to any timeout of yours.
- `maxToolCalls` defaults to 150. Raise it (up to 400) for tasks that touch many files; the agent is told its budget and warned at 80%.

## When a run stops early

The result says why: `timeout`, the loop guard (budget exhausted or the same call repeating with no edits between), `deepseek_cancel`, or you disconnecting. Partial edits are listed under `Files changed`. **Do not start over** — `deepseek_continue({ sessionId, message: "You were stopped after X; finish Y and Z, then run the tests" })` resumes with the agent's memory intact (`allowDirty` defaults to true there because the tree is dirty from the previous turn). It also works while the session is open in the DSH UI; only a session that is *busy* there is refused. Review the diff before and after.

## Reading a result

Every result begins with `model | effort | role | workspace | session` (plus `skills` when attached), then `stopReason`, then `tokens: … (N% cache hit)`, then the changed-file evidence, then the agent's own report. The report is a claim, not proof — verify important findings against the source before acting on them. A result flagged as an error still lists what changed on disk and how to continue.

## When not to delegate

Trivial edits you can make faster yourself; work that depends on this conversation's context; anything involving secrets, credentials, deployment, or pushing.
