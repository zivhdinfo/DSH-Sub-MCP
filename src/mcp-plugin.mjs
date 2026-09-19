// Exposes DeepSeek agents running inside this DSH harness as MCP tools, so that
// Claude Code or Codex CLI (the parent) can delegate work to them.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Catalog } from './models.mjs';
import { Delegator, readUsage } from './delegate.mjs';
import { validateWorkspace, gitStatus, diffStatus } from './workspace.mjs';
import { home, projectRoot } from './bootstrap.mjs';

export const name = 'deepseek-sub-mcp';
export const inject = ['webServer', 'credentials', 'agents', 'subagents', 'tools', 'connection'];

const ROUTE = '/mcp';
const MAX_BODY = 1 << 20;
const DEFAULT_TIMEOUT_SEC = 900;
const tokenFile = path.join(home, 'mcp-token.txt');

async function ensureToken() {
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  return token;
}

function bearerOk(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Empty body');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const fmt = n => Number(n ?? 0).toLocaleString('en-US');

function describeUsage(usage) {
  if (!usage) return 'tokens: (accounting not available)';
  if (usage.pending) return 'tokens: accounting still settling — see the control panel for final numbers';
  const pct = (usage.cacheHitRatio * 100).toFixed(1);
  return `tokens: ${fmt(usage.inputTokens)} in (${pct}% cache hit, ${fmt(usage.uncachedInputTokens)} uncached) / ${fmt(usage.outputTokens)} out`;
}

// Append-only record of every delegation, so the control panel can show what
// ran and what it cost even though these sessions never appear in the DSH
// session list (they are not web sessions).
class History {
  constructor(file, limit = 200) {
    this.file = file;
    this.limit = limit;
    this.entries = [];
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw)) this.entries = raw.slice(-this.limit);
    } catch { /* first run */ }
  }
  async add(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    await this.persist();
  }
  async persist() {
    await writeFile(this.file, JSON.stringify(this.entries, null, 2), { mode: 0o600 }).catch(() => {});
  }
  // Accounting that was still settling when the run returned gets picked up
  // the next time anyone looks, so the panel converges to the real numbers.
  async settle(home) {
    let changed = false;
    for (const entry of this.entries) {
      if (!entry.usage?.pending || !entry.sessionId) continue;
      const usage = await readUsage(home, entry.sessionId, { waitMs: 0 });
      if (usage && !usage.pending) { entry.usage = usage; changed = true; }
    }
    if (changed) await this.persist();
  }
  recent(n = 30) { return this.entries.slice(-n).reverse(); }
}

function describeChanges(before, after) {
  if (!after) return 'Workspace is not a git repo — no file-change evidence available.';
  const changed = diffStatus(before, after);
  if (changed === null) return `Current git status: ${after.length} uncommitted entries.`;
  if (!changed.length) return 'No files changed compared to before the run.';
  return `Files changed (${changed.length}):\n` + changed.map(c => `  ${c.status || '??'} ${c.path}`).join('\n');
}

