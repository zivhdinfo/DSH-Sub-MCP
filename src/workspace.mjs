// Workspace validation and git evidence. The parent agent supplies a path over
// MCP, so it is untrusted input and gets the same checks DSH Team applies.
//
// The second half is worktree isolation: a `deepseek_code` call can ask for a
// throwaway git worktree under <repo>/.dsh/worktrees/<name> on its own branch,
// so the agent edits a separate checkout while the parent's tree stays as it
// is. The DSH sandbox (workspace-write) confines the agent's writes to its
// session cwd, so with the worktree as cwd the main checkout is unwritable for
// it — including the shared .git directory, which is why the agent itself
// cannot commit; every git write below runs unconfined on the server side.
import { lstat, realpath, readFile, writeFile, appendFile, mkdir, copyFile, symlink, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const WORKTREE_DIR = path.join('.dsh', 'worktrees');
export const BRANCH_PREFIX = 'dsh/';
// Files copied from the main checkout into a new worktree: same file and
// semantics as Claude Code's, so a repo configured for one works for both.
export const WORKTREE_INCLUDE = '.worktreeinclude';
const MAX_INCLUDE_FILES = 500;
const MAX_DIFF_BYTES = 200_000;

const inside = (base, child) => {
  const rel = path.relative(base, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export const isInside = (base, child) => inside(path.resolve(base).toLowerCase(), path.resolve(child).toLowerCase());

export async function validateWorkspace(input, privateHome) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new Error('workspace must be an absolute path to a project directory.');
  }
  let target;
  try {
    target = await realpath(input);
  } catch {
    throw new Error(`workspace does not exist: ${input}`);
  }
  if (!(await lstat(target)).isDirectory()) throw new Error('workspace must be a directory.');
  if (target === path.parse(target).root) throw new Error('A drive root cannot be used as the workspace.');
  if (target.toLowerCase() === process.env.USERPROFILE?.toLowerCase()) {
    throw new Error('The user profile directory cannot be used as the workspace.');
  }
  if (inside(target, privateHome) || inside(privateHome, target)) {
    throw new Error('A directory containing the harness configuration/credentials cannot be used as the workspace.');
  }
  return target;
}

function run(command, args, cwd, signal, input, env) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd, windowsHide: true, shell: false,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'spawn failed' });
      return;
    }
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', c => { stdout = (stdout + c).slice(0, 2_000_000); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(0, 20000); });
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// git with a failure turned into an Error carrying git's own message.
async function git(args, cwd, { signal, input, env } = {}) {
  const result = await run('git', args, cwd, signal, input, env);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 3).join(' ');
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function parseStatus(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 500)
    .map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

// Returns null when the workspace is not a git repo — that is a normal state,
// not an error, but it does mean we cannot offer a rollback guarantee.
export async function gitStatus(workspace, signal) {
  const result = await run('git', ['status', '--porcelain'], workspace, signal);
  if (result.code !== 0) return null;
  return parseStatus(result.stdout);
}

export function diffStatus(before, after) {
  if (!before || !after) return null;
  const key = entry => `${entry.status} ${entry.path}`;
  const seen = new Set(before.map(key));
  return after.filter(entry => !seen.has(key(entry)));
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

// The repository root the workspace belongs to, or null outside git.
export async function gitToplevel(workspace, signal) {
  const result = await run('git', ['rev-parse', '--show-toplevel'], workspace, signal);
  if (result.code !== 0) return null;
  const top = result.stdout.trim();
  if (!top) return null;
  try { return await realpath(top); } catch { return path.resolve(top); }
}

// "In C:\repo\src fix the nav overflow in header.tsx" → "fix-the-nav-overflow"
// Paths and URLs in the task say nothing about it, so they are dropped first.
const STOPWORDS = new Set(['in', 'the', 'a', 'an', 'of', 'to', 'and', 'on', 'for', 'at', 'please', 'this', 'that', 'with']);
export function slugify(text, max = 24) {
  const words = String(text ?? '')
    .replace(/[a-z]+:\/\/[^\s"'`]*/gi, ' ')         // URLs (before drive letters: "s://…")
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, ' ')     // Windows paths
    .replace(/(?:^|\s)\/[^\s"'`]+/g, ' ')          // POSIX paths
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w && !STOPWORDS.has(w));
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > max) break;
    slug = next;
  }
  if (!slug && words.length) slug = words[0].slice(0, max);
  return slug || 'task';
}

function validBranch(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(name)
    && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//') && !name.includes('@{');
}

// `.dsh/` is excluded through .git/info/exclude rather than .gitignore: it is
// local to this clone, never shows up as a change, and ripgrep-based tools
// (Claude Code's included) honour it, so worktree contents stay out of the
// parent's searches too.
async function ensureExcluded(repo, signal) {
  const gitDir = (await git(['rev-parse', '--git-common-dir'], repo, { signal })).trim();
  const excludeFile = path.resolve(repo, gitDir, 'info', 'exclude');
  let current = '';
  try { current = await readFile(excludeFile, 'utf8'); } catch { /* absent */ }
  if (current.split(/\r?\n/).some(line => line.trim() === '.dsh/' || line.trim() === '/.dsh/' || line.trim() === '.dsh')) return;
  await mkdir(path.dirname(excludeFile), { recursive: true });
  await appendFile(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}# DSH-Sub-MCP worktrees and skills\n.dsh/\n`);
}

async function branchExists(repo, branch, signal) {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, signal);
  return result.code === 0;
}

