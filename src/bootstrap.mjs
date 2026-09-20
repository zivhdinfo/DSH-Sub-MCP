// Scaffolds the DSH profile and regenerates the loader patch with absolute paths,
// so the project keeps working after the folder is moved.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readDeepSeekLive } from './deepseek-live.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so a second instance (e.g. for testing) can run beside the live
// one without sharing state or a port.
export const home = process.env.DSH_SUB_HOME ? path.resolve(process.env.DSH_SUB_HOME) : path.join(projectRoot, '.dsh-sub');
export const profileName = 'web';
export const port = Number(process.env.DSH_SUB_PORT) || 3083;

const patchFile = path.join(home, 'sub.patch.json');
const pluginEntry = path.join(projectRoot, 'src', 'mcp-plugin.mjs');

// GET /models returns ids only, so modality/prompt metadata has to come from
// somewhere. These mirror the adapter's own built-in entries; unknown ids stay
// text-only, which fails loudly on image input instead of silently misbehaving.
const CAPABILITIES = {
  'deepseek-flash': { inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' },
};

async function writeIfAbsent(file, content) {
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

async function scaffoldProfile() {
  const dir = path.join(home, 'profiles', profileName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    name: 'dsh-sub-mcp-profile',
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live',
      },
    },
  };
  await writeIfAbsent(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Both files must be a valid top-level YAML array. A comments-only file fails
  // boot with an error that looks like a port problem.
  await writeIfAbsent(path.join(dir, 'cordis.yml'), '# Composed from dsh.profile.bundles; edit cordis.patch.yml instead.\n[]\n');
  await writeIfAbsent(path.join(dir, 'cordis.patch.yml'), '# Profile patch layer. Runtime overrides live in sub.patch.json.\n[]\n');
  return dir;
}

// The llm-deepseek adapter serves exactly the ids we hand it here; the live
// probe (deepseek-live.mjs) keeps that list free of retired ids. Other
// providers are configured by the user in settings.yaml and need nothing here.
function catalogForAdapter(models) {
  return models.map(m => ({
    id: m.id,
    name: m.name || m.id,
    ...(CAPABILITIES[m.id] ?? {}),
  }));
}

export async function build() {
  await mkdir(home, { recursive: true });
  const profileDir = await scaffoldProfile();
  const live = await readDeepSeekLive(home);

  const patch = [
    // dsh-web-app disables the base agent-plane tools and re-exposes them through
    // GUI presets, which leaves ctx.tools empty. Our subagents restrict against
    // the global registry, so these four have to come back.
    { id: 'tool-fs', disabled: false },
    { id: 'tool-fs-search', disabled: false },
    { id: 'tool-bash', disabled: false },
    { id: 'tool-pwsh', disabled: false },
    {
      id: 'llm-deepseek',
      config: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com',
        reasoningEffort: 'high',
        maxTokens: 32768,
        models: catalogForAdapter(live.models),
      },
    },
    // The harness's own chat UI still needs a process-wide default; delegations
    // pick their model explicitly (see models.mjs).
    {
      id: 'agent-default-model',
      config: { provider: 'deepseek-official', model: live.preferredModel() },
    },
    { insert: [{ id: 'deepseek-sub-mcp', name: pluginEntry }] },
  ];

  await writeFile(patchFile, JSON.stringify(patch, null, 2));
  return { patchFile, profileDir, home, port, deepseek: live.snapshot() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await build();
  const { models, stale, checkedAt } = result.deepseek;
  console.log(`DSH-Sub-MCP prepared: ${result.patchFile}`);
  console.log(`DeepSeek models (${models.length}): ${models.map(m => m.id).join(', ')}`);
  console.log(`Checked: ${checkedAt ?? 'never'}${stale ? ' | STALE — will be re-probed when the harness starts' : ''}`);
}
