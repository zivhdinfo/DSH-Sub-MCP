// Exposes DeepSeek agents running inside this DSH harness as MCP tools, so that
// Claude Code or Codex CLI (the parent) can delegate work to them.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Catalog } from './models.mjs';
import { Delegator, readUsage, usageDelta, TOOL_CALL_BOUNDS, DEFAULT_LIMITS } from './delegate.mjs';
import { validateWorkspace, gitStatus, diffStatus } from './workspace.mjs';
import { home, projectRoot } from './bootstrap.mjs';

export const name = 'deepseek-sub-mcp';
export const inject = ['webServer', 'credentials', 'agents', 'tools', 'connection', 'workspaceRegistry', 'sessionTitle'];

const ROUTE = '/mcp';
// Fragment the launcher appends so the client plugin opens our Settings section.
const SETTINGS_HASH = '#settings/deepseek-subagent';
const MAX_BODY = 1 << 20;
const DEFAULT_TIMEOUT_SEC = 900;
// How often a running foreground call reports progress to the parent even when
// the agent is inside one long tool call (a test suite, say).
const PROGRESS_INTERVAL_MS = 10000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenFile = path.join(home, 'mcp-token.txt');
const resultsDir = path.join(home, 'results');

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
  if (usage.pending) return 'tokens: accounting still settling — see Settings → Sub-agent in the DSH UI for final numbers';
  const pct = (usage.cacheHitRatio * 100).toFixed(1);
  return `tokens: ${fmt(usage.inputTokens)} in (${pct}% cache hit, ${fmt(usage.uncachedInputTokens)} uncached) / ${fmt(usage.outputTokens)} out`;
}

// Append-only record of every delegation with its cost. The DSH sidebar shows
// the sessions themselves; this is the compact cross-run view with cache ratios.
// A run is recorded when it STARTS (status "running") and patched when it ends,
// so the list is truthful while a background run is in flight and after a
// crash: anything still "running" when the harness boots did not finish.
class History {
  constructor(file, limit = 300) {
    this.file = file;
    this.limit = limit;
    this.entries = [];
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw)) this.entries = raw.slice(-this.limit);
    } catch { /* first run */ }
    let orphaned = false;
    for (const entry of this.entries) {
      if (entry.status !== 'running') continue;
      entry.status = 'interrupted';
      entry.reason = 'the harness restarted while the run was in flight';
      orphaned = true;
    }
    if (orphaned) await this.persist();
  }
  async start(entry) {
    const record = { id: randomUUID(), ...entry, status: 'running' };
    this.entries.push(record);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    await this.persist();
    return record;
  }
  async finish(record, patch) {
    Object.assign(record, patch);
    await this.persist();
  }
  async persist() {
    await writeFile(this.file, JSON.stringify(this.entries, null, 2), { mode: 0o600 }).catch(() => {});
  }
  latestForSession(sessionId) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].sessionId === sessionId) return this.entries[i];
    }
    return undefined;
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
  // Forget every turn of the given sessions. Callers refuse running ones first.
  async remove(sessionIds) {
    const drop = new Set(sessionIds);
    const before = this.entries.length;
    this.entries = this.entries.filter(e => !drop.has(e.sessionId));
    if (this.entries.length !== before) await this.persist();
    return before - this.entries.length;
  }
  // Distinct (workspace, sessionId) pairs, newest last, for sidebar grouping.
  sessionWorkspaces() {
    const pairs = new Map();
    for (const e of this.entries) if (e.sessionId && e.workspace) pairs.set(e.sessionId, e.workspace);
    return pairs;
  }
}