// Creates <repo>/.dsh/worktrees/<name> on a new branch from `base`. `workspace`
// may be a subdirectory of the repo; the returned `cwd` is the same
// subdirectory inside the worktree, so relative paths in the task keep working.
export async function createWorktree({ workspace, task, branch, base = 'HEAD', signal }) {
  const repo = await gitToplevel(workspace, signal);
  if (!repo) throw new Error('isolation: "worktree" needs a git repository; the workspace is not inside one.');
  const baseSha = (await run('git', ['rev-parse', '--verify', `${base}^{commit}`], repo, signal));
  if (baseSha.code !== 0) {
    throw new Error(`Cannot resolve base "${base}" to a commit${base === 'HEAD' ? ' — the repository needs at least one commit' : ''}.`);
  }
  if (branch !== undefined && branch !== null && branch !== '' && !validBranch(branch)) {
    throw new Error(`branch "${branch}" is not a valid git branch name.`);
  }
  const suffix = randomBytes(2).toString('hex');
  let name;
  if (branch) {
    name = branch;
    if (await branchExists(repo, name, signal)) throw new Error(`Branch "${name}" already exists. Pick another name, or omit branch to get one generated.`);
  } else {
    name = `${BRANCH_PREFIX}${slugify(task)}-${suffix}`;
    while (await branchExists(repo, name, signal)) name = `${BRANCH_PREFIX}${slugify(task)}-${randomBytes(2).toString('hex')}`;
  }
  const dirName = name.startsWith(BRANCH_PREFIX) ? name.slice(BRANCH_PREFIX.length) : name;
  const wtPath = path.join(repo, WORKTREE_DIR, dirName.replace(/[\\/]/g, '-'));
  try { await stat(wtPath); throw new Error(`Worktree directory already exists: ${wtPath}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  await ensureExcluded(repo, signal);
  await mkdir(path.dirname(wtPath), { recursive: true });
  await git(['worktree', 'add', '--lock', '--reason', 'DSH-Sub-MCP delegation in progress', '-b', name, wtPath, baseSha.stdout.trim()], repo, { signal });

  const rel = path.relative(repo, workspace);
  const cwd = rel && !rel.startsWith('..') ? path.join(wtPath, rel) : wtPath;
  const sha = baseSha.stdout.trim();
  // `start` is the tree the agent's work is measured against; the caller
  // re-snapshots it after linking/copying/carrying files in (snapshotTree).
  const start = (await git(['rev-parse', `${sha}^{tree}`], repo, { signal })).trim();
  return { repo, path: wtPath, cwd, branch: name, base: sha, baseRef: base, start, links: [], copied: 0 };
}

// Junction (Windows) / symlink the named gitignored directories of the main
// checkout into the worktree, e.g. node_modules, so tests can run without a
// fresh install. Writes through the link land outside the agent's sandbox
// root and are refused, which is the point: the shared directory is read-only
// to it. Returns the names actually linked.
export async function linkDirs(worktree, names, signal) {
  const linked = [];
  for (const raw of names ?? []) {
    const name = String(raw).replace(/[\\/]+$/, '');
    if (!name || name.includes('..') || path.isAbsolute(name)) continue;
    const source = path.join(worktree.repo, name);
    const target = path.join(worktree.path, name);
    let info;
    try { info = await lstat(source); } catch { continue; }
    if (!info.isDirectory()) continue;
    // Only ignored directories: a tracked one is already in the checkout.
    const ignored = await run('git', ['check-ignore', '-q', name], worktree.repo, signal);
    if (ignored.code !== 0) continue;
    try { await lstat(target); continue; } catch { /* absent, good */ }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
    } catch { /* leave it out; the agent can install */ }
  }
  worktree.links = linked;
  return linked;
}

// Copy files matching .worktreeinclude (gitignore syntax) that are themselves
// gitignored — .env and friends — from the main checkout into the worktree.
// Patterns are turned into git pathspecs: a bare name matches at any depth,
// a pattern with a slash is anchored, like gitignore.
export async function copyWorktreeInclude(worktree, signal) {
  let spec;
  try { spec = await readFile(path.join(worktree.repo, WORKTREE_INCLUDE), 'utf8'); } catch { return 0; }
  const patterns = spec.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'));
  if (!patterns.length) return 0;
  const pathspecs = [];
  for (const p of patterns) {
    const clean = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    if (p.includes('/') && !p.startsWith('**/')) pathspecs.push(`:(glob)${clean}`, `:(glob)${clean}/**`);
    else pathspecs.push(`:(glob)${clean}`, `:(glob)**/${clean}`, `:(glob)**/${clean}/**`);
  }
  const out = await run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...pathspecs], worktree.repo, signal);
  if (out.code !== 0) return 0;
  const files = out.stdout.split('\0').filter(Boolean).filter(f => !f.startsWith('.dsh/')).slice(0, MAX_INCLUDE_FILES);
  let copied = 0;
  for (const file of files) {
    const from = path.join(worktree.repo, file);
    const to = path.join(worktree.path, file);
    try {
      if (!(await lstat(from)).isFile()) continue;
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      copied += 1;
    } catch { /* skip */ }
  }
  worktree.copied = copied;
  return copied;
}

