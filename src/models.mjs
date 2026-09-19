// Live DeepSeek model discovery. The adapter's built-in catalog is stale by design
// (it still lists retired ids), so the API is the only source of truth we trust.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const CATALOG_URL = 'https://api.deepseek.com/models';
export const PROVIDER = 'deepseek-official';

// Only reached on a first run with no cache and no reachable API. Always flagged stale.
export const SEED = [
  { model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', listed: true },
  { model: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro-0813', listed: true },
];

// Preference order when nothing is pinned; first surviving entry wins.
export const PREFERRED = ['deepseek-flash', 'deepseek-v4-pro'];

const clean = value => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : '');

export function normalizeModels(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid model catalog');
  const seen = new Set();
  return rows.flatMap(row => {
    const id = row?.id ?? row?.model;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x20\x7f]/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ model: id, label: clean(row.displayName ?? row.label) || id }];
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

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
}

export class Catalog {
  constructor(home) {
    this.file = path.join(home, 'model-catalog.json');
    this.models = [];
    this.checkedAt = null;
    this.stale = true;
    this.message = '';
    this.pending = null;
    this.lastRefresh = 0;
  }

  // A cache we wrote ourselves is still revalidated: only known fields survive.
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const listed = new Map((raw.models || []).map(m => [m.model, m.listed !== false]));
      const enabled = new Map((raw.models || []).map(m => [m.model, m.enabled !== false]));
      this.models = normalizeModels(raw.models || []).map(m => ({
        ...m,
        listed: listed.get(m.model) !== false,
        enabled: enabled.get(m.model) !== false,
      }));
      this.checkedAt = typeof raw.checkedAt === 'string' ? raw.checkedAt : null;
      this.stale = true;
      this.message = 'Loaded from cache; not yet verified against the API in this session.';
    } catch {
      this.models = [];
      this.message = '';
    }
    if (!this.models.length) {
      this.models = SEED.map(m => ({ ...m }));
      this.stale = true;
      this.message = 'No cache and the API has not been probed yet — using the fallback list.';
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      provider: PROVIDER,
      models: this.models.map(m => ({ ...m })),
      defaultModel: this.defaultModel(),
      catalogCheckedAt: this.checkedAt,
      catalogStale: this.stale,
      message: this.message,
    };
  }

  listedModels() { return this.models.filter(m => m.listed); }

  // Usable = still served by the API AND not switched off by the user.
  usableModels() { return this.models.filter(m => m.listed && m.enabled !== false); }

  defaultModel() {
    const usable = this.usableModels();
    for (const id of PREFERRED) if (usable.some(m => m.model === id)) return id;
    return usable[0]?.model ?? this.listedModels()[0]?.model ?? this.models[0]?.model ?? SEED[0].model;
  }

  async setEnabled(id, enabled) {
    const hit = this.models.find(m => m.model === id);
    if (!hit) throw new Error(`No such model "${id}".`);
    if (!enabled && this.usableModels().filter(m => m.model !== id).length === 0) {
      throw new Error('At least one model must remain enabled.');
    }
    hit.enabled = enabled;
    await this.persist();
    return this.snapshot();
  }

  async persist() {
    await atomicWrite(this.file, JSON.stringify({ checkedAt: this.checkedAt, models: this.models }, null, 2));
  }

  // Unknown ids are rejected; retired ids are allowed but reported, because the
  // adapter still accepts unlisted ids and DeepSeek keeps them aliased for a while.
  resolve(requested) {
    if (requested === undefined || requested === null || requested === '') {
      return { model: this.defaultModel(), warning: null };
    }
    if (typeof requested !== 'string') throw new Error('model must be a string.');
    const hit = this.models.find(m => m.model === requested);
    if (!hit) {
      const available = this.usableModels().map(m => m.model).join(', ') || '(none)';
      throw new Error(`Model "${requested}" is not in DeepSeek's current catalog. Available: ${available}. Call deepseek_models for the latest list.`);
    }
    if (hit.enabled === false) {
      throw new Error(`Model "${hit.model}" is disabled in the control panel. Enabled: ${this.usableModels().map(m => m.model).join(', ') || '(none)'}.`);
    }
    return {
      model: hit.model,
      warning: hit.listed ? null : `Model "${hit.model}" is no longer listed by the DeepSeek API (likely retired, temporarily aliased). Consider switching to: ${this.defaultModel()}.`,
    };
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
      this.message = 'No DeepSeek API key configured. Open http://127.0.0.1:3083 → Settings → Models to add one.';
      return this.snapshot();
    }
    try {
      const fresh = await fetchCatalog(apiKey, signal);
      const seen = new Set(fresh.map(m => m.model));
      // The user's on/off choice is theirs, not the API's, so it survives a refresh.
      const wasEnabled = new Map(this.models.map(m => [m.model, m.enabled !== false]));
      // Anything we knew about that the API no longer serves is retired, not deleted:
      // keeping it lets us warn precisely instead of failing with "unknown model".
      const retired = this.models.filter(m => !seen.has(m.model)).map(m => ({ ...m, listed: false }));
      this.models = [
        ...fresh.map(m => ({ ...m, listed: true, enabled: wasEnabled.get(m.model) !== false })),
        ...retired,
      ];
      this.checkedAt = new Date().toISOString();
      this.stale = false;
      this.message = '';
      await this.persist().catch(() => {
        this.message = 'Could not write the model cache; the next start will probe again.';
      });
    } catch (error) {
      this.stale = true;
      this.message = `Could not fetch the model list (${error.message}). Using cached data.`;
    }
    return this.snapshot();
  }
}

// Used by bootstrap.mjs, which runs outside the harness and has no ctx.credentials.
export async function readCachedModels(home) {
  const catalog = new Catalog(home);
  await catalog.load();
  return catalog;
}
