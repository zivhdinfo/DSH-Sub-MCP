<!-- dsh-sub-mcp:start -->
## DeepSeek Harness sub-agent (MCP server `deepseek`)

The `deepseek` MCP server runs a real agent, with file and shell tools, locally in the DeepSeek Harness in a workspace you choose, on any model the user configured there (DeepSeek, GLM via a custom provider, …). Delegate to it when the user says "use deepseek", asks for a DeepSeek/GLM review or second opinion, wants cheap parallel analysis of a codebase, wants a sub-agent to make a scoped code change, or asks what DeepSeek is doing / to continue, steer or stop a DeepSeek session. Every delegation is a persisted session.

- `deepseek_research(task, workspace, model?, reasoningEffort?, skills?)` — read-only (read/glob/grep). Reviews, bug hunts, explanations, surveys. Never writes.
- `deepseek_code(task, workspace, model?, reasoningEffort?, skills?, allowDirty?)` — read/write plus bash/pwsh. One scoped change per call. Refuses a dirty git tree unless `allowDirty: true`.
- `deepseek_continue(sessionId, message, role?, model?, skills?)` — a follow-up turn on a finished session; the agent keeps everything it already read and did and stays on its model unless `model` is passed. Use it to carry on after an early stop or to ask a follow-up — never start over.
- `deepseek_sessions(workspace?, status?)` — running sessions (elapsed, tool calls, current tool) and finished ones with why they stopped, cost and changed files.
- `deepseek_result(sessionId, waitSec?)` — the full report of a session (after `background: true`, after a timeout, or to re-read).
- `deepseek_steer(sessionId, message)` / `deepseek_cancel(sessionId)` — message or stop a running session.
- `deepseek_models()` — every provider active on the harness with its models, key status and which are enabled. `deepseek_skills()` — the skills that can be attached by name.

Model: `model` is one string `provider/model` (e.g. `deepseek-official/deepseek-flash`, `zai/glm-5.3`). With exactly one model enabled, omit it. With more than one enabled, a call without `model` is refused with `MODEL REQUIRED` and the list — ask the user in chat which one to use, then call again with `model` set; never pick one yourself. Remember the choice for the rest of the conversation.

Reasoning effort: `reasoningEffort` defaults to `high`; pass `max` for hard tasks (subtle bugs, cross-cutting refactors, anything where a wrong answer is expensive), `low`/`off` only for trivial lookups. Levels depend on the model (`deepseek_models` lists them).

Skills: when one of your skills is relevant, pass its name in `skills: ["name"]` instead of pasting its content into `task`; the server registers the SKILL.md in the agent's session and the agent loads it with its `skill` tool. Pick 1–3; unknown names are refused (see `deepseek_skills`).

Rules: `workspace` is the absolute path of the repo you are in (never a drive root or home). `task` must be self-contained — the agent cannot see this conversation — so include file paths, the definition of done, and constraints. Run independent research calls in parallel; they share a cached prompt prefix. For long jobs pass `background: true` and collect with `deepseek_result`. `maxToolCalls` (default 150, max 400) is the agent's tool budget. Treat the agent's report as a claim and verify important findings yourself. Results start with `model | effort | role | workspace | session`, then `stopReason`, `tokens (N% cache hit)`, the list of changed files, and — for an early stop — why and how to continue. Do not delegate trivial edits, context-dependent work, or anything touching secrets or deployment.
<!-- dsh-sub-mcp:end -->
