// stdio MCP bridge. Claude Code / Codex spawn THIS, which is instant, and it
// brings the heavy DSH harness up in the background on demand. That is what makes
// the server start itself instead of the user starting it by hand.
//
// Registered with:  claude mcp add deepseek -- node <abs>/src/mcp-stdio.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.DSH_SUB_HOME ? path.resolve(process.env.DSH_SUB_HOME) : path.join(projectRoot, '.dsh-sub');
const port = Number(process.env.DSH_SUB_PORT) || 3083;
const endpoint = `http://127.0.0.1:${port}/mcp`;
const BOOT_TIMEOUT_MS = 90000;

const log = message => process.stderr.write(`[deepseek-bridge] ${message}\n`);

function portFree() {
  return new Promise(resolve => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function endpointReady() {
  try {
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(2000) });
    // The web server starts listening before our plugin registers /mcp, and during
    // that window the SPA fallback answers 404. Only an unauthenticated POST that
    // our own handler rejects with 401 proves the route is actually mounted.
    return response.status === 401;
  } catch {
    return false;
  }
}

function readToken() {
  const file = path.join(home, 'mcp-token.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

let harnessPromise = null;
function ensureHarness() {
  harnessPromise ??= (async () => {
    if (await endpointReady()) {
      log('harness already running');
      return;
    }
    if (!(await portFree())) {
      // Something else holds the port; surface it rather than spawning a rival.
      throw new Error(`port ${port} is held by another process`);
    }
    log('starting harness in the background...');
    // detached + stdio:'ignore' + windowsHide gives DETACHED_PROCESS on Windows:
    // the harness gets no console at all (so no terminal pops up) and outlives
    // this bridge, so the next session finds it already warm. Dropping `detached`
    // would tie it to the bridge and kill it whenever the parent exits.
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'serve.mjs'), '--no-open'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 700));
      if (await endpointReady()) {
        log('harness ready');
        return;
      }
    }
    throw new Error(`harness not ready after ${BOOT_TIMEOUT_MS / 1000}s — see ${path.join(home, 'web.err.log')}`);
  })();
  return harnessPromise;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function forward(request) {
  await ensureHarness();
  const token = readToken();
  if (!token) throw new Error('mcp-token.txt not found — run `npm start` once to initialise');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`harness returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const inFlight = new Set();

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // Not our business to answer unparseable frames.
  }
  try {
    const reply = await forward(request);
    // Notifications carry no id and expect no response.
    if (reply && request.id !== undefined) send(reply);
  } catch (error) {
    if (request.id === undefined) {
      log(String(error.message || error));
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: String(error.message || error) },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  const task = handle(line).finally(() => inFlight.delete(task));
  inFlight.add(task);
});

// Exiting the moment stdin closes would abandon replies that are still waiting on
// a harness that is only just booting.
rl.on('close', async () => {
  await Promise.allSettled([...inFlight]);
  process.exit(0);
});

// Warm the harness while the parent is still starting up, so the first real tool
// call does not pay the boot cost.
ensureHarness().catch(error => log(String(error.message || error)));
