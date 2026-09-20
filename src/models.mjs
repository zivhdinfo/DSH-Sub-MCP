// Model directory: every provider route the harness has registered (DeepSeek,
// plus whatever the user declared under Settings → Models, e.g. a `zai` route
// with GLM models), each with its models, its credential status and the
// per-model delegation switch from the Sub-agent settings page.
//
// This mirrors how the harness's own Models page builds its list: registered
// routes ∩ configurable-provider directory, the route's `apiKeyEnv` read from
// its settings section, then ctx.credentials.describe() for the green dot.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { atomicWrite } from './deepseek-live.mjs';

export const DEEPSEEK = 'deepseek-official';
const CACHE_MS = 30000;
const KEY = /^([^/\s]+)\/(\S+)$/;

export const keyOf = (provider, model) => `${provider}/${model}`;

// 'zai/glm-5.3' → { provider: 'zai', model: 'glm-5.3' }; a bare id → null.
export function splitKey(key) {
  const m = typeof key === 'string' ? KEY.exec(key) : null;
  return m ? { provider: m[1], model: m[2] } : null;
}

// Vendors quote windows in both bases (131072 vs 1000000); pick the one that lands on a round number.
export const contextK = n => Math.round(n / (n % 1024 === 0 ? 1024 : 1000));

// Reasoning effort the parent gets when it names none: "high" whenever the
// model offers it, else the model's own default, else its strongest level.
export const DEFAULT_EFFORT = 'high';
const EFFORT_RANK = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off'];
const fmtContext = n => (n ? ` (${contextK(n)}k context)` : '');

function describeCandidates(models) {
  return models.map(m => `  - ${m.key} — ${m.name}${fmtContext(m.contextWindow)}`).join('\n');
}

// Thrown by requireChoice() when the parent must ask the user first.
export class AskFirstError extends Error {
  constructor(candidates) {
    super(
      `MODEL REQUIRED — ${candidates.length} models are enabled on the DeepSeek Harness and this call did not set \`model\`.\n`
      + 'Ask the USER which model to use (Claude Code: AskUserQuestion; Codex: ask in chat), then call again with `model` set to exactly one of:\n'
      + describeCandidates(candidates) + '\n'
      + 'Do not pick one yourself. deepseek_models returns the same list with details.',
    );
    this.name = 'AskFirstError';
    this.candidates = candidates;
  }
}

// The Models page derives a key name for routes that name none.
const derivedKeyRef = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

