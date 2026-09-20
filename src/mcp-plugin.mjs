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
import { ModelDirectory, AskFirstError, splitKey, keyOf, DEEPSEEK } from './models.mjs';
import { DeepSeekLive } from './deepseek-live.mjs';
import { scanSkills, summarizeSkills, resolveSkills, skillRootsSummary } from './skills.mjs';
import { Delegator, readUsage, usageDelta, TOOL_CALL_BOUNDS, DEFAULT_LIMITS } from './delegate.mjs';
import {
  validateWorkspace, gitStatus, diffStatus, samePath,
  createWorktree, linkDirs, copyWorktreeInclude, carryUncommitted, lockWorktree, unlockWorktree,
  worktreeExists, worktreeState, worktreeDiff, commitWorktree, applyWorktree, removeWorktree, rewritePaths, snapshotTree,
} from './workspace.mjs';
import { home, projectRoot } from './bootstrap.mjs';

export const name = 'deepseek-sub-mcp';
export const inject = ['webServer', 'credentials', 'agents', 'tools', 'connection', 'workspaceRegistry', 'sessionTitle', 'llm', 'settings', 'skills'];

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
    let changed = false;
    for (const entry of this.entries) {
      // Records from before the multi-provider directory carry a bare DeepSeek id.
      if (typeof entry.model === 'string' && !splitKey(entry.model)) {
        entry.model = keyOf(DEEPSEEK, entry.model);
        changed = true;
      }
      if (!entry.provider && typeof entry.model === 'string') entry.provider = splitKey(entry.model)?.provider;
      if (entry.status !== 'running') continue;
      entry.status = 'interrupted';
      entry.reason = 'the harness restarted while the run was in flight';
      changed = true;
    }
    if (changed) await this.persist();
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
  // Every turn of a worktree session carries the same worktree record, so a
  // removal is stamped on all of them.
  async markWorktreeRemoved(sessionId) {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId || !entry.worktree || entry.worktree.removed) continue;
      entry.worktree = { ...entry.worktree, removed: true };
      changed = true;
    }
    if (changed) await this.persist();
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