// Bring the parent's uncommitted work (tracked changes + untracked files) into
// the worktree, so the agent starts from what the parent actually sees.
export async function carryUncommitted(worktree, signal) {
  const patch = await git(['diff', '--binary', 'HEAD'], worktree.repo, { signal });
  if (patch.trim()) await git(['apply', '--binary', '--whitespace=nowarn'], worktree.path, { signal, input: patch });
  const untracked = (await git(['ls-files', '-z', '--others', '--exclude-standard'], worktree.repo, { signal })).split('\0').filter(Boolean);
  let copied = 0;
  for (const file of untracked.slice(0, MAX_INCLUDE_FILES)) {
    const to = path.join(worktree.path, file);
    try {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(worktree.repo, file), to);
      copied += 1;
    } catch { /* skip */ }
  }
  return { patched: Boolean(patch.trim()), untracked: copied };
}

export async function lockWorktree(worktree, reason, signal) {
  await run('git', ['worktree', 'lock', '--reason', reason, worktree.path], worktree.repo, signal);
}
export async function unlockWorktree(worktree, signal) {
  await run('git', ['worktree', 'unlock', worktree.path], worktree.repo, signal);
}

export async function worktreeExists(worktree) {
  try {
    await stat(worktree.path);
    // The .git file marks a checkout; a bare directory left behind is not one.
    await stat(path.join(worktree.path, '.git'));
    return true;
  } catch { return false; }
}