export async function apply(ctx) {
  const token = await ensureToken();
  const catalog = new Catalog(home);
  const delegator = new Delegator(ctx);
  const history = new History(path.join(home, 'delegations.json'));
  const resolveKey = async () => (await ctx.credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? null;

  await catalog.load();
  await history.load();
  // Warm the catalog from the live API without blocking boot.
  catalog.refresh(resolveKey).catch(() => {});

  async function delegate(role, { task, workspace, model, timeoutSec, allowDirty }, extra) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task must not be empty.');
    if (task.length > 32000) throw new Error('task is limited to 32,000 characters.');
    const ws = await validateWorkspace(workspace, home);
    const picked = catalog.resolve(model);

    const seconds = Math.min(Math.max(Number(timeoutSec) || DEFAULT_TIMEOUT_SEC, 30), 3600);
    const signals = [AbortSignal.timeout(seconds * 1000)];
    if (extra?.signal) signals.push(extra.signal);
    const signal = AbortSignal.any(signals);

    const before = await gitStatus(ws, signal);
    if (role === 'code' && allowDirty !== true && before && before.length) {
      throw new Error(
        `Workspace has ${before.length} uncommitted changes. `
        + 'Commit or stash first so there is always a rollback point, or call again with allowDirty: true.',
      );
    }

    const header = [`model: ${picked.model}`, `role: ${role}`, `workspace: ${ws}`];
    if (picked.warning) header.push(`WARNING: ${picked.warning}`);

    const startedAt = Date.now();
    const record = {
      time: new Date(startedAt).toISOString(),
      role,
      model: picked.model,
      workspace: ws,
      task: task.slice(0, 160),
    };

    try {
      const result = await delegator.run({
        role,
        task,
        workspace: ws,
        model: picked.model,
        signal,
      });
      const [after, usage] = await Promise.all([gitStatus(ws), readUsage(home, result.sessionId)]);
      const failed = result.stopReason !== 'completed' || !result.text;
      const changed = diffStatus(before, after);
      await history.add({
        ...record,
        status: failed ? result.stopReason : 'completed',
        durationMs: Date.now() - startedAt,
        toolCalls: result.toolCalls,
        changedFiles: changed?.length ?? null,
        usage,
        sessionId: result.sessionId,
      });
      const body = [
        header.join(' | '),
        `stopReason: ${result.stopReason} | tool calls: ${result.toolCalls} | ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        describeUsage(usage),
        ...(result.diagnostic ? [`diagnostic: ${result.diagnostic}`] : []),
        ...(failed && !result.diagnostic
          ? ['hint: check the DeepSeek API key in the GUI (Settings → Models) and your account quota.']
          : []),
        describeChanges(before, after),
        '',
        result.text || '(agent returned no text content)',
      ].join('\n');
      return { content: [{ type: 'text', text: body }], isError: failed };
    } catch (error) {
      // Report the damage even on failure: an aborted write-mode agent can leave
      // partial edits, and the parent needs to see them to recover.
      const after = await gitStatus(ws).catch(() => null);
      await history.add({
        ...record,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: String(error.message || error).slice(0, 300),
        changedFiles: diffStatus(before, after)?.length ?? null,
      });
      const body = [
        header.join(' | '),
        `FAILED: ${String(error.message || error)}`,
        describeChanges(before, after),
      ].join('\n');
      return { content: [{ type: 'text', text: body }], isError: true };
    }
  }

  function buildServer() {
    const server = new McpServer(
      { name: 'dsh-deepseek-subagent', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    server.registerTool('deepseek_models', {
      title: 'DeepSeek model list',
      description:
        'Lists the DeepSeek models currently available, fetched live from the DeepSeek API (not a hardcoded list). '
        + 'Call this before choosing the `model` parameter for the other deepseek tools. '
        + 'A model with listed=false has left the API catalog (likely retired).',
      inputSchema: {
        refresh: z.boolean().optional().describe('Force a live API probe instead of using the cache. Throttled to once per 60 seconds.'),
      },
    }, async ({ refresh }, extra) => {
      const snapshot = await catalog.refresh(resolveKey, { force: refresh === true, signal: extra?.signal });
      return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
    });

    const shared = {
      task: z.string().describe('A self-contained task with full context. The DeepSeek agent cannot see your conversation.'),
      workspace: z.string().describe('Absolute path to the project directory. Usually your current working directory.'),
      model: z.string().optional().describe('DeepSeek model id. Leave empty for the default. See deepseek_models.'),
      timeoutSec: z.number().int().min(30).max(3600).optional().describe(`Time limit in seconds, default ${DEFAULT_TIMEOUT_SEC}.`),
    };

    server.registerTool('deepseek_research', {
      title: 'DeepSeek read & analyse (read-only)',
      description:
        'Delegate an ANALYSIS task to a local DeepSeek agent. The agent can only read files (read/glob/grep); '
        + 'it does NOT edit files and does NOT run commands. Use it to review code, find bugs, explain a module, or survey a codebase.',
      inputSchema: shared,
    }, (args, extra) => delegate('research', args, extra));

    server.registerTool('deepseek_code', {
      title: 'DeepSeek edit code (read & write)',
      description:
        'Delegate a CODE-CHANGE task to a local DeepSeek agent. The agent can read, write, edit files and run commands '
        + 'inside the workspace. Refuses to run on a dirty git tree (unless allowDirty=true) so a rollback point always exists. '
        + 'The result always includes the list of changed files.',
      inputSchema: {
        ...shared,
        allowDirty: z.boolean().optional().describe('Allow running even if the workspace has uncommitted changes.'),
      },
    }, (args, extra) => delegate('code', args, extra));

    return server;
  }

  const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const mcpUrl = () => `http://127.0.0.1:${ctx.webServer.port}/mcp`;

  // Neither CLI is reliably on PATH: Claude Code's native installer drops it in
  // ~/.local/bin, and Codex commonly ships inside the Cursor/VS Code ChatGPT
  // extension. So look in the places they actually land.
  function extensionCodex() {
    const homeDir = process.env.USERPROFILE ?? '';
    const found = [];
    for (const editor of ['.cursor', '.vscode', '.vscode-insiders']) {
      const dir = path.join(homeDir, editor, 'extensions');
      if (!existsSync(dir)) continue;
      let entries = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (!entry.startsWith('openai.chatgpt-')) continue;
        for (const arch of ['windows-x86_64', 'windows-arm64']) {
          const exe = path.join(dir, entry, 'bin', arch, 'codex.exe');
          if (existsSync(exe)) found.push(exe);
        }
      }
    }
    // Newest extension build last in readdir order is not guaranteed, so sort.
    return found.sort().reverse();
  }

  function cliCandidates(target) {
    const homeDir = process.env.USERPROFILE ?? '';
    const appData = process.env.APPDATA ?? '';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const generic = [
      path.join(homeDir, '.local', 'bin', `${target}.exe`),
      path.join(appData, 'npm', `${target}.cmd`),
      path.join(localAppData, 'Programs', target, `${target}.exe`),
    ];
    const specific = target === 'codex'
      ? extensionCodex()
      : [path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')];
    return [...generic, ...specific].filter(p => p && existsSync(p));
  }

  function resolveCli(target) {
    return cliCandidates(target)[0] ?? target; // bare name falls back to PATH
  }

  function runCli(exe, args) {
    // No shell: the header argument contains spaces and a shell would split it
    // into separate tokens ("Invalid header format"). A resolved .exe needs no
    // shell; only a .cmd shim, or a bare name resolved through PATH, does.
    const useShell = exe.toLowerCase().endsWith('.cmd') || !exe.includes(path.sep);
    return new Promise(resolve => {
      let out = '';
      const child = spawn(
        useShell ? `"${exe}"` : exe,
        useShell ? args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args,
        { shell: useShell, windowsHide: true },
      );
      child.stdout.on('data', c => { out = (out + c).slice(0, 4000); });
      child.stderr.on('data', c => { out = (out + c).slice(0, 4000); });
      child.on('error', e => resolve({ ok: false, output: String(e.message) }));
      child.on('close', code => resolve({ ok: code === 0, output: out.trim() || `exit ${code}` }));
    });
  }

  // Runs the parent agent's own CLI so registration lands wherever that CLI keeps
  // its config, instead of us guessing at config file paths. Re-registering is
  // allowed: the button replaces a stale entry rather than reporting a conflict.
  async function runRegister(target) {
    const exe = resolveCli(target);
    // stdio, not http: the parent then SPAWNS the bridge, and the bridge brings
    // this harness up on demand. That is what removes the manual start step.
    // Scope must be user-wide so it works from whatever repo you open, not just
    // this project's directory — Claude Code defaults to project-local.
    const bridge = path.join(projectRoot, 'src', 'mcp-stdio.mjs');
    const addArgs = target === 'claude'
      ? ['mcp', 'add', '--scope', 'user', 'deepseek', '--', process.execPath, bridge]
      : ['mcp', 'add', 'deepseek', '--', process.execPath, bridge];

    let result = await runCli(exe, addArgs);
    if (!result.ok && /already exists/i.test(result.output)) {
      await runCli(exe, ['mcp', 'remove', 'deepseek', '--scope', 'user']);
      await runCli(exe, ['mcp', 'remove', 'deepseek']);
      result = await runCli(exe, addArgs);
      if (result.ok) result.output = `Replaced the previous registration. ${result.output}`;
    }
    return { ...result, exe };
  }

  function setupPage({ keyConfigured, snapshot, found, runs, totalRuns }) {
    const runRow = r => {
      const u = r.usage;
      const when = new Date(r.time).toLocaleTimeString('en-GB', { hour12: false });
      const status = r.status === 'completed'
        ? '<span class=ok>completed</span>'
        : `<span class=bad title="${escape(r.error ?? '')}">${escape(r.status)}</span>`;
      return `<tr title="${escape(r.task)}">
<td>${escape(when)}</td><td>${escape(r.role)}</td><td><code>${escape(r.model)}</code></td><td>${status}</td>
<td>${(r.durationMs / 1000).toFixed(0)}s</td>
<td>${u ? `${fmt(u.inputTokens)} / ${fmt(u.outputTokens)}` : '—'}</td>
<td>${u ? `<span class=${u.cacheHitRatio >= 0.5 ? 'ok' : 'warn'}>${(u.cacheHitRatio * 100).toFixed(0)}%</span>` : '—'}</td>
<td>${r.changedFiles ?? '—'}</td></tr>`;
    };
    const row = m => `<tr>
<td><label><input type=checkbox data-model="${escape(m.model)}" ${m.enabled === false ? '' : 'checked'}
 ${m.listed ? '' : 'disabled'}> <code>${escape(m.model)}</code></label></td>
<td>${escape(m.label)}</td>
<td>${m.listed ? '<span class=ok>serving</span>' : '<span class=warn>left the API</span>'}</td></tr>`;
    return `<!doctype html><meta charset=utf-8><title>DSH-Sub-MCP</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.6 system-ui,sans-serif;max-width:50rem;margin:2.5rem auto;padding:0 1rem}
h1{font-size:1.4rem;margin:0 0 .2rem}h2{font-size:1rem;margin:1.8rem 0 .5rem}
.sub{opacity:.65;margin:0 0 1.5rem}
.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;padding:.9rem 1.1rem;margin:.6rem 0}
button{font:inherit;padding:.35rem .9rem;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);background:transparent;color:inherit;cursor:pointer;margin-right:.5rem}
button:hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)}
button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
pre{background:color-mix(in srgb,currentColor 7%,transparent);padding:.6rem .8rem;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:.85em;margin:.5rem 0 0}
.ok{color:#15803d}.warn{color:#b45309}.bad{color:#b91c1c}
@media(prefers-color-scheme:dark){.ok{color:#4ade80}.warn{color:#fbbf24}.bad{color:#f87171}}
a{color:inherit}.muted{opacity:.65;font-size:.9em}
</style>
<h1>DSH-Sub-MCP</h1>
<p class=sub>DeepSeek as a sub-agent for Claude Code / Codex CLI · <a href="/">open the DSH UI</a></p>

<h2>1. DeepSeek API key</h2>
<div class=card>${keyConfigured
  ? '<span class=ok>&#10003; Configured.</span>'
  : '<span class=bad>&#10007; No key yet.</span> Open the <a href="/">DSH UI</a> &rarr; Settings &rarr; Models to add one, then reload this page.'}</div>

<h2>2. Connect a parent agent</h2>
<div class=card>
<button onclick="reg('claude',this)">Connect Claude Code</button>
<button onclick="reg('codex',this)">Connect Codex CLI</button>
<pre id=log style="display:none"></pre>
<p class=muted style="margin-bottom:0">
Claude Code: ${found.claude ? '<span class=ok>' + escape(found.claude) + '</span>' : '<span class=warn>not found — will try PATH</span>'}<br>
Codex CLI: ${found.codex ? '<span class=ok>' + escape(found.codex) + '</span>' : '<span class=warn>not found — will try PATH</span>'}<br>
Registers over <b>stdio</b>: the next time Claude/Codex starts, it <b>launches this server itself</b> — nothing to start by hand.
Click again at any time to replace an existing registration.</p>
</div>

<h2>3. Allowed models</h2>
<div class=card>
<table><tr><th>Enabled</th><th>Name</th><th>Status</th></tr>${snapshot.models.map(row).join('')}</table>
<p class=muted style="margin-bottom:0">Default: <code id=def>${escape(snapshot.defaultModel)}</code> ·
${snapshot.catalogStale ? 'not yet verified against the API' : 'synced at ' + escape(snapshot.catalogCheckedAt)}
${snapshot.message ? '<br>' + escape(snapshot.message) : ''}<br>
A disabled model is refused if Claude/Codex requests it.</p>
</div>

<h2>4. Recent delegations</h2>
<div class=card>
${runs.length ? `<table><tr><th>When</th><th>Role</th><th>Model</th><th>Status</th><th>Time</th><th>Tokens in / out</th><th>Cache hit</th><th>Files</th></tr>${runs.map(runRow).join('')}</table>
<p class=muted style="margin-bottom:0">${escape(runs.length)} most recent, of ${escape(totalRuns)} recorded. Sessions live under <code>.dsh-sub/sessions/</code>; add the workspace in the DSH sidebar to browse them there.</p>`
  : '<span class=muted>No delegations yet. They will appear here as Claude/Codex calls the tools.</span>'}
</div>

<h2>How to use</h2>
<div class=card>In Claude Code, just ask naturally:<br>
<em>"use deepseek to review the auth module for bugs"</em> &rarr; <code>deepseek_research</code><br>
<em>"use deepseek to fix that bug"</em> &rarr; <code>deepseek_code</code><br><br>
The server starts on demand. To stop it fully, end the node process holding port 3083.</div>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
async function post(path, body){
  const r = await fetch(path + '?key=' + encodeURIComponent(KEY), {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  return r.json();
}
async function reg(target, btn){
  const log = document.getElementById('log');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Connecting...';
  try{
    const r = await post('/setup/register', {target});
    log.style.display='block';
    log.textContent = (r.ok ? '✓ ' : '✗ ') + target + ': ' + (r.output || '');
  } catch(e){ log.style.display='block'; log.textContent = '✗ ' + e; }
  btn.disabled = false; btn.textContent = label;
}
document.querySelectorAll('input[data-model]').forEach(box => {
  box.addEventListener('change', async () => {
    const r = await post('/setup/model', {model: box.dataset.model, enabled: box.checked});
    if (r.error){ box.checked = !box.checked; alert(r.error); return; }
    document.getElementById('def').textContent = r.defaultModel;
  });
});
</script>`;
  }

  function authorized(req) {
    const supplied = new URL(req.url, 'http://127.0.0.1').searchParams.get('key') ?? '';
    const keyBuf = Buffer.from(supplied);
    const expected = Buffer.from(token);
    const keyOk = keyBuf.length === expected.length && timingSafeEqual(keyBuf, expected);
    return keyOk || !ctx.connection.requestRejection(req);
  }

  const disposeSetup = ctx.webServer.register({
    kind: 'prefix',
    path: '/setup',
    async handler(req, res) {
      // The page displays the bearer token, so it needs that same token to open —
      // the model the harness already uses for its own ?token= URLs. An existing
      // authenticated browser session is accepted too.
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not authenticated. Reopen the /setup?key=... link printed by the terminal.');
        return;
      }
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'POST' && route === '/setup/register') {
        const { target } = await readJson(req).catch(() => ({}));
        if (target !== 'claude' && target !== 'codex') return json(400, { error: 'invalid target' });
        return json(200, await runRegister(target));
      }

      if (req.method === 'POST' && route === '/setup/model') {
        const { model, enabled } = await readJson(req).catch(() => ({}));
        try {
          const snapshot = await catalog.setEnabled(model, enabled === true);
          return json(200, { defaultModel: snapshot.defaultModel });
        } catch (error) {
          return json(200, { error: String(error.message || error) });
        }
      }

      if (req.method !== 'GET' || route !== '/setup') {
        return json(404, { error: 'not found' });
      }

      await history.settle(home);
      const keyConfigured = await resolveKey().then(Boolean).catch(() => false);
      const snapshot = keyConfigured ? await catalog.refresh(resolveKey) : catalog.snapshot();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(setupPage({
        keyConfigured,
        snapshot,
        found: { claude: cliCandidates("claude")[0] ?? null, codex: cliCandidates("codex")[0] ?? null },
        runs: history.recent(30),
        totalRuns: history.entries.length,
      }));
    },
  });

  // Put the entry point inside the DSH interface itself, the same way DSH Team
  // surfaces its dashboard, so this is not a page you can only reach from a URL.
  const disposeTap = ctx.webServer.tapIndex(html => html.replace(
    '</body>',
    `<a href="/setup?key=${token}" style="position:fixed;right:14px;bottom:14px;z-index:99999;`
    + 'font:13px system-ui,sans-serif;padding:.45rem .8rem;border-radius:999px;text-decoration:none;'
    + 'background:#1f2937;color:#fff;opacity:.85;box-shadow:0 2px 8px #0004">DeepSeek sub-agent</a></body>',
  ));

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req, res) {
      if (!bearerOk(req, token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      // A browser cannot send Authorization cross-origin without a preflight we
      // never answer, so requiring no Origin blocks DNS-rebinding attempts.
      if (req.headers.origin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'origin not allowed' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message || error) }));
        return;
      }

      // Stateless transports throw if reused, so both server and transport are
      // built per request.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const close = () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      };
      res.on('close', close);
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        close();
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error.message || error) }));
        }
      }
    },
  });

  ctx.on('dispose', () => { dispose(); disposeSetup(); disposeTap?.(); });
}