// Sidebar title: "[Code] - store-main: fix the nav overflow…". The mode and the
// project folder come first so a list of sessions scans by eye; the harness
// caps titles at 80 bytes, so the task excerpt is short. A worktree session
// carries the branch glyph so it reads as "not the main checkout".
const MODE_LABEL = { code: 'Code', research: 'Research' };
function sessionTitleFor(role, workspace, task, worktree = null) {
  const folder = path.basename(workspace) || workspace;
  const excerpt = task.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[${MODE_LABEL[role] ?? role}${worktree ? ' ⎇' : ''}] - ${folder}: ${excerpt}`;
}

// What a history record / result keeps about a worktree: enough to resume in
// it, inspect it and remove it later, nothing transient.
function worktreeRecord(wt) {
  if (!wt) return undefined;
  return {
    repo: wt.repo, path: wt.path, cwd: wt.cwd, branch: wt.branch, base: wt.base, start: wt.start ?? wt.base,
    links: wt.links ?? [], ...(wt.removed ? { removed: true } : {}),
  };
}

// The block a worktree run ends with: where the work is and the three ways to
// deal with it. The agent cannot commit in the worktree (its sandbox root
// excludes the shared .git), so the parent is told to take or drop the work.
function describeWorktree(wt, state, sessionId) {
  if (wt.removed) return ['worktree: removed automatically — the agent made no changes.'];
  const summary = state
    ? `${state.status.length} changed entr${state.status.length === 1 ? 'y' : 'ies'}, ${state.commits} commit${state.commits === 1 ? '' : 's'} on top of ${wt.base.slice(0, 7)}`
    : 'state unknown';
  return [
    `worktree: ${wt.path} | branch: ${wt.branch} | base: ${wt.base.slice(0, 7)} — ${summary}`,
    'The changes are in the worktree, NOT in your checkout. The worktree stays until you remove it:',
    `  review → deepseek_worktree({ sessionId: "${sessionId}", action: "diff" })  or  git -C "${wt.path}" diff ${wt.base.slice(0, 7)}`,
    `  take   → deepseek_worktree({ sessionId: "${sessionId}", action: "commit", message: "…" }) then git merge ${wt.branch}   |  or action: "apply" to copy them into your working tree uncommitted`,
    `  drop   → deepseek_worktree({ sessionId: "${sessionId}", action: "remove" })`,
  ];
}

// The parent-facing view of a worktree record.
function worktreeSummary(wt) {
  if (!wt) return null;
  return { path: wt.path, branch: wt.branch, base: wt.base?.slice(0, 7) ?? null, removed: wt.removed === true };
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('sessionId must be the id shown by deepseek_sessions or a previous result.');
  return value.toLowerCase();
}

export async function apply(ctx) {
  const token = await ensureToken();
  const live = new DeepSeekLive(home);
  const directory = new ModelDirectory(ctx, home, { live });
  const delegator = new Delegator(ctx);
  const history = new History(path.join(home, 'delegations.json'));
  const resolveKey = async () => (await ctx.credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? null;
  // sessionId → promise of the finished body, so deepseek_result can wait on a
  // run that is still in flight (background, or one the parent gave up on).
  const pending = new Map();

  await live.load();
  await directory.load();
  await history.load();
  // Warm the DeepSeek probe from the live API without blocking boot; the
  // directory itself is built lazily from the harness on first use.
  live.refresh(resolveKey).then(() => directory.invalidate()).catch(() => {});
  // Providers, their models and their keys are edited in the harness's own
  // Settings dialog; drop our 30 s cache the moment any of that changes.
  ctx.on('llm/adapters-updated', () => directory.invalidate());
  ctx.on('settings/updated', ns => { if (ns === 'llm-pi-ai' || ns === 'llm-deepseek') directory.invalidate(); });
  ctx.on('credentials/reference-updated', () => directory.invalidate());
  // Earlier versions created the workspace but never attached the session to
  // it, so their runs sit under "Ungrouped" in the sidebar. Adopt them once
  // the harness is up; attaching is idempotent.
  setTimeout(() => delegator.adoptSessions(history.sessionWorkspaces()).catch(() => {}), 3000).unref?.();
  // A worktree removed outside this server (or before forgetWorkspace could
  // find the record) leaves a sidebar workspace pointing at nothing; drop those.
  setTimeout(async () => {
    const seen = new Set();
    for (const e of history.entries) {
      const wt = e.worktree;
      if (!wt || seen.has(wt.path)) continue;
      seen.add(wt.path);
      if (wt.removed || !(await worktreeExists(wt))) {
        if (!wt.removed) await history.markWorktreeRemoved(e.sessionId).catch(() => {});
        await delegator.forgetWorkspace(wt.path).catch(() => {});
      }
    }
  }, 4000).unref?.();

  const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });
  const json = value => text(JSON.stringify(value, null, 2));

  // End of a worktree turn: release the lock and, like Claude Code's subagent
  // worktrees, drop the worktree when the agent changed nothing. One with work
  // in it stays until the parent takes or removes it. Mutates `wt.removed`.
  async function settleWorktree(wt, sessionId) {
    if (!wt) return [];
    await unlockWorktree(wt).catch(() => {});
    let state = null;
    try { state = await worktreeState(wt); } catch { /* reported as unknown */ }
    if (state?.clean) {
      try {
        await removeWorktree(wt, {});
        await delegator.forgetWorkspace(wt.path);
        await history.markWorktreeRemoved(sessionId);
        wt.removed = true;
      } catch (error) {
        return [`worktree: ${wt.path} has no changes but could not be removed (${String(error.message || error)}); deepseek_worktree remove retries it.`];
      }
    }
    return describeWorktree(wt, state, sessionId);
  }

  // One delegation turn: a fresh session, or a follow-up turn on a persisted
  // one (`resume` is that session's latest history entry).
  async function startRun({ role, task, workspace, model, reasoningEffort, skills, timeoutSec, allowDirty, background, maxToolCalls, resume, isolation, branch, base, linkDirs: links, includeUncommitted }, extra) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task must not be empty.');
    if (task.length > 32000) throw new Error('task is limited to 32,000 characters.');
    // Model first: the ask-first refusal must fire before anything is touched
    // or recorded. A continuation without `model` stays on its session's model.
    const picked = resume
      ? await directory.resolve(model ?? resume.model, { implicit: model === undefined || model === null || model === '' })
      : (model !== undefined && model !== null && model !== '')
        ? await directory.resolve(model)
        : await directory.requireChoice();
    // Effort: what the parent asked for, else (on a continuation) what the
    // session ran with last time, else the directory's default ("high").
    const effortWanted = reasoningEffort ?? (resume ? resume.effort ?? undefined : undefined);
    const chosen = ModelDirectory.resolveEffort(picked, effortWanted);
    const ws = await validateWorkspace(workspace, home);
    const attached = await resolveSkills(skills, { workspace: ws });

    const seconds = Math.min(Math.max(Number(timeoutSec) || DEFAULT_TIMEOUT_SEC, 30), 3600);
    const budget = maxToolCalls === undefined
      ? undefined
      : Math.min(Math.max(Math.floor(Number(maxToolCalls)), TOOL_CALL_BOUNDS.min), TOOL_CALL_BOUNDS.max);
    const timeout = AbortSignal.timeout(seconds * 1000);
    // A foreground run dies with its request (the parent cancelled, timed out,
    // or went away). A background run answers only to timeoutSec and deepseek_cancel.
    const client = background ? undefined : extra?.signal;

    // Worktree isolation: the agent's cwd becomes a fresh checkout of the repo
    // on its own branch. A continuation stays in its session's worktree (the
    // session cwd is immutable anyway); a fresh run builds one on request.
    // The sandbox confines the agent's writes to that cwd, so the parent's
    // checkout — dirty or not — is out of its reach, which is why the dirty
    // check below does not apply.
    let worktree = resume?.worktree ?? null;
    let cwd = ws;
    if (worktree) {
      if (worktree.removed || !(await worktreeExists(worktree))) {
        throw new Error(`The worktree of session ${resume.sessionId} (${worktree.path}) no longer exists. Start a new delegation instead.`);
      }
      cwd = worktree.cwd;
      await lockWorktree(worktree, 'DSH-Sub-MCP delegation in progress', timeout);
    } else if (isolation === 'worktree') {
      if (role !== 'code') throw new Error('isolation: "worktree" only applies to deepseek_code; a research agent never writes.');
      worktree = await createWorktree({ workspace: ws, task, branch, base: base || 'HEAD', signal: timeout });
      try {
        await linkDirs(worktree, links ?? ['node_modules'], timeout);
        await copyWorktreeInclude(worktree, timeout);
        if (includeUncommitted === true) worktree.carried = await carryUncommitted(worktree, timeout);
        // What the agent starts from; its own change is measured against this.
        worktree.start = await snapshotTree(worktree, timeout);
      } catch (error) {
        await removeWorktree(worktree, { signal: timeout }).catch(() => {});
        throw error;
      }
      cwd = worktree.cwd;
    } else if (isolation !== undefined && isolation !== 'inplace') {
      throw new Error('isolation must be "inplace" or "worktree".');
    }
    // The parent writes the task against its own checkout; in the worktree the
    // same files live under the worktree path.
    const agentTask = worktree ? rewritePaths(task, worktree.repo, worktree.path) : task;

    const before = await gitStatus(cwd, timeout);
    if (role === 'code' && !worktree && allowDirty !== true && before && before.length) {
      throw new Error(
        `Workspace has ${before.length} uncommitted changes. `
        + 'Commit or stash first so there is always a rollback point, call again with allowDirty: true, '
        + 'or pass isolation: "worktree" to run in a separate checkout and leave this tree untouched.',
      );
    }

    const sessionId = resume ? resume.sessionId : randomUUID();
    const turn = resume ? (resume.turn ?? 1) + 1 : 1;
    const skillNames = attached.map(s => s.name);
    const header = [`model: ${picked.key}`, `effort: ${chosen.effort ?? 'n/a'}`, `role: ${role}`, `workspace: ${ws}`, `session: ${sessionId}${turn > 1 ? ` (turn ${turn})` : ''}`];
    if (worktree) header.push(`worktree: ${worktree.path}`, `branch: ${worktree.branch}`);
    if (skillNames.length) header.push(`skills: ${skillNames.join(', ')}`);
    for (const w of [picked.warning, chosen.warning]) if (w) header.push(`WARNING: ${w}`);

    const startedAt = Date.now();
    const record = await history.start({
      time: new Date(startedAt).toISOString(),
      role,
      model: picked.key,
      provider: picked.provider,
      effort: chosen.effort,
      workspace: ws,
      task: task.slice(0, 160),
      sessionId,
      turn,
      background: Boolean(background),
      ...(skillNames.length ? { skills: skillNames } : {}),
      ...(worktree ? { worktree: worktreeRecord(worktree) } : {}),
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
          task: agentTask,
          workspace: cwd,
          worktree,
          workspaceTitle: worktree ? `${path.basename(worktree.repo)} ⎇ ${worktree.branch}` : undefined,
          provider: picked.provider,
          model: picked.model,
          reasoningEffort: chosen.effort ?? undefined,
          skills: attached,
          signals: { timeout, 'client-disconnect': client },
          title: sessionTitleFor(role, ws, task, worktree),
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
        const [after, usageTotal] = await Promise.all([gitStatus(cwd), readUsage(home, sessionId, { after: usageBefore })]);
        const usage = resume ? usageDelta(usageTotal, usageBefore) : usageTotal;
        const failed = result.stopReason !== 'completed' || !result.text;
        const changed = diffStatus(before, after);
        const durationMs = Date.now() - startedAt;
        const status = failed ? result.stopReason : 'completed';
        const worktreeLines = await settleWorktree(worktree, sessionId);
        // A turn run on the agent the DSH UI holds uses that agent's model.
        const usedModel = result.model ?? picked.key;
        header[0] = `model: ${usedModel}`;
        const body = [
          header.join(' | '),
          `stopReason: ${result.stopReason} | tool calls: ${result.toolCalls} | ${(durationMs / 1000).toFixed(1)}s`,
          describeUsage(usage),
          ...(result.diagnostic ? [`diagnostic: ${result.diagnostic}`] : []),
          ...(failed && !result.diagnostic
            ? [`hint: check the API key of provider "${splitKey(usedModel)?.provider ?? picked.provider}" in the GUI (Settings → Models) and your account quota.`]
            : []),
          ...(failed ? [`To pick up where it stopped: deepseek_continue({ sessionId: "${sessionId}", message: "..." })`] : []),
          describeChanges(before, after),
          ...worktreeLines,
          '',
          result.text || '(agent returned no text content)',
        ].join('\n');
        await history.finish(record, {
          status,
          model: usedModel,
          provider: splitKey(usedModel)?.provider ?? picked.provider,
          reason: result.diagnostic || undefined,
          durationMs,
          toolCalls: result.toolCalls,
          changedFiles: changed?.length ?? null,
          usage,
          ...(worktree ? { worktree: worktreeRecord(worktree) } : {}),
        });
        await saveResult(sessionId, {
          sessionId, turn, time: record.time, role, model: usedModel, provider: splitKey(usedModel)?.provider ?? picked.provider,
          effort: chosen.effort, skills: skillNames, workspace: ws, task: task.slice(0, 160), worktree: worktreeRecord(worktree) ?? null,
          status, stopReason: result.stopReason, abortReason: result.abortReason, diagnostic: result.diagnostic,
          durationMs, toolCalls: result.toolCalls, changedFiles: changed ?? null, usage, text: result.text, body,
        }).catch(() => {});
        return { body, failed };
      } catch (error) {
        // Report the damage even on failure: an aborted write-mode agent can leave
        // partial edits, and the parent needs to see them to recover.
        const message = String(error.message || error);
        const after = await gitStatus(cwd).catch(() => null);
        const changed = diffStatus(before, after);
        const durationMs = Date.now() - startedAt;
        const worktreeLines = await settleWorktree(worktree, sessionId);
        const body = [header.join(' | '), `FAILED: ${message}`, describeChanges(before, after), ...worktreeLines].join('\n');
        await history.finish(record, {
          status: 'failed', error: message.slice(0, 300), durationMs, changedFiles: changed?.length ?? null,
          ...(worktree ? { worktree: worktreeRecord(worktree) } : {}),
        });
        await saveResult(sessionId, {
          sessionId, turn, time: record.time, role, model: picked.key, provider: picked.provider, effort: chosen.effort, skills: skillNames,
          workspace: ws, task: task.slice(0, 160), worktree: worktreeRecord(worktree) ?? null,
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

  // The ask-first refusal is a tool result the parent must act on (ask the
  // user, call again), not a protocol error.
  async function delegate(role, args, extra) {
    try {
      return await startRun({ role, ...args }, extra);
    } catch (error) {
      if (error instanceof AskFirstError) return text(error.message, true);
      throw error;
    }
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
        provider: splitKey(s.model)?.provider ?? null,
        task: origin?.task ?? run.task.slice(0, 160),
        ...(origin && origin !== entry ? { lastMessage: entry?.task } : {}),
        ...(entry?.skills?.length ? { skills: entry.skills } : {}),
        time: entry?.time ?? new Date(run.startedAt).toISOString(),
        turns: turns.get(run.sessionId) ?? 1,
        background: entry?.background ?? false,
        worktree: worktreeSummary(entry?.worktree),
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
        provider: e.provider ?? splitKey(e.model)?.provider ?? null,
        effort: e.effort ?? null,
        workspace: e.workspace,
        task: origin.task,
        ...(origin !== e ? { lastMessage: e.task } : {}),
        ...(e.skills?.length ? { skills: e.skills } : {}),
        time: e.time,
        turn: e.turn ?? 1,
        turns: turns.get(e.sessionId),
        durationMs: e.durationMs ?? null,
        toolCalls: e.toolCalls ?? null,
        changedFiles: e.changedFiles ?? null,
        usage: e.usage ? { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, cacheHitRatio: Number((e.usage.cacheHitRatio ?? 0).toFixed(3)) } : null,
        background: e.background ?? false,
        worktree: worktreeSummary(e.worktree),
        continuable: e.status !== 'running' && !(e.worktree?.removed),
      });
    }
    return rows
      .filter(r => !workspace || samePath(r.workspace, workspace))
      .filter(r => status === 'all' || (status === 'running' ? r.status === 'running' : r.status !== 'running'))
      .slice(0, limit);
  }

  function buildServer() {
    const server = new McpServer(
      { name: 'dsh-deepseek-subagent', version: '1.3.0' },
      { capabilities: { tools: {} } },
    );

    server.registerTool('deepseek_models', {
      title: 'Models available on the DeepSeek Harness',
      description:
        'Lists every provider active on the DeepSeek Harness (DeepSeek plus any provider configured under Settings → Models, e.g. GLM via a "zai" route) '
        + 'with its models, whether its API key is configured, and which models are switched on for delegation. '
        + '`enabled` is the list of usable "provider/model" keys; when it holds more than one entry (`askFirst: true`) you must ask the user which one to use '
        + 'and pass it as `model` to deepseek_research / deepseek_code. For deepseek-official, listed=false means the DeepSeek API no longer serves that id.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Re-probe the DeepSeek API and rebuild the directory instead of using the cache. Throttled to once per 60 seconds.'),
      },
    }, async ({ refresh }, extra) => {
      if (refresh === true) {
        await live.refresh(resolveKey, { force: true, signal: extra?.signal });
        directory.invalidate();
      }
      return json(await directory.snapshot());
    });

    server.registerTool('deepseek_skills', {
      title: 'Skills that can be attached to a delegation',
      description:
        'Lists the parent agent\'s skills (Claude Code / Codex SKILL.md files found in the workspace, ~/.claude, ~/.codex, ~/.agents and installed plugins) '
        + 'that can be attached to a delegation by name through the `skills` parameter. Use it when you are unsure of a skill\'s exact name.',
      inputSchema: {
        workspace: z.string().optional().describe('Absolute project path, to include its .claude/skills and .agents/skills.'),
        refresh: z.boolean().optional().describe('Rescan the directories instead of using the 30 s cache.'),
      },
    }, async ({ workspace, refresh }) => {
      const ws = workspace ? await validateWorkspace(workspace, home) : undefined;
      return json(summarizeSkills(await scanSkills({ workspace: ws, force: refresh === true })));
    });

    const runOptions = {
      model: z.string().optional().describe(
        'Model as "provider/model" (e.g. deepseek-official/deepseek-flash, zai/glm-5.3) from deepseek_models. '
        + 'A bare id is accepted only when it is unique across providers. '
        + 'REQUIRED when more than one model is enabled: ask the user which one to use first — the call is refused otherwise.',
      ),
      reasoningEffort: z.string().optional().describe(
        'How hard the model thinks. Default "high". Use "max" for HARD tasks: subtle bugs, cross-cutting refactors, anything where a wrong answer is expensive. '
        + '"low"/"off" only for trivial lookups. Levels depend on the model (deepseek_models lists them per model, e.g. off, low, high, max).',
      ),
      skills: z.array(z.string().min(1)).max(8).optional().describe(
        'Names of YOUR skills that are relevant to this task (see deepseek_skills), e.g. ["find-skills"]. '
        + 'They are registered in the agent\'s session and it loads them with its `skill` tool; pick 1–3 instead of pasting their content into `task`.',
      ),
      timeoutSec: z.number().int().min(30).max(3600).optional().describe(`Time limit in seconds, default ${DEFAULT_TIMEOUT_SEC}.`),
      maxToolCalls: z.number().int().min(TOOL_CALL_BOUNDS.min).max(TOOL_CALL_BOUNDS.max).optional()
        .describe(`Tool call budget for the agent, default ${DEFAULT_LIMITS.maxToolCalls}. Raise it for tasks touching many files.`),
      background: z.boolean().optional()
        .describe('Return immediately with the sessionId and let the agent run on. Read the report later with deepseek_result. Use for anything that may take more than a few minutes.'),
    };
    const shared = {
      task: z.string().describe('A self-contained task with full context. The agent cannot see your conversation.'),
      workspace: z.string().describe('Absolute path to the project directory. Usually your current working directory.'),
      ...runOptions,
    };

    server.registerTool('deepseek_research', {
      title: 'DeepSeek Harness read & analyse (read-only)',
      description:
        'Delegate an ANALYSIS task to a local DeepSeek Harness agent (any configured provider/model). The agent can only read files (read/glob/grep); '
        + 'it does NOT edit files and does NOT run commands. Use it to review code, find bugs, explain a module, or survey a codebase. '
        + 'The result names the sessionId; deepseek_continue can ask that same agent follow-up questions.',
      inputSchema: shared,
    }, (args, extra) => delegate('research', args, extra));

    server.registerTool('deepseek_code', {
      title: 'DeepSeek Harness edit code (read & write)',
      description:
        'Delegate a CODE-CHANGE task to a local DeepSeek Harness agent (any configured provider/model). The agent can read, write, edit files and run commands '
        + 'inside the workspace. Refuses to run on a dirty git tree (unless allowDirty=true) so a rollback point always exists. '
        + 'With isolation: "worktree" the agent works in a fresh git worktree of the repo on its own branch (<repo>/.dsh/worktrees/…), so your checkout is untouched '
        + 'even if dirty and several code delegations can run in parallel; the result then says where the worktree is and deepseek_worktree lets you diff, commit, apply or remove it. '
        + 'The result always includes the list of changed files and the sessionId, which deepseek_continue can resume if the run stopped early.',
      inputSchema: {
        ...shared,
        allowDirty: z.boolean().optional().describe('Allow running even if the workspace has uncommitted changes (in-place mode only).'),
        isolation: z.enum(['inplace', 'worktree']).optional().describe(
          'Where the agent edits. "inplace" (default): your checkout. "worktree": a separate git worktree on a new branch, created from `base` — '
          + 'use it when your tree is dirty, when you run several code delegations at once, for large or risky changes, or when the user asks for a branch. '
          + 'A worktree with no changes is removed automatically; one with changes stays until deepseek_worktree removes it. The agent cannot commit there; you take the work with deepseek_worktree.',
        ),
        branch: z.string().optional().describe('worktree only: branch name to create. Default dsh/<task-slug>-<id>.'),
        base: z.string().optional().describe('worktree only: commit/branch to start from. Default HEAD (what you are on now).'),
        linkDirs: z.array(z.string()).max(8).optional().describe('worktree only: gitignored directories of your checkout to share read-only into the worktree via junction/symlink. Default ["node_modules"]; pass [] for none.'),
        includeUncommitted: z.boolean().optional().describe('worktree only: also copy your uncommitted changes and untracked files into the worktree so the agent starts from what you see. Default false.'),
      },
    }, (args, extra) => delegate('code', args, extra));

    server.registerTool('deepseek_worktree', {
      title: 'Inspect, take or remove a delegation worktree',
      description:
        'For a session that ran with isolation: "worktree". "status": path, branch and what changed. "diff": the full diff against the base. '
        + '"commit": commit everything in the worktree on its branch (the agent cannot; the server does it for you) so you can `git merge <branch>`. '
        + '"apply": copy the worktree\'s changes into your own working tree as uncommitted changes (3-way). '
        + '"remove": delete the worktree (and its branch when it has no unmerged commits). Refused while the session is running.',
      inputSchema: {
        sessionId: z.string().describe('Session id from the result header or deepseek_sessions.'),
        action: z.enum(['status', 'diff', 'commit', 'apply', 'remove']),
        message: z.string().optional().describe('commit only: the commit message.'),
        deleteBranch: z.boolean().optional().describe('remove only: also delete the branch when it is merged or has no commits. Default true.'),
      },
    }, async ({ sessionId, action, message, deleteBranch }, extra) => {
      const id = requireSessionId(sessionId);
      const entry = history.latestForSession(id);
      if (!entry) throw new Error(`Unknown session ${id}. deepseek_sessions lists the ones this server knows.`);
      if (!entry.worktree) throw new Error(`Session ${id} did not run in a worktree (its changes are in ${entry.workspace}).`);
      const wt = entry.worktree;
      if (wt.removed) throw new Error(`The worktree of session ${id} was already removed.`);
      if (action !== 'status' && delegator.get(id)) throw new Error(`Session ${id} is still running. Wait for it, or deepseek_cancel first.`);
      if (!(await worktreeExists(wt))) {
        await history.markWorktreeRemoved(id);
        throw new Error(`Worktree ${wt.path} no longer exists on disk (removed outside this server); the session is now marked as such.`);
      }
      const signal = extra?.signal;
      const head = `worktree: ${wt.path} | branch: ${wt.branch} | base: ${wt.base.slice(0, 7)}`;
      switch (action) {
        case 'status': {
          const state = await worktreeState(wt, signal);
          return json({ sessionId: id, ...worktreeSummary(wt), repo: wt.repo, running: Boolean(delegator.get(id)), clean: state.clean, commits: state.commits, changes: state.status });
        }
        case 'diff': {
          const d = await worktreeDiff(wt, signal);
          return text([head, d.stat || '(no changes)', '', d.patch, ...(d.truncated ? [`[diff truncated at 200 KB — git -C "${wt.path}" diff ${wt.base.slice(0, 7)} for the rest]`] : [])].join('\n'));
        }
        case 'commit': {
          if (typeof message !== 'string' || !message.trim()) throw new Error('message is required for commit.');
          const sha = await commitWorktree(wt, message.trim(), signal);
          return text(sha
            ? `${head}\nCommitted ${sha} on ${wt.branch}. Merge it with: git merge ${wt.branch}   (then deepseek_worktree({ sessionId: "${id}", action: "remove" }))`
            : `${head}\nNothing to commit — the worktree has no changes.`);
        }
        case 'apply': {
          const r = await applyWorktree(wt, signal);
          return text(r.applied
            ? `${head}\nApplied ${r.files.length} file(s) onto ${wt.repo} as uncommitted changes:\n${r.files.map(f => `  ${f}`).join('\n')}\nReview with git diff, then deepseek_worktree({ sessionId: "${id}", action: "remove" }).`
            : `${head}\nNothing to apply — the worktree has no changes.`);
        }
        case 'remove': {
          const notes = await removeWorktree(wt, { deleteBranch: deleteBranch ?? true, signal });
          await delegator.forgetWorkspace(wt.path);
          await history.markWorktreeRemoved(id);
          return text(`Removed worktree ${wt.path}.${notes.length ? ` ${notes.join('; ')}.` : ''}`);
        }
        default: throw new Error(`unknown action ${action}`);
      }
    });

    server.registerTool('deepseek_sessions', {
      title: 'List DeepSeek sessions',
      description:
        'Lists delegations made through this server: running ones first (with elapsed time, tool calls so far and the last tool), '
        + 'then finished ones newest first with status, why they stopped, duration, cost, changed-file count and, for isolated runs, the worktree (path, branch, whether it still exists). '
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
        + 'The tree is usually dirty from the previous turn, so allowDirty defaults to true here. A worktree session continues in its worktree (refused once that was removed). '
        + 'Without `model` the turn runs on the model the session started with (never asks); pass `model` to switch. Without `reasoningEffort` it keeps the previous effort of the session.',
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
        provider: r.provider ?? splitKey(r.model)?.provider ?? null,
        effort: r.effort ?? null,
        skills: r.skills ?? [],
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
        worktree: worktreeSummary(r.worktree),
      };
    });
  }

  async function panelState() {
    await history.settle(home);
    const keyConfigured = await resolveKey().then(Boolean).catch(() => false);
    // Never block the panel on the network: hand back what we have and let the
    // (throttled) DeepSeek probe update its cache for the next poll.
    if (keyConfigured) live.refresh(resolveKey).then(s => { if (!s.stale) directory.invalidate(); }).catch(() => {});
    const [catalog, skills] = await Promise.all([
      directory.snapshot(),
      skillRootsSummary().catch(() => ({ total: 0, roots: [] })),
    ]);
    return {
      now: new Date().toISOString(),
      port: ctx.webServer.port,
      mcpUrl: mcpUrl(),
      home,
      key: { configured: keyConfigured },
      catalog,
      providers: { usable: catalog.providers.filter(p => p.usable).length, total: catalog.providers.length },
      skills,
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
          const snapshot = await directory.setEnabled(body.key ?? body.model, body.enabled === true);
          return json(200, { catalog: snapshot });
        }
        if (req.method === 'POST' && route === '/models/refresh') {
          await live.refresh(resolveKey, { force: true });
          directory.invalidate();
          return json(200, { catalog: await directory.snapshot() });
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
        if (req.method === 'POST' && route === '/worktree') {
          const id = requireSessionId(body.sessionId);
          if (body.action !== 'remove') return json(400, { error: 'unsupported action' });
          const entry = history.latestForSession(id);
          if (!entry?.worktree || entry.worktree.removed) return json(200, { error: 'This session has no worktree to remove.' });
          if (delegator.get(id)) return json(200, { error: 'The session is still running. Stop it first.' });
          if (await worktreeExists(entry.worktree)) await removeWorktree(entry.worktree, {});
          await delegator.forgetWorkspace(entry.worktree.path);
          await history.markWorktreeRemoved(id);
          return json(200, { ok: true });
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
