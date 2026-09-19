// Workspace validation and git evidence. The parent agent supplies a path over
// MCP, so it is untrusted input and gets the same checks DSH Team applies.
import { lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const inside = (base, child) => {
  const rel = path.relative(base, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

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

function run(command, args, cwd, signal) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'spawn failed' });
      return;
    }
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', c => { stdout = (stdout + c).slice(0, 200000); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(0, 20000); });
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      resolve({ code, stdout, stderr });
    });
  });
}

// Returns null when the workspace is not a git repo — that is a normal state,
// not an error, but it does mean we cannot offer a rollback guarantee.
export async function gitStatus(workspace, signal) {
  const result = await run('git', ['status', '--porcelain'], workspace, signal);
  if (result.code !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 500)
    .map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

export function diffStatus(before, after) {
  if (!before || !after) return null;
  const key = entry => `${entry.status} ${entry.path}`;
  const seen = new Set(before.map(key));
  return after.filter(entry => !seen.has(key(entry)));
}
