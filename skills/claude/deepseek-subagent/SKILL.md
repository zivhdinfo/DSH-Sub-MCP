---
name: deepseek-subagent
description: Delegate self-contained coding tasks to a local DeepSeek agent through the `deepseek` MCP server. Use when the user says "use deepseek", asks for a DeepSeek review or second opinion, wants cheap parallel analysis across a codebase, or wants DeepSeek to make a scoped code change.
allowed-tools: mcp__deepseek__deepseek_models, mcp__deepseek__deepseek_research, mcp__deepseek__deepseek_code
---

# DeepSeek sub-agent

The `deepseek` MCP server runs a real DeepSeek agent — with file and shell tools — locally inside the DeepSeek Harness, in a workspace you choose. You stay the orchestrator; DeepSeek does delegated work and reports back.

## Which tool

| Tool | Agent can | Use for |
|---|---|---|
| `deepseek_research` | read, glob, grep only | Reviews, bug hunts, explaining a module, surveying a codebase. Never writes. |
| `deepseek_code` | read + write, edit, bash, pwsh | An actual scoped code change. Refuses a dirty git tree unless `allowDirty: true`. |
| `deepseek_models` | — | Current model ids from the DeepSeek API. Call once per session if you need to pick a `model`; the default is fine otherwise. |

## How to call

- `workspace`: the absolute path of the repository you are working in (your current working directory). Never a drive root or a home directory.
- `task`: make it self-contained. The DeepSeek agent cannot see this conversation. Include the relevant file paths, what "done" looks like, and any constraints. One focused objective per call.
- Independent questions → several `deepseek_research` calls in parallel. They share a cached prompt prefix, so parallel calls are cheap.
- `deepseek_code` → one change per call. Read the `Files changed` list in the result and review the diff yourself before building on it.
- `timeoutSec` defaults to 900. Raise it only for genuinely long jobs.

## Reading a result

Every result begins with `model | role | workspace`, then `stopReason`, then `tokens: … (N% cache hit)`, then the changed-file evidence, then the agent's own report. The report is a claim, not proof — verify important findings against the source before acting on them. A result flagged as an error still lists what changed on disk.

## When not to delegate

Trivial edits you can make faster yourself; work that depends on this conversation's context; anything involving secrets, credentials, deployment, or pushing.