// The agent's final report, kept per session so the parent can read it after
// a background run, after its own timeout, or from a later conversation.
async function saveResult(sessionId, result) {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, `${sessionId}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
}
async function loadResult(sessionId) {
  try { return JSON.parse(await readFile(path.join(resultsDir, `${sessionId}.json`), 'utf8')); } catch { return null; }
}
async function deleteResult(sessionId) {
  await rm(path.join(resultsDir, `${sessionId}.json`), { force: true });
}

function describeChanges(before, after) {
  if (!after) return 'Workspace is not a git repo — no file-change evidence available.';
  const changed = diffStatus(before, after);
  if (changed === null) return `Current git status: ${after.length} uncommitted entries.`;
  if (!changed.length) return 'No files changed compared to before the run.';
  return `Files changed (${changed.length}):\n` + changed.map(c => `  ${c.status || '??'} ${c.path}`).join('\n');
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Sidebar title: "[Code] - store-main: fix the nav overflow…". The mode and the
// project folder come first so a list of sessions scans by eye; the harness
// caps titles at 80 bytes, so the task excerpt is short.
const MODE_LABEL = { code: 'Code', research: 'Research' };
function sessionTitleFor(role, workspace, task) {
  const folder = path.basename(workspace) || workspace;
  const excerpt = task.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[${MODE_LABEL[role] ?? role}] - ${folder}: ${excerpt}`;
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('sessionId must be the id shown by deepseek_sessions or a previous result.');
  return value.toLowerCase();
}

