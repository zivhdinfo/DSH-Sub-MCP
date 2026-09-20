// Live DeepSeek model probe. The adapter's built-in catalog is stale by design
// (it still lists retired ids), so for the `deepseek-official` route the API is
// the only source of truth for "is this id still served". This is enrichment
// only: which models exist and which are enabled for delegation is decided by
// the harness-backed directory in models.mjs. bootstrap.mjs also reads this
// cache to seed the llm-deepseek adapter config.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const CATALOG_URL = 'https://api.deepseek.com/models';

// Only reached on a first run with no cache and no reachable API.
export const SEED = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro-0813' },
];

// Preference order for the harness's own default model (chat UI); first surviving entry wins.
export const PREFERRED = ['deepseek-flash', 'deepseek-v4-pro'];

const clean = value => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : '');

export function normalizeModels(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid model catalog');
  const seen = new Set();
  return rows.flatMap(row => {
    const id = row?.id ?? row?.model;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x20\x7f]/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: clean(row.displayName ?? row.name ?? row.label) || id }];
  });
}

export async function fetchCatalog(apiKey, signal) {
  const response = await fetch(CATALOG_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`DeepSeek /models returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024) throw new Error('Catalog too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return normalizeModels(JSON.parse(Buffer.concat(chunks).toString('utf8')).data);
}

export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
}

export class DeepSeekLive {
  constructor(home) {
    this.file = path.join(home, 'deepseek-live.json');
    // The pre-1.2 cache carried the enabled switches too; models.mjs migrates
    // those, we only salvage the served-id list from it on first boot.
    this.legacyFile = path.join(home, 'model-catalog.json');
    this.models = [];
    this.checkedAt = null;
    this.stale = true;
    this.message = '';
    this.pending = null;
    this.lastRefresh = 0;
  }

  async load() {
    let raw = null;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch { /* first run */ }
    if (!raw) {
      try {
        const legacy = JSON.parse(await readFile(this.legacyFile, 'utf8'));
        if (Array.isArray(legacy?.models)) {
          raw = { checkedAt: legacy.checkedAt, models: legacy.models.filter(m => m.listed !== false).map(m => ({ id: m.model, name: m.label })) };
        }
      } catch { /* no legacy cache either */ }
    }
    try {
      this.models = normalizeModels(raw?.models || []);
      this.checkedAt = typeof raw?.checkedAt === 'string' ? raw.checkedAt : null;
    } catch { this.models = []; }
    this.stale = true;
    this.message = this.models.length
      ? 'Loaded from cache; not yet verified against the DeepSeek API in this session.'
      : 'No cache and the DeepSeek API has not been probed yet — using the fallback list.';
    if (!this.models.length) this.models = SEED.map(m => ({ ...m }));
    return this.snapshot();
  }

  snapshot() {
    return { checkedAt: this.checkedAt, stale: this.stale, message: this.message, models: this.models.map(m => ({ ...m })) };
  }

  ids() { return this.models.map(m => m.id); }

  // null = unknown (never verified); otherwise whether the API still serves it.
  isListed(id) {
    if (this.stale && !this.checkedAt) return null;
    return this.models.some(m => m.id === id);
  }

  preferredModel() {
    for (const id of PREFERRED) if (this.models.some(m => m.id === id)) return id;
    return this.models[0]?.id ?? SEED[0].id;
  }

  async refresh(resolveKey, { force = false, signal } = {}) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.lastRefresh < 60000) return this.snapshot();
    this.pending = this.#refresh(resolveKey, signal).finally(() => {
      this.pending = null;
      this.lastRefresh = Date.now();
    });
    return this.pending;
  }

  async #refresh(resolveKey, signal) {
    let apiKey;
    try { apiKey = await resolveKey(); } catch { apiKey = null; }
    if (!apiKey) {
      this.stale = true;
      this.message = 'No DeepSeek API key configured. Open the DSH UI → Settings → Models to add one.';
      return this.snapshot();
    }
    try {
      this.models = await fetchCatalog(apiKey, signal);
      this.checkedAt = new Date().toISOString();
      this.stale = false;
      this.message = '';
      await atomicWrite(this.file, JSON.stringify({ checkedAt: this.checkedAt, models: this.models }, null, 2)).catch(() => {
        this.message = 'Could not write the DeepSeek model cache; the next start will probe again.';
      });
    } catch (error) {
      this.stale = true;
      this.message = `Could not fetch the DeepSeek model list (${error.message}). Using cached data.`;
    }
    return this.snapshot();
  }
}

// Used by bootstrap.mjs, which runs outside the harness and has no ctx.credentials.
export async function readDeepSeekLive(home) {
  const live = new DeepSeekLive(home);
  await live.load();
  return live;
}
