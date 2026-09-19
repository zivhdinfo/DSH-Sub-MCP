---
name: deepseek-subagent
description: Delegate self-contained coding tasks to a local DeepSeek agent through the `deepseek` MCP server. Use when the user says "use deepseek", asks for a DeepSeek review or second opinion, wants cheap parallel analysis across a codebase, wants DeepSeek to make a scoped code change, or asks what DeepSeek is doing / to continue, steer or stop a DeepSeek session.
allowed-tools: mcp__deepseek__deepseek_models, mcp__deepseek__deepseek_research, mcp__deepseek__deepseek_code, mcp__deepseek__deepseek_sessions, mcp__deepseek__deepseek_result, mcp__deepseek__deepseek_continue, mcp__deepseek__deepseek_steer, mcp__deepseek__deepseek_cancel
---

# DeepSeek sub-agent

The `deepseek` MCP server runs a real DeepSeek agent — with file and shell tools — locally inside the DeepSeek Harness, in a workspace you choose. You stay the orchestrator; DeepSeek does delegated work and reports back. Every delegation is a persisted **session** you can list, read, continue, steer and cancel.

## Which tool

| Tool | Agent can | Use for |
|---|---|---|
| `deepseek_research` | read, glob, grep only | Reviews, bug hunts, explaining a module, surveying a codebase. Never writes. |
| `deepseek_code` | read + write, edit, bash, pwsh | An actual scoped code change. Refuses a dirty git tree unless `allowDirty: true`. |
| `deepseek_continue` | same as the session's role (or `role` to change it) | A **follow-up turn on a finished session**: "carry on where you stopped", "now also do X", a follow-up question to a research agent. The agent keeps everything it already read and did, so this is far cheaper than a fresh task. |
| `deepseek_sessions` | — | What is running now (elapsed, tool calls, current tool) and what finished, with **why it stopped**, cost and changed files. |
| `deepseek_result` | — | The full report of a session: after `background: true`, after your call timed out, or to re-read an old one. `waitSec` waits for a running session. |
| `deepseek_steer` | — | Send a message to a **running** session (add a constraint, redirect, "wrap up and report"). |
| `deepseek_cancel` | — | Stop a running session. Files already written stay; it can be continued later. |
| `deepseek_models` | — | Current model ids from the DeepSeek API. Call once per session if you need to pick a `model`; the default is fine otherwise. |

## How to call

- `workspace`: the absolute path of the repository you are working in (your current working directory). Never a drive root or a home directory.
- `task`: make it self-contained. The DeepSeek agent cannot see this conversation. Include the relevant file paths, what "done" looks like, and any constraints. One focused objective per call.
- Independent questions → several `deepseek_research` calls in parallel. They share a cached prompt prefix, so parallel calls are cheap.
- `deepseek_code` → one change per call. Read the `Files changed` list in the result and review the diff yourself before building on it.
- **Long jobs (more than a few minutes, many files, test suites): pass `background: true`**, keep working, then `deepseek_result({ sessionId, waitSec: 120 })`. A foreground call streams progress and runs up to `timeoutSec` (default 900 s), but a background run cannot be lost to any timeout of yours.
- `maxToolCalls` defaults to 150. Raise it (up to 400) for tasks that touch many files; the agent is told its budget and warned at 80%.

## When a run stops early

The result says why: `timeout`, the loop guard (budget exhausted or the same call repeating with no edits between), `deepseek_cancel`, or you disconnecting. Partial edits are listed under `Files changed`. **Do not start over** — `deepseek_continue({ sessionId, message: "You were stopped after X; finish Y and Z, then run the tests" })` resumes with the agent's memory intact (`allowDirty` defaults to true there because the tree is dirty from the previous turn). It also works while the session is open in the DSH UI; only a session that is *busy* there is refused. Review the diff before and after.

## Reading a result

Every result begins with `model | role | workspace | session`, then `stopReason`, then `tokens: … (N% cache hit)`, then the changed-file evidence, then the agent's own report. The report is a claim, not proof — verify important findings against the source before acting on them. A result flagged as an error still lists what changed on disk and how to continue.

## When not to delegate

Trivial edits you can make faster yourself; work that depends on this conversation's context; anything involving secrets, credentials, deployment, or pushing.