export async function apply(ctx) {
  const token = await ensureToken();
  const catalog = new Catalog(home);
  const delegator = new Delegator(ctx);
  const history = new History(path.join(home, 'delegations.json'));
  const resolveKey = async () => (await ctx.credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? null;
  // sessionId → promise of the finished body, so deepseek_result can wait on a
  // run that is still in flight (background, or one the parent gave up on).
  const pending = new Map();

  await catalog.load();
  await history.load();
  // Warm the catalog from the live API without blocking boot.
  catalog.refresh(resolveKey).catch(() => {});
  // Earlier versions created the workspace but never attached the session to
  // it, so their runs sit under "Ungrouped" in the sidebar. Adopt them once
  // the harness is up; attaching is idempotent.
  setTimeout(() => delegator.adoptSessions(history.sessionWorkspaces()).catch(() => {}), 3000).unref?.();

  const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });
  const json = value => text(JSON.stringify(value, null, 2));

  // One delegation turn: a fresh session, or a follow-up turn on a persisted
  // one (`resume` is that session's latest history entry).
  async function startRun({ role, task, workspace, model, timeoutSec, allowDirty, background, maxToolCalls, resume }, extra) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task must not be empty.');
    if (task.length > 32000) throw new Error('task is limited to 32,000 characters.');
    const ws = await validateWorkspace(workspace, home);
    const picked = catalog.resolve(model);

    const seconds = Math.min(Math.max(Number(timeoutSec) || DEFAULT_TIMEOUT_SEC, 30), 3600);
    const budget = maxToolCalls === undefined
      ? undefined
      : Math.min(Math.max(Math.floor(Number(maxToolCalls)), TOOL_CALL_BOUNDS.min), TOOL_CALL_BOUNDS.max);
    const timeout = AbortSignal.timeout(seconds * 1000);
    // A foreground run dies with its request (the parent cancelled, timed out,
    // or went away). A background run answers only to timeoutSec and deepseek_cancel.
    const client = background ? undefined : extra?.signal;

    const before = await gitStatus(ws, timeout);
    if (role === 'code' && allowDirty !== true && before && before.length) {
      throw new Error(
        `Workspace has ${before.length} uncommitted changes. `
        + 'Commit or stash first so there is always a rollback point, or call again with allowDirty: true.',
      );
    }

    const sessionId = resume ? resume.sessionId : randomUUID();
    const turn = resume ? (resume.turn ?? 1) + 1 : 1;
    const header = [`model: ${picked.model}`, `role: ${role}`, `workspace: ${ws}`, `session: ${sessionId}${turn > 1 ? ` (turn ${turn})` : ''}`];
    if (picked.warning) header.push(`WARNING: ${picked.warning}`);

    const startedAt = Date.now();
    const record = await history.start({
      time: new Date(startedAt).toISOString(),
      role,
      model: picked.model,
      workspace: ws,
      task: task.slice(0, 160),
      sessionId,
      turn,
      background: Boolean(background),
    });
    const usageBefore = resume ? await readUsage(home, sessionId, { waitMs: 0 }) : null;

    // Progress notifications keep the parent's idle timer alive during a long
    // call and show what the agent is doing right now.
    const progressToken = extra?._meta?.progressToken;
    let lastProgress = 0;
    const report = (run, force = false) => {
      if (progressToken === undefined || background || !extra?.sendNotification) return;
      const now = Date.now();
      if (!force && now - lastProgress < 3000) return;
      lastProgress = now;
      const s = run.snapshot();
      const message = `deepseek ${role} · ${Math.round(s.elapsedMs / 1000)}s · ${s.toolCalls} tool calls${s.lastTool ? ` · ${s.lastTool}` : ''}`;
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: s.toolCalls, message } }).catch(() => {});
    };

    let ticker = null;
    const done = (async () => {
      try {
        const result = await delegator.run({
          role,
          task,
          workspace: ws,
          model: picked.model,
          signals: { timeout, 'client-disconnect': client },
          title: sessionTitleFor(role, ws, task),
          maxToolCalls: budget,
          sessionId,
          resumeSessionId: resume ? sessionId : undefined,
          turn,
          onStart: run => {
            run.onProgress = () => report(run);
            report(run, true);
            ticker = setInterval(() => report(run, true), PROGRESS_INTERVAL_MS);
          },
        });
        const [after, usageTotal] = await Promise.all([gitStatus(ws), readUsage(home, sessionId, { after: usageBefore })]);
        const usage = resume ? usageDelta(usageTotal, usageBefore) : usageTotal;
        const failed = result.stopReason !== 'completed' || !result.text;
        const changed = diffStatus(before, after);
        const durationMs = Date.now() - startedAt;
        const status = failed ? result.stopReason : 'completed';
        // A turn run on the agent the DSH UI holds uses that agent's model.
        const usedModel = result.model ?? picked.model;
        header[0] = `model: ${usedModel}`;
        const body = [
          header.join(' | '),
          `stopReason: ${result.stopReason} | tool calls: ${result.toolCalls} | ${(durationMs / 1000).toFixed(1)}s`,
          describeUsage(usage),
          ...(result.diagnostic ? [`diagnostic: ${result.diagnostic}`] : []),
          ...(failed && !result.diagnostic
            ? ['hint: check the DeepSeek API key in the GUI (Settings → Models) and your account quota.']
            : []),
          ...(failed ? [`To pick up where it stopped: deepseek_continue({ sessionId: "${sessionId}", message: "..." })`] : []),
          describeChanges(before, after),
          '',
          result.text || '(agent returned no text content)',
        ].join('\n');
        await history.finish(record, {
          status,
          model: usedModel,
          reason: result.diagnostic || undefined,
          durationMs,
          toolCalls: result.toolCalls,
          changedFiles: changed?.length ?? null,
          usage,
        });
        await saveResult(sessionId, {
          sessionId, turn, time: record.time, role, model: usedModel, workspace: ws, task: task.slice(0, 160),
          status, stopReason: result.stopReason, abortReason: result.abortReason, diagnostic: result.diagnostic,
          durationMs, toolCalls: result.toolCalls, changedFiles: changed ?? null, usage, text: result.text, body,
        }).catch(() => {});
        return { body, failed };
      } catch (error) {
        // Report the damage even on failure: an aborted write-mode agent can leave
        // partial edits, and the parent needs to see them to recover.
        const message = String(error.message || error);
        const after = await gitStatus(ws).catch(() => null);
        const changed = diffStatus(before, after);
        const durationMs = Date.now() - startedAt;
        const body = [header.join(' | '), `FAILED: ${message}`, describeChanges(before, after)].join('\n');
        await history.finish(record, { status: 'failed', error: message.slice(0, 300), durationMs, changedFiles: changed?.length ?? null });
        await saveResult(sessionId, {
          sessionId, turn, time: record.time, role, model: picked.model, workspace: ws, task: task.slice(0, 160),
          status: 'failed', error: message, durationMs, changedFiles: changed ?? null, text: '', body,
        }).catch(() => {});
        return { body, failed: true };
      } finally {
        if (ticker) clearInterval(ticker);
      }
    })();
    pending.set(sessionId, done);
    const release = () => { if (pending.get(sessionId) === done) pending.delete(sessionId); };
    done.then(release, release);

    if (background) {
      return text([
        header.join(' | '),
        'status: running in the background',
        `Poll with deepseek_result({ sessionId: "${sessionId}", waitSec: 60 }) or list with deepseek_sessions. `
        + `Stop it with deepseek_cancel; nudge it with deepseek_steer. It stops on its own after ${seconds}s.`,
      ].join('\n'));
    }
    const { body, failed } = await done;
    return text(body, failed);
  }

  function delegate(role, args, extra) {
    return startRun({ role, ...args }, extra);
  }

  // The cross-run view: live runs first, then the newest record per session.
  function listSessions({ workspace, status = 'all', limit = 20 } = {}) {
    const rows = [];
    const seen = new Set();
    // The first record of a session carries the original task; later turns
    // only carry their follow-up message.
    const turns = new Map();
    const first = new Map();
    for (const e of history.entries) {
      if (!e.sessionId) continue;
      turns.set(e.sessionId, (turns.get(e.sessionId) ?? 0) + 1);
      if (!first.has(e.sessionId)) first.set(e.sessionId, e);
    }
    for (const run of delegator.list()) {
      const s = run.snapshot();
      const entry = history.latestForSession(run.sessionId);
      const origin = first.get(run.sessionId);
      rows.push({
        ...s,
        task: origin?.task ?? run.task.slice(0, 160),
        ...(origin && origin !== entry ? { lastMessage: entry?.task } : {}),
        time: entry?.time ?? new Date(run.startedAt).toISOString(),
        turns: turns.get(run.sessionId) ?? 1,
        background: entry?.background ?? false,
      });
      seen.add(run.sessionId);
    }
    for (let i = history.entries.length - 1; i >= 0; i--) {
      const e = history.entries[i];
      if (!e.sessionId || seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      const origin = first.get(e.sessionId);
      rows.push({
        sessionId: e.sessionId,
        status: e.status,
        reason: e.reason ?? e.error ?? undefined,
        role: e.role,
        model: e.model,
        workspace: e.workspace,
        task: origin.task,
        ...(origin !== e ? { lastMessage: e.task } : {}),
        time: e.time,
        turn: e.turn ?? 1,
        turns: turns.get(e.sessionId),
        durationMs: e.durationMs ?? null,
        toolCalls: e.toolCalls ?? null,
        changedFiles: e.changedFiles ?? null,
        usage: e.usage ? { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, cacheHitRatio: Number((e.usage.cacheHitRatio ?? 0).toFixed(3)) } : null,
        background: e.background ?? false,
        continuable: e.status !== 'running',
      });
    }
    return rows
      .filter(r => !workspace || samePath(r.workspace, workspace))
      .filter(r => status === 'all' || (status === 'running' ? r.status === 'running' : r.status !== 'running'))
      .slice(0, limit);
  }

  function buildServer() {
    const server = new McpServer(
      { name: 'dsh-deepseek-subagent', version: '1.1.0' },
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
      return json(snapshot);
    });

    const runOptions = {
      model: z.string().optional().describe('DeepSeek model id. Leave empty for the default. See deepseek_models.'),
      timeoutSec: z.number().int().min(30).max(3600).optional().describe(`Time limit in seconds, default ${DEFAULT_TIMEOUT_SEC}.`),
      maxToolCalls: z.number().int().min(TOOL_CALL_BOUNDS.min).max(TOOL_CALL_BOUNDS.max).optional()
        .describe(`Tool call budget for the agent, default ${DEFAULT_LIMITS.maxToolCalls}. Raise it for tasks touching many files.`),
      background: z.boolean().optional()
        .describe('Return immediately with the sessionId and let the agent run on. Read the report later with deepseek_result. Use for anything that may take more than a few minutes.'),
    };
    const shared = {
      task: z.string().describe('A self-contained task with full context. The DeepSeek agent cannot see your conversation.'),
      workspace: z.string().describe('Absolute path to the project directory. Usually your current working directory.'),
      ...runOptions,
    };

    server.registerTool('deepseek_research', {
      title: 'DeepSeek read & analyse (read-only)',
      description:
        'Delegate an ANALYSIS task to a local DeepSeek agent. The agent can only read files (read/glob/grep); '
        + 'it does NOT edit files and does NOT run commands. Use it to review code, find bugs, explain a module, or survey a codebase. '
        + 'The result names the sessionId; deepseek_continue can ask that same agent follow-up questions.',
      inputSchema: shared,
    }, (args, extra) => delegate('research', args, extra));

    server.registerTool('deepseek_code', {
      title: 'DeepSeek edit code (read & write)',
      description:
        'Delegate a CODE-CHANGE task to a local DeepSeek agent. The agent can read, write, edit files and run commands '
        + 'inside the workspace. Refuses to run on a dirty git tree (unless allowDirty=true) so a rollback point always exists. '
        + 'The result always includes the list of changed files and the sessionId, which deepseek_continue can resume if the run stopped early.',
      inputSchema: {
        ...shared,
        allowDirty: z.boolean().optional().describe('Allow running even if the workspace has uncommitted changes.'),
      },
    }, (args, extra) => delegate('code', args, extra));

    server.registerTool('deepseek_sessions', {
      title: 'List DeepSeek sessions',
      description:
        'Lists delegations made through this server: running ones first (with elapsed time, tool calls so far and the last tool), '
        + 'then finished ones newest first with status, why they stopped, duration, cost and changed-file count. '
        + 'Any finished session can be resumed with deepseek_continue; a running one can be stopped with deepseek_cancel or nudged with deepseek_steer.',
      inputSchema: {
        workspace: z.string().optional().describe('Only sessions for this workspace path.'),
        status: z.enum(['running', 'finished', 'all']).optional().describe('Filter by state. Default all.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum rows, default 20.'),
      },
    }, async args => json(listSessions(args)));

    server.registerTool('deepseek_result', {
      title: 'Read a DeepSeek session result',
      description:
        'Returns the final report of a delegation: the same text deepseek_research/deepseek_code return, including stopReason, cost and changed files. '
        + 'For a run that is still going, waits up to waitSec for it to finish and otherwise reports its progress. '
        + 'Use it after background: true, after your own call timed out, or to re-read an earlier result.',
      inputSchema: {
        sessionId: z.string().describe('Session id from a result header or deepseek_sessions.'),
        waitSec: z.number().int().min(0).max(600).optional().describe('How long to wait for a running session before reporting progress instead. Default 0.'),
      },
    }, async ({ sessionId, waitSec }) => {
      const id = requireSessionId(sessionId);
      const inFlight = pending.get(id);
      if (inFlight) {
        const wait = Math.min(Math.max(Number(waitSec) || 0, 0), 600) * 1000;
        const outcome = wait > 0
          ? await Promise.race([inFlight, new Promise(r => setTimeout(() => r(undefined), wait))])
          : undefined;
        if (outcome) return text(outcome.body, outcome.failed);
        const run = delegator.get(id);
        return json({ ...(run ? run.snapshot() : { sessionId: id, status: 'running' }), hint: 'still running — call again with waitSec, or deepseek_cancel to stop it' });
      }
      const stored = await loadResult(id);
      if (stored) return text(stored.body, stored.status !== 'completed');
      const entry = history.latestForSession(id);
      if (!entry) throw new Error(`Unknown session ${id}. deepseek_sessions lists the ones this server knows.`);
      return json({ ...entry, note: 'no report is stored for this session (it predates result storage, or the harness restarted mid-run); the session itself can still be continued' });
    });

    server.registerTool('deepseek_continue', {
      title: 'Continue a DeepSeek session',
      description:
        'Sends a follow-up turn to a FINISHED delegation and returns its new report. The agent resumes with everything it already read and did, '
        + 'so this is the cheap way to say "carry on where you stopped", "now also handle X", or to ask a research agent a follow-up question. '
        + 'The tree is usually dirty from the previous turn, so allowDirty defaults to true here.',
      inputSchema: {
        sessionId: z.string().describe('Session id from a result header or deepseek_sessions.'),
        message: z.string().describe('The follow-up instruction. Refer to the previous work; do not repeat the whole original task.'),
        role: z.enum(['research', 'code']).optional().describe('Change the agent\'s capability for this turn. Default: the role the session was started with.'),
        allowDirty: z.boolean().optional().describe('Default true for a continuation.'),
        ...runOptions,
      },
    }, async ({ sessionId, message, role, allowDirty, ...options }, extra) => {
      const id = requireSessionId(sessionId);
      if (delegator.get(id)) throw new Error(`Session ${id} is still running. Use deepseek_steer to talk to it, or deepseek_cancel first.`);
      const entry = history.latestForSession(id);
      if (!entry) throw new Error(`Unknown session ${id}. Only sessions created by this server can be continued; deepseek_sessions lists them.`);
      return startRun({
        ...options,
        role: role ?? entry.role,
        task: message,
        workspace: entry.workspace,
        model: options.model ?? entry.model,
        allowDirty: allowDirty ?? true,
        resume: entry,
      }, extra);
    });

    server.registerTool('deepseek_cancel', {
      title: 'Stop a running DeepSeek session',
      description: 'Stops a delegation that is still running (background or foreground). Files it already wrote stay on disk; the result records why it stopped and can be continued later.',
      inputSchema: { sessionId: z.string().describe('Session id from deepseek_sessions.') },
    }, async ({ sessionId }) => {
      const id = requireSessionId(sessionId);
      const run = delegator.get(id);
      if (!run) throw new Error(`Session ${id} is not running.`);
      const first = run.stop('cancelled');
      return text(first
        ? `Cancel requested for ${id}. deepseek_result will show how it ended and what changed on disk.`
        : `Session ${id} is already stopping (${run.abortReason}).`);
    });

    server.registerTool('deepseek_steer', {
      title: 'Send a message to a running DeepSeek session',
      description: 'Injects an instruction into a delegation that is still running; the agent reads it at its next step. Use it to add a constraint, redirect it, or tell it to wrap up and report.',
      inputSchema: {
        sessionId: z.string().describe('Session id from deepseek_sessions.'),
        message: z.string().describe('What to tell the agent.'),
      },
    }, async ({ sessionId, message }) => {
      const id = requireSessionId(sessionId);
      if (typeof message !== 'string' || !message.trim()) throw new Error('message must not be empty.');
      const run = delegator.get(id);
      if (!run) throw new Error(`Session ${id} is not running; use deepseek_continue for a finished session.`);
      run.steer(`Message from the parent agent while you work:\n${message.slice(0, 8000)}`);
      return text(`Delivered to ${id}; the agent picks it up at its next step.`);
    });

    return server;
  }

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

  // Registering the server only tells the parent the tools exist. The skill (or
  // AGENTS.md section, for Codex) is what teaches it when and how to use them.
  const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const skillSources = {
    claude: path.join(projectRoot, 'skills', 'claude', 'deepseek-subagent', 'SKILL.md'),
    codex: path.join(projectRoot, 'skills', 'codex', 'AGENTS.snippet.md'),
  };
  const guidanceDest = {
    claude: () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'skills', 'deepseek-subagent', 'SKILL.md'),
    codex: () => path.join(process.env.CODEX_HOME || path.join(homeDir, '.codex'), 'AGENTS.md'),
  };
  const CODEX_FENCE = /<!-- dsh-sub-mcp:start -->[\s\S]*?<!-- dsh-sub-mcp:end -->/;

  async function installClaudeSkill() {
    const dest = guidanceDest.claude();
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(skillSources.claude, 'utf8'));
    return dest;
  }

  // Codex has no per-skill file; global guidance lives in $CODEX_HOME/AGENTS.md.
  // The snippet is fenced with markers so re-installing replaces rather than
  // duplicates, and the user's own content around it is left untouched.
  async function installCodexInstructions() {
    const dest = guidanceDest.codex();
    const snippet = (await readFile(skillSources.codex, 'utf8')).trim();
    let existing = '';
    try { existing = await readFile(dest, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = CODEX_FENCE.test(existing)
      ? existing.replace(CODEX_FENCE, snippet)
      : (existing.trimEnd() + (existing.trim() ? '\n\n' : '') + snippet + '\n');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, next);
    return dest;
  }

  // Whether the guidance is on disk right now — the panel shows this next to
  // each parent so a fresh machine (or a deleted skill) is visible at a glance.
  function guidanceInstalled(target) {
    const dest = guidanceDest[target]();
    if (target === 'claude') return existsSync(dest);
    try { return CODEX_FENCE.test(readFileSync(dest, 'utf8')); } catch { return false; }
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
    if (result.ok) {
      try {
        const installed = target === 'claude' ? await installClaudeSkill() : await installCodexInstructions();
        result.output += `\n${target === 'claude' ? 'Skill installed' : 'Instructions installed'}: ${installed}`;
      } catch (error) {
        result.output += `\nWARNING: could not install usage guidance: ${String(error.message || error)}`;
      }
    }
    return { ...result, exe };
  }

  // Asks the CLI itself whether the registration is still there, so the panel
  // reports what the parent will actually see rather than what we last wrote.
  async function runVerify(target) {
    const exe = resolveCli(target);
    const result = await runCli(exe, ['mcp', 'get', 'deepseek']);
    return { ...result, exe };
  }

  // ---------------------------------------------------------------------------
  // Control panel. The UI itself is src/client.js, a DSH client plugin that adds
  // a "DeepSeek Sub-agent" section to the harness's own Settings dialog; these
  // routes are the JSON it reads and writes. They accept the MCP token (?key=)
  // or the browser session cookie the DSH UI already holds, so the section
  // needs no credentials of its own.
  // ---------------------------------------------------------------------------

  const API = '/dsh-sub';

  // The cross-run table: newest first, live runs carrying their current
  // progress instead of the (not yet known) final numbers.
  function runRows(n = 40) {
    return history.recent(n).map(r => {
      const live = r.status === 'running' ? delegator.get(r.sessionId) : null;
      const s = live ? live.snapshot() : null;
      return {
        id: r.id,
        sessionId: r.sessionId ?? null,
        time: r.time,
        role: r.role,
        turn: r.turn ?? 1,
        model: r.model,
        status: r.status,
        reason: r.reason ?? r.error ?? null,
        durationMs: r.status === 'running' ? Date.now() - Date.parse(r.time) : (r.durationMs ?? null),
        toolCalls: s ? s.toolCalls : (r.toolCalls ?? null),
        lastTool: s ? s.lastTool : null,
        stopping: s ? s.abortRequested : null,
        usage: r.usage
          ? { inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0, cacheHitRatio: r.usage.cacheHitRatio ?? 0, pending: r.usage.pending === true }
          : null,
        changedFiles: r.changedFiles ?? null,
        task: r.task,
        workspace: r.workspace,
        background: r.background ?? false,
      };
    });
  }

  async function panelState() {
    await history.settle(home);
    const keyConfigured = await resolveKey().then(Boolean).catch(() => false);
    // Never block the panel on the network: hand back what we have and let the
    // (throttled) probe update the cache for the next poll.
    if (keyConfigured) catalog.refresh(resolveKey).catch(() => {});
    return {
      now: new Date().toISOString(),
      port: ctx.webServer.port,
      mcpUrl: mcpUrl(),
      home,
      key: { configured: keyConfigured },
      catalog: catalog.snapshot(),
      agents: {
        claude: { cli: cliCandidates('claude')[0] ?? null, guidance: guidanceDest.claude(), guidanceInstalled: guidanceInstalled('claude') },
        codex: { cli: cliCandidates('codex')[0] ?? null, guidance: guidanceDest.codex(), guidanceInstalled: guidanceInstalled('codex') },
      },
      runs: runRows(),
      totalRuns: history.entries.length,
      running: delegator.list().length,
    };
  }

  // Relaunch: a detached serve.mjs waits for the port to free and boots a fresh
  // harness; this process exits once the reply is out, and the serve.mjs that
  // spawned us follows (it exits with its child). Same detached recipe as the
  // stdio bridge, so no console window appears.
  function scheduleRestart() {
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'serve.mjs'), '--no-open', '--wait'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => process.exit(0), 500).unref();
  }

  function authorized(req) {
    const supplied = new URL(req.url, 'http://127.0.0.1').searchParams.get('key') ?? '';
    const keyBuf = Buffer.from(supplied);
    const expected = Buffer.from(token);
    const keyOk = keyBuf.length === expected.length && timingSafeEqual(keyBuf, expected);
    return keyOk || !ctx.connection.requestRejection(req);
  }

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: API,
    async handler(req, res) {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      if (!authorized(req)) return json(401, { error: 'not authenticated' });
      // The bearer route already refuses cross-origin; the panel API does too,
      // for the same DNS-rebinding reason.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(403, { error: 'origin not allowed' });

      const route = new URL(req.url, 'http://127.0.0.1').pathname.slice(API.length) || '/';
      const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
      const target = body.target;
      const validTarget = target === 'claude' || target === 'codex';

      try {
        if (req.method === 'GET' && route === '/state') return json(200, await panelState());
        if (req.method === 'POST' && route === '/register') {
          if (!validTarget) return json(400, { error: 'invalid target' });
          return json(200, await runRegister(target));
        }
        if (req.method === 'POST' && route === '/verify') {
          if (!validTarget) return json(400, { error: 'invalid target' });
          return json(200, await runVerify(target));
        }
        if (req.method === 'POST' && route === '/model') {
          const snapshot = await catalog.setEnabled(body.model, body.enabled === true);
          return json(200, { catalog: snapshot });
        }
        if (req.method === 'POST' && route === '/models/refresh') {
          return json(200, { catalog: await catalog.refresh(resolveKey, { force: true }) });
        }
        if (req.method === 'POST' && route === '/cancel') {
          const id = requireSessionId(body.sessionId);
          const run = delegator.get(id);
          if (!run) return json(200, { ok: false, message: `Session ${id} is not running.` });
          const first = run.stop('cancelled');
          return json(200, { ok: true, message: first ? 'Cancel requested.' : `Already stopping (${run.abortReason}).` });
        }
        if (req.method === 'POST' && route === '/delete') {
          if (!Array.isArray(body.sessionIds) || body.sessionIds.length > 100) return json(400, { error: 'sessionIds must be a list' });
          const ids = body.sessionIds.map(requireSessionId);
          const running = ids.filter(id => delegator.get(id));
          if (running.length) return json(200, { error: `${running.length} of the selected sessions are still running. Stop them first.` });
          // The harness never erases a transcript; "archive" is what its own
          // sidebar menu does, and the same thing hides it here. Our record
          // and the stored report go for real.
          const archived = await delegator.archiveSessions(ids);
          const removed = await history.remove(ids);
          await Promise.all(ids.map(id => deleteResult(id).catch(() => {})));
          return json(200, { ok: true, removed, archived: archived.length, notArchived: ids.length - archived.length });
        }
        if (req.method === 'POST' && route === '/restart') {
          const live = delegator.list().length;
          if (live) return json(200, { error: `${live} delegation${live === 1 ? ' is' : 's are'} still running. Stop them first.` });
          json(200, { ok: true });
          scheduleRestart();
          return;
        }
        return json(404, { error: 'not found' });
      } catch (error) {
        return json(200, { error: String(error.message || error) });
      }
    },
  });

  // The launcher URL Start.vbs and `npm start` open. It carries the MCP token,
  // exchanges it for the harness's own launch token, and lands in the DSH UI
  // with a fragment that tells the client plugin to open our Settings section.
  // A page rather than a 302 so the launcher's readiness probe sees a plain 200.
  const disposeSetup = ctx.webServer.register({
    kind: 'exact',
    path: '/setup',
    async handler(req, res) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not authenticated. Reopen the /setup?key=... link printed by the terminal, or open the DSH UI and choose Settings → DeepSeek Sub-agent.');
        return;
      }
      const target = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`) + SETTINGS_HASH;
      const safe = JSON.stringify(target).replaceAll('<', '\\u003c');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(`<!doctype html><meta charset=utf-8><title>DSH-Sub-MCP</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 system-ui,sans-serif;color:#555;display:grid;place-items:center;height:100vh;margin:0}a{color:inherit}</style>
<p>Opening DeepSeek Harness → Settings → DeepSeek Sub-agent… <a id=l>continue</a></p>
<script>const u=${safe};document.getElementById('l').href=u;location.replace(u)</script>`);
    },
  });

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
      // SSE, not a buffered JSON body: the response starts streaming at once
      // (progress notifications, keep-alives) instead of sending nothing until
      // the tool finishes, which is what let client-side header timeouts cut
      // long delegations at 300s.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: false,
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

  ctx.on('dispose', () => { dispose(); disposeApi(); disposeSetup(); });
}
