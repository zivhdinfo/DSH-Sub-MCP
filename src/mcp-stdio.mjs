// stdio MCP bridge. Claude Code / Codex spawn THIS, which is instant, and it
// brings the heavy DSH harness up in the background on demand. That is what makes
// the server start itself instead of the user starting it by hand.
//
// Registered with:  claude mcp add deepseek -- node <abs>/src/mcp-stdio.mjs
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
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

// Minimal SSE reader: yields the JSON payload of every `data:` event. The
// harness streams progress notifications this way while a tool call runs.
function readSse(res, onEvent) {
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', chunk => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue; // comments / keep-alives
      try { onEvent(JSON.parse(data)); } catch { log(`unparseable SSE event: ${data.slice(0, 200)}`); }
    }
  });
}

// Plain node:http, deliberately NOT fetch(): the fetch client caps the wait for
// response headers at 300s (undici default), which silently aborted every
// delegation longer than five minutes. A tool call here legitimately runs for
// many minutes, and the harness enforces its own timeoutSec, so the bridge
// imposes no time limit of its own.
async function forward(request, { signal, onNotification } = {}) {
  await ensureHarness();
  const token = readToken();
  if (!token) throw new Error('mcp-token.txt not found — run `npm start` once to initialise');
  const body = JSON.stringify(request);

  return new Promise((resolve, reject) => {
    const req = httpRequest(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 202) { res.resume(); resolve(null); return; }
      if (res.statusCode !== 200) {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text = (text + c).slice(0, 300); });
        res.on('end', () => reject(new Error(`harness returned HTTP ${res.statusCode}: ${text}`)));
        return;
      }
      if (type.startsWith('text/event-stream')) {
        let answered = false;
        readSse(res, event => {
          if (event && typeof event === 'object' && event.id !== undefined && ('result' in event || 'error' in event)) {
            answered = true;
            resolve(event);
          } else {
            onNotification?.(event);
          }
        });
        res.on('end', () => { if (!answered) reject(new Error('harness closed the stream without answering')); });
        res.on('error', reject);
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        try { resolve(text ? JSON.parse(text) : null); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(0);
    req.on('error', reject);
    if (signal) {
      const abort = () => req.destroy(new Error('cancelled by the parent'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }
    req.end(body);
  });
}

const inFlight = new Set();
// Request id → controller, so a `notifications/cancelled` from the parent (Esc,
// or its own timeout) closes that HTTP request; the harness sees the socket
// drop and stops the foreground delegation instead of burning tokens unheard.
const cancellers = new Map();

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // Not our business to answer unparseable frames.
  }
  if (request.method === 'notifications/cancelled') {
    const id = request.params?.requestId;
    const controller = cancellers.get(id);
    if (controller) { controller.abort(); log(`cancelled request ${id}`); }
    return; // The harness is stateless per request; only the socket matters.
  }
  const controller = new AbortController();
  controller.method = request.method;
  if (request.id !== undefined) cancellers.set(request.id, controller);
  try {
    const reply = await forward(request, {
      signal: controller.signal,
      // Progress and other notifications belong to the parent, unchanged.
      onNotification: notification => { if (notification?.method) send(notification); },
    });
    // Notifications carry no id and expect no response.
    if (reply && request.id !== undefined) send(reply);
  } catch (error) {
    if (request.id === undefined) {
      log(String(error.message || error));
      return;
    }
    if (controller.signal.aborted) return; // The parent already gave up on this id.
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: String(error.message || error) },
    });
  } finally {
    if (request.id !== undefined) cancellers.delete(request.id);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  const task = handle(line).finally(() => inFlight.delete(task));
  inFlight.add(task);
});

// The parent is gone once stdin closes. Quick replies (initialize, tools/list)
// still get answered in case it is only draining; foreground tool calls are cut
// so the harness stops those agents instead of working for nobody. Background
// delegations live in the harness and are unaffected.
rl.on('close', async () => {
  for (const controller of cancellers.values()) {
    if (controller.method === 'tools/call') controller.abort();
  }
  await Promise.allSettled([...inFlight]);
  process.exit(0);
});

// Warm the harness while the parent is still starting up, so the first real tool
// call does not pay the boot cost.
ensureHarness().catch(error => log(String(error.message || error)));
