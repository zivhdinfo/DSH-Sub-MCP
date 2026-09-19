<!-- dsh-sub-mcp:start -->
## DeepSeek sub-agent (MCP server `deepseek`)

The `deepseek` MCP server runs a real DeepSeek agent, with file and shell tools, locally in a workspace you choose. Delegate to it when the user says "use deepseek", asks for a DeepSeek review or second opinion, wants cheap parallel analysis of a codebase, wants DeepSeek to make a scoped code change, or asks what DeepSeek is doing / to continue, steer or stop a DeepSeek session. Every delegation is a persisted session.

- `deepseek_research(task, workspace)` — read-only (read/glob/grep). Reviews, bug hunts, explanations, surveys. Never writes.
- `deepseek_code(task, workspace, allowDirty?)` — read/write plus bash/pwsh. One scoped change per call. Refuses a dirty git tree unless `allowDirty: true`.
- `deepseek_continue(sessionId, message, role?)` — a follow-up turn on a finished session; the agent keeps everything it already read and did. Use it to carry on after an early stop or to ask a follow-up — never start over.
- `deepseek_sessions(workspace?, status?)` — running sessions (elapsed, tool calls, current tool) and finished ones with why they stopped, cost and changed files.
- `deepseek_result(sessionId, waitSec?)` — the full report of a session (after `background: true`, after a timeout, or to re-read).
- `deepseek_steer(sessionId, message)` / `deepseek_cancel(sessionId)` — message or stop a running session.
- `deepseek_models()` — current model ids from the DeepSeek API; only needed if you want to pick a `model`.

Rules: `workspace` is the absolute path of the repo you are in (never a drive root or home). `task` must be self-contained — the agent cannot see this conversation — so include file paths, the definition of done, and constraints. Run independent research calls in parallel; they share a cached prompt prefix. For long jobs pass `background: true` and collect with `deepseek_result`. `maxToolCalls` (default 150, max 400) is the agent's tool budget. Treat the agent's report as a claim and verify important findings yourself. Results start with `model | role | workspace | session`, then `stopReason`, `tokens (N% cache hit)`, the list of changed files, and — for an early stop — why and how to continue. Do not delegate trivial edits, context-dependent work, or anything touching secrets or deployment.
<!-- dsh-sub-mcp:end -->