// A tree object of the worktree's current files (tracked, modified and
// untracked alike; ignored ones excluded), built through a throwaway index so
// the real index is never touched. Comparing two such trees is how the
// agent's own change is told apart from what it was handed: the snapshot taken
// right after creation (`worktree.start`) already holds anything carried over
// from the parent's uncommitted work.
export async function snapshotTree(worktree, signal) {
  const tmpIndex = path.join(tmpdir(), `dsh-sub-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(['add', '-A', '--', '.'], worktree.path, { signal, env });
    return (await git(['write-tree'], worktree.path, { signal, env })).trim();
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

const startOf = worktree => worktree.start ?? worktree.base;

// Uncommitted entries and commits on top of the base both count as work; the
// worktree is clean only when its files equal the starting snapshot.
export async function worktreeState(worktree, signal) {
  const status = parseStatus(await git(['status', '--porcelain'], worktree.path, { signal }));
  const ahead = (await git(['rev-list', '--count', `${worktree.base}..HEAD`], worktree.path, { signal })).trim();
  const commits = Number(ahead) || 0;
  const tree = await snapshotTree(worktree, signal);
  return { status, commits, tree, clean: commits === 0 && tree === startOf(worktree) };
}

export async function worktreeDiff(worktree, signal) {
  const tree = await snapshotTree(worktree, signal);
  const stat = await git(['diff', '--stat', startOf(worktree), tree], worktree.path, { signal });
  const full = await git(['diff', startOf(worktree), tree], worktree.path, { signal });
  const truncated = full.length > MAX_DIFF_BYTES;
  return { stat: stat.trim(), patch: truncated ? full.slice(0, MAX_DIFF_BYTES) : full, truncated };
}

// Commit everything in the worktree on its branch, on the agent's behalf.
export async function commitWorktree(worktree, message, signal) {
  await git(['add', '-A'], worktree.path, { signal });
  const staged = await run('git', ['diff', '--cached', '--quiet'], worktree.path, signal);
  if (staged.code === 0) return null;
  await git(['-c', 'user.name=DSH-Sub-MCP', '-c', 'user.email=dsh-sub-mcp@localhost', 'commit', '-q', '-m', message], worktree.path, { signal });
  return (await git(['rev-parse', '--short', 'HEAD'], worktree.path, { signal })).trim();
}

// Apply the agent's change (everything since the starting snapshot, committed
// or not) onto the main checkout without committing there.
export async function applyWorktree(worktree, signal) {
  const tree = await snapshotTree(worktree, signal);
  const patch = await git(['diff', '--binary', startOf(worktree), tree], worktree.path, { signal });
  if (!patch.trim()) return { applied: false, files: [] };
  const files = (await git(['diff', '--name-only', startOf(worktree), tree], worktree.path, { signal })).split(/\r?\n/).filter(Boolean);
  // Working tree only: `--3way` would need the index to match the working
  // tree, which is exactly not the case when the parent has work in progress.
  // A patch that does not fit is refused whole — git apply is atomic — and the
  // parent is pointed at commit + merge, where git does a real 3-way merge.
  const check = await run('git', ['apply', '--check', '--binary', '--whitespace=nowarn'], worktree.repo, signal, patch);
  if (check.code !== 0) {
    const why = (check.stderr || check.stdout).trim().split(/\r?\n/).slice(0, 3).join(' ');
    throw new Error(`The change does not apply cleanly onto your working tree (${why}). `
      + `Use action "commit" and then \`git merge ${worktree.branch}\` for a proper 3-way merge, or resolve by hand from the diff.`);
  }
  await git(['apply', '--binary', '--whitespace=nowarn'], worktree.repo, { signal, input: patch });
  return { applied: true, files };
}

// Removal order matters on Windows: `git worktree remove` does not follow a
// junction into the main checkout, but leaves the link (and so the directory)
// behind; unlinking first, ourselves, is what makes the directory go away.
export async function removeWorktree(worktree, { deleteBranch = true, signal } = {}) {
  const notes = [];
  for (const name of worktree.links ?? []) {
    const link = path.join(worktree.path, name);
    try { if ((await lstat(link)).isSymbolicLink()) await rm(link, { recursive: false, force: true }); } catch { /* gone */ }
  }
  if (await worktreeExists(worktree)) {
    await unlockWorktree(worktree, signal);
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await run('git', ['worktree', 'remove', '--force', worktree.path], worktree.repo, signal);
      if (last.code === 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (last.code !== 0) throw new Error(`git worktree remove failed: ${(last.stderr || last.stdout).trim().split(/\r?\n/)[0]}. Close programs using ${worktree.path} and retry, or run it by hand.`);
  } else {
    await run('git', ['worktree', 'prune'], worktree.repo, signal);
  }
  try { await rm(worktree.path, { recursive: true, force: true }); } catch { /* already gone */ }
  if (deleteBranch && await branchExists(worktree.repo, worktree.branch, signal)) {
    const merged = await run('git', ['branch', '--merged', 'HEAD', '--list', worktree.branch], worktree.repo, signal);
    const isMerged = merged.stdout.trim().length > 0;
    const ahead = (await run('git', ['rev-list', '--count', `${worktree.base}..${worktree.branch}`], worktree.repo, signal)).stdout.trim();
    if (isMerged || ahead === '0') {
      await run('git', ['branch', '-D', worktree.branch], worktree.repo, signal);
      notes.push(`branch ${worktree.branch} deleted`);
    } else {
      notes.push(`branch ${worktree.branch} kept (has ${ahead} unmerged commit${ahead === '1' ? '' : 's'}); delete with: git branch -D ${worktree.branch}`);
    }
  }
  return notes;
}

// The parent writes tasks with absolute paths into its own checkout; inside
// the worktree those must point at the worktree's copy. Path separators are
// matched either way and, on Windows, case-insensitively.
export function rewritePaths(text, from, to) {
  if (!text || !from || samePath(from, to)) return text;
  const parts = path.resolve(from).split(/[\\/]+/).filter(Boolean).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(parts.join('[\\\\/]+') + '(?![A-Za-z0-9_-])', process.platform === 'win32' ? 'gi' : 'g');
  return text.replace(pattern, () => to);
}
