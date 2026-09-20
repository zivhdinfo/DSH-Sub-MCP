// The single entry point. Runs in the foreground: Ctrl+C (or closing the window)
// stops it, which is why this project needs no PID file and no stop script.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { build, home, projectRoot, port } from './bootstrap.mjs';

function portFree(p) {
  return new Promise(resolve => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(p, '127.0.0.1');
  });
}

// `--wait`: the restart button in the settings page launches us while the old
// harness is still shutting down, so give the port a moment to free up.
if (process.argv.includes('--wait')) {
  const deadline = Date.now() + 30000;
  while (!(await portFree(port)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 300));
}

if (!(await portFree(port))) {
  console.error(`\nPort ${port} is busy — DSH-Sub-MCP may already be running in another window.`);
  console.error('Close that window (or Ctrl+C) and run again.\n');
  process.exit(1);
}

const { patchFile } = await build();
const entry = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// Started in the background there is no console to print to, so stderr goes to a
// file instead of being lost.
const headless = process.argv.includes('--no-open');
const errSink = headless ? openSync(path.join(home, 'web.err.log'), 'a') : 'inherit';
const outLog = headless ? openSync(path.join(home, 'web.out.log'), 'a') : null;

const child = spawn(
  process.execPath,
  [entry, 'web', '--patch', patchFile, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
  {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', errSink],
    windowsHide: true,
  },
);

const autoOpen = !headless;

let opened = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  if (outLog !== null) writeSync(outLog, chunk); else process.stdout.write(chunk);
  if (opened || !autoOpen) return;
  // The harness prints its authenticated URL once it is listening.
  const match = chunk.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/);
  if (!match) return;
  opened = true;
  // The plugin writes this during boot, before the harness announces its URL.
  // /setup exchanges the MCP token for the harness's own browser session and
  // lands in the DSH UI with Settings → DeepSeek Sub-agent open.
  const key = readFileSync(path.join(home, 'mcp-token.txt'), 'utf8').trim();
  const setupUrl = `http://127.0.0.1:${port}/setup?key=${key}`;
  console.log(`\n  Settings page : ${setupUrl}`);
  console.log(`  Chat UI       : ${match[1]}`);
  console.log(`  MCP endpoint  : http://127.0.0.1:${port}/mcp`);
  console.log('\n  Ctrl+C to stop.\n');
  spawn('cmd', ['/c', 'start', '', setupUrl], { detached: true, stdio: 'ignore' }).unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
child.on('exit', code => process.exit(code ?? 0));