function walk(value, segments) {
  let cur = value;
  for (const s of segments) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

export class ModelDirectory {
  constructor(ctx, home, { live } = {}) {
    this.ctx = ctx;
    this.live = live;
    this.file = path.join(home, 'model-catalog.json');
    this.enabled = {};
    this.cache = null;
    this.cachedAt = 0;
    this.pending = null;
  }

  // v2: { version: 2, enabled: { "provider/model": bool } }. A v1 file (per-
  // model rows of the old DeepSeek-only catalog) is migrated in place.
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && raw.version === 2 && raw.enabled && typeof raw.enabled === 'object') {
        for (const [key, on] of Object.entries(raw.enabled)) if (splitKey(key)) this.enabled[key] = on === true;
      } else if (Array.isArray(raw?.models)) {
        for (const m of raw.models) if (typeof m?.model === 'string') this.enabled[keyOf(DEEPSEEK, m.model)] = m.enabled !== false;
        await this.persist();
      }
    } catch { /* first run: everything off until the user switches a model on */ }
  }

  async persist() {
    await atomicWrite(this.file, JSON.stringify({ version: 2, enabled: this.enabled }, null, 2));
  }

  invalidate() { this.cache = null; }

  async snapshot() {
    if (this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    if (!this.pending) {
      this.pending = this.#build().then(snap => {
        this.cache = snap;
        this.cachedAt = Date.now();
        return snap;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async #build() {
    const { ctx } = this;
    const active = ctx.llm.listProviders();
    active.sort((a, b) => (a.id === DEEPSEEK ? -1 : b.id === DEEPSEEK ? 1 : 0));
    const directory = new Map(ctx.llm.listConfigurableProviders().map(e => [e.provider, e]));
    const providers = [];
    for (const route of active) {
      const entry = directory.get(route.id);
      let apiKeyEnv;
      if (entry) {
        const section = ctx.settings?.get?.(entry.settingsNs);
        const profile = walk(section, entry.settingsPath);
        const named = profile && typeof profile === 'object' ? profile.apiKeyEnv : undefined;
        apiKeyEnv = typeof named === 'string' && named.trim()
          ? named.trim()
          : entry.settingsNs === 'llm-deepseek' ? 'DEEPSEEK_API_KEY' : derivedKeyRef(route.id);
      }
      let credential = null;
      if (apiKeyEnv) {
        try {
          const info = await ctx.credentials.describe(credentialRef(apiKeyEnv));
          credential = { configured: info?.configured === true, ...(info?.source ? { source: info.source } : {}) };
        } catch { credential = { configured: false }; }
      }
      const usable = !apiKeyEnv || credential?.configured === true;
      let error = entry?.error ?? null;
      let models = [];
      try {
        const listed = await ctx.llm.listModels(route.id);
        models = await Promise.all(listed.map(async m => {
          let contextWindow = null;
          let reasoning = null;
          try {
            const info = await ctx.llm.resolveModelInfo(route.id, m.id);
            contextWindow = info?.context?.contextWindow ?? null;
            const efforts = (info?.reasoning?.efforts ?? []).map(e => String(e.id));
            if (efforts.length) reasoning = { efforts, defaultEffort: info.reasoning.defaultEffort ? String(info.reasoning.defaultEffort) : null };
          } catch { /* metadata only */ }
          const key = keyOf(route.id, m.id);
          return {
            key,
            id: m.id,
            name: m.name || m.id,
            contextWindow,
            reasoning,
            enabled: this.enabled[key] === true,
            listed: route.id === DEEPSEEK && this.live ? this.live.isListed(m.id) : null,
          };
        }));
      } catch (e) {
        error = error ?? String(e?.message || e);
      }
      providers.push({
        id: route.id,
        name: entry?.displayName || route.name || route.id,
        apiKeyEnv: apiKeyEnv ?? null,
        credential,
        usable,
        error,
        models,
      });
    }
    const enabled = providers.filter(p => p.usable).flatMap(p => p.models.filter(m => m.enabled).map(m => m.key));
    return {
      askFirst: enabled.length >= 2,
      enabled,
      providers,
      deepseekLive: this.live ? (({ models, ...rest }) => rest)(this.live.snapshot()) : null,
      checkedAt: new Date().toISOString(),
    };
  }

  // Flat list of models the parent may run on: enabled AND provider usable.
  async usableModels() {
    const snap = await this.snapshot();
    return snap.providers.filter(p => p.usable).flatMap(p => p.models.filter(m => m.enabled).map(m => ({ ...m, provider: p.id })));
  }

  async requireChoice() {
    const usable = await this.usableModels();
    if (!usable.length) throw new Error('No model is enabled for delegation. Open the DSH UI → Settings → Sub-agent and switch one on.');
    if (usable.length === 1) return this.#pick(usable[0]);
    throw new AskFirstError(usable);
  }

  // `implicit` is a continuation reusing the model its session started on: the
  // delegation switch is ignored (with a warning) but the provider must still be
  // active and have a key.
  async resolve(requested, { implicit = false } = {}) {
    if (typeof requested !== 'string' || !requested.trim()) throw new Error('model must be a non-empty string; call deepseek_models for the list.');
    const snap = await this.snapshot();
    const activeIds = snap.providers.map(p => p.id).join(', ') || '(none)';
    const enabledList = snap.enabled.join(', ') || '(none)';
    const split = splitKey(requested.trim());
    let provider;
    let hit;
    if (split) {
      provider = snap.providers.find(p => p.id === split.provider);
      if (!provider) throw new Error(`Provider "${split.provider}" is not active on the DeepSeek Harness (Settings → Models). Active providers: ${activeIds}.`);
      hit = provider.models.find(m => m.id === split.model);
      if (!hit) throw new Error(`Model "${requested}" is not served by provider "${provider.id}". Enabled models: ${enabledList}. Call deepseek_models for the full list.`);
    } else {
      const candidates = snap.providers.flatMap(p => p.models.filter(m => m.id === requested.trim()).map(m => ({ p, m })));
      if (!candidates.length) throw new Error(`Model "${requested}" is not known to any active provider. Enabled models: ${enabledList}. Use "provider/model" as listed by deepseek_models.`);
      if (candidates.length > 1) throw new Error(`Model id "${requested}" is ambiguous: use one of ${candidates.map(c => c.m.key).join(', ')}.`);
      ({ p: provider, m: hit } = candidates[0]);
    }
    if (!provider.usable) throw new Error(`Provider "${provider.id}" has no API key configured (DSH UI → Settings → Models). Enabled models: ${enabledList}.`);
    if (!hit.enabled && !implicit) throw new Error(`Model "${hit.key}" is switched off in the DSH UI (Settings → Sub-agent). Enabled: ${enabledList}.`);
    const warnings = [];
    if (!hit.enabled && implicit) warnings.push(`model ${hit.key} is switched off for new delegations; continuing on it because the session started with it`);
    if (hit.listed === false) warnings.push(`model ${hit.id} is no longer listed by the DeepSeek API (likely retired, temporarily aliased)`);
    return this.#pick({ ...hit, provider: provider.id }, warnings.join('; ') || null);
  }

  #pick(m, warning = null) {
    return { provider: m.provider, model: m.id, key: m.key, name: m.name, contextWindow: m.contextWindow ?? null, reasoning: m.reasoning ?? null, warning };
  }

  // Validates a requested reasoning effort against what the picked model
  // offers, or chooses the default. Returns { effort, warning }; effort is
  // null for a model without selectable levels.
  static resolveEffort(picked, requested) {
    const efforts = picked.reasoning?.efforts ?? [];
    const has = id => efforts.includes(id);
    if (requested !== undefined && requested !== null && requested !== '') {
      if (typeof requested !== 'string') throw new Error('reasoningEffort must be a string.');
      const want = requested.trim().toLowerCase();
      if (!efforts.length) return { effort: null, warning: `model ${picked.key} has no selectable reasoning effort; "${want}" ignored` };
      if (!has(want)) throw new Error(`Reasoning effort "${want}" is not offered by ${picked.key}. Available: ${efforts.join(', ')}.`);
      return { effort: want, warning: null };
    }
    if (!efforts.length) return { effort: null, warning: null };
    if (has(DEFAULT_EFFORT)) return { effort: DEFAULT_EFFORT, warning: null };
    if (picked.reasoning.defaultEffort && has(picked.reasoning.defaultEffort)) return { effort: picked.reasoning.defaultEffort, warning: null };
    return { effort: EFFORT_RANK.find(has) ?? efforts[0], warning: null };
  }

  async setEnabled(key, enabled) {
    const split = splitKey(key);
    if (!split) throw new Error('key must be "provider/model".');
    const snap = await this.snapshot();
    const provider = snap.providers.find(p => p.id === split.provider);
    const hit = provider?.models.find(m => m.id === split.model);
    if (!hit) throw new Error(`No such model "${key}".`);
    if (enabled && !provider.usable) throw new Error(`Provider "${provider.id}" has no API key configured; add one under Settings → Models first.`);
    this.enabled[key] = enabled === true;
    await this.persist();
    this.invalidate();
    return this.snapshot();
  }
}
