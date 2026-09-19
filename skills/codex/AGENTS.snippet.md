<!-- dsh-sub-mcp:start -->
## DeepSeek sub-agent (MCP server `deepseek`)

The `deepseek` MCP server runs a real DeepSeek agent, with file and shell tools, locally in a workspace you choose. Delegate to it when the user says "use deepseek", asks for a DeepSeek review or second opinion, wants cheap parallel analysis of a codebase, or wants DeepSeek to make a scoped code change.

- `deepseek_research(task, workspace)` — read-only (read/glob/grep). Reviews, bug hunts, explanations, surveys. Never writes.
- `deepseek_code(task, workspace, allowDirty?)` — read/write plus bash/pwsh. One scoped change per call. Refuses a dirty git tree unless `allowDirty: true`.
- `deepseek_models()` — current model ids from the DeepSeek API; only needed if you want to pick a `model`.

Rules: `workspace` is the absolute path of the repo you are in (never a drive root or home). `task` must be self-contained — the agent cannot see this conversation — so include file paths, the definition of done, and constraints. Run independent research calls in parallel; they share a cached prompt prefix. Treat the agent's report as a claim and verify important findings yourself. Results start with `model | role | workspace`, then `stopReason`, `tokens (N% cache hit)`, and the list of changed files. Do not delegate trivial edits, context-dependent work, or anything touching secrets or deployment.
<!-- dsh-sub-mcp:end -->
