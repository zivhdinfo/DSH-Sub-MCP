// Finds the parent agent's skills (Claude Code / Codex CLI SKILL.md files) on
// disk so a delegation can attach them to the sub-agent by name. Only the
// frontmatter `name`/`description` and the body are used; the harness's own
// skill registry accepts exactly that shape, and the skill's directory becomes
// the resource base so bundled scripts/references stay reachable.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// Skills that must never reach a sub-agent: the persona forbids nested agents.
export const EXCLUDED = new Set(['deepseek-subagent']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE = 256 * 1024;
const CACHE_MS = 30000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

const homeDir = () => process.env.USERPROFILE ?? process.env.HOME ?? '';
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(homeDir(), '.codex');

export function slugifySkillName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Roots in precedence order (lower rank wins a duplicate name). `flat` roots
// hold `<root>/<name>/SKILL.md`; `plugins` roots are walked for any
// `skills/<name>/SKILL.md` a few levels down, recording the plugin folder.
export function skillRoots({ workspace, extraDirs = [] } = {}) {
  const roots = [];
  let rank = 0;
  const add = (id, dir, walk = 'flat') => roots.push({ id, dir, rank: rank++, walk });
  if (workspace) {
    add('workspace-claude', path.join(workspace, '.claude', 'skills'));
    add('workspace-agents', path.join(workspace, '.agents', 'skills'));
  }
  add('user-claude', path.join(claudeHome(), 'skills'));
  add('user-claude-synced', path.join(claudeHome(), 'skills', 'synced'), 'buckets');
  add('user-codex', path.join(codexHome(), 'skills'));
  add('user-codex-system', path.join(codexHome(), 'skills', '.system'));
  add('user-agents', path.join(homeDir(), '.agents', 'skills'));
  add('claude-plugins', path.join(claudeHome(), 'plugins'), 'plugins');
  add('codex-plugins', path.join(codexHome(), 'plugins'), 'plugins');
  const extra = [...extraDirs, ...String(process.env.DSH_SUB_SKILL_DIRS || '').split(';')].map(s => s.trim()).filter(Boolean);
  extra.forEach((dir, i) => add(`custom-${i + 1}`, path.resolve(dir)));
  return roots;
}

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function listDirs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.system') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    // stat, not the dirent: ~/.claude/skills entries are often symlinks/junctions.
    if (e.isDirectory() || (e.isSymbolicLink() && await isDir(full))) out.push(full);
  }
  return out;
}

function splitFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  let data = {};
  try { data = parseYaml(m[1]) ?? {}; } catch { data = {}; }
  return { data: data && typeof data === 'object' ? data : {}, body: m[2].trim() };
}

async function readSkill(dir, root, plugin) {
  const file = path.join(dir, 'SKILL.md');
  let info;
  try { info = await stat(file); } catch { return null; }
  if (!info.isFile() || info.size > MAX_FILE) return null;
  const { data, body } = splitFrontmatter(await readFile(file, 'utf8'));
  const rawName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : path.basename(dir);
  const name = SKILL_NAME.test(rawName) ? rawName : slugifySkillName(rawName);
  if (!SKILL_NAME.test(name)) return null;
  const description = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : '';
  return { name, rawName, description: description || `Skill "${name}" from ${root.id}`, dir, path: file, root: root.id, plugin, content: body };
}

// Walk a plugin tree for `skills/<name>/SKILL.md`, at most `depth` levels down.
async function walkPlugins(dir, root, depth, out) {
  if (depth < 0) return;
  for (const child of await listDirs(dir)) {
    if (path.basename(child) === 'skills') {
      // Codex caches plugins as <plugin>/<version>/skills; name the plugin, not the version.
      const plugin = /^v?\d+(\.\d+)*([-.][\w.]+)?$/.test(path.basename(dir)) ? path.basename(path.dirname(dir)) : path.basename(dir);
      for (const skillDir of await listDirs(child)) {
        const skill = await readSkill(skillDir, root, plugin);
        if (skill) out.push(skill);
      }
      continue;
    }
    await walkPlugins(child, root, depth - 1, out);
  }
}

async function scanRoot(root) {
  const out = [];
  if (!(await isDir(root.dir))) return { exists: false, skills: out };
  if (root.walk === 'flat') {
    for (const dir of await listDirs(root.dir)) {
      if (path.basename(dir) === 'synced' || path.basename(dir) === '.system') continue; // own roots
      const skill = await readSkill(dir, root, null);
      if (skill) out.push(skill);
    }
  } else if (root.walk === 'buckets') {
    for (const bucket of await listDirs(root.dir)) {
      for (const dir of await listDirs(bucket)) {
        const skill = await readSkill(dir, root, null);
        if (skill) out.push(skill);
      }
    }
  } else {
    await walkPlugins(root.dir, root, 6, out);
  }
  return { exists: true, skills: out };
}

const cache = new Map();

export async function scanSkills({ workspace, extraDirs = [], force = false } = {}) {
  const ws = workspace ? path.resolve(workspace) : null;
  const cacheKey = JSON.stringify([ws?.toLowerCase() ?? null, extraDirs]);
  const hit = cache.get(cacheKey);
  if (hit && !force && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };

  const roots = skillRoots({ workspace: ws, extraDirs });
  const scanned = await Promise.all(roots.map(async root => ({ root, ...(await scanRoot(root)) })));
  const byName = new Map();
  const excluded = new Set();
  for (const { root, skills } of scanned) {
    for (const skill of skills) {
      if (EXCLUDED.has(skill.name)) { excluded.add(skill.name); continue; }
      const existing = byName.get(skill.name);
      if (!existing) byName.set(skill.name, { ...skill, shadowed: [] });
      else if (!existing.shadowed.some(s => s.root === root.id && s.plugin === skill.plugin)) existing.shadowed.push({ root: root.id, plugin: skill.plugin, path: skill.path });
    }
  }
  const value = {
    workspace: ws,
    scannedAt: new Date().toISOString(),
    roots: scanned.map(({ root, exists, skills }) => ({ id: root.id, dir: root.dir, exists, count: skills.length })),
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    excluded: [...excluded],
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return { ...value, cached: false };
}

// What the parent sees from deepseek_skills: no bodies, short descriptions.
export function summarizeSkills(scan) {
  return {
    workspace: scan.workspace,
    scannedAt: scan.scannedAt,
    cached: scan.cached,
    roots: scan.roots,
    skills: scan.skills.map(s => ({
      name: s.name,
      description: s.description.length > 160 ? `${s.description.slice(0, 157)}…` : s.description,
      root: s.root,
      plugin: s.plugin,
      path: s.path,
      ...(s.shadowed.length ? { shadowed: s.shadowed.map(x => x.plugin ? `${x.root}:${x.plugin}` : x.root) } : {}),
    })),
    excluded: scan.excluded,
  };
}

export async function skillRootsSummary({ workspace } = {}) {
  const scan = await scanSkills({ workspace });
  return { total: scan.skills.length, roots: scan.roots.filter(r => r.exists) };
}

// Names as the parent knows them: `docx`, `anthropic-skills:docx`, `PDF`.
export async function resolveSkills(names, { workspace } = {}) {
  if (!Array.isArray(names) || !names.length) return [];
  const scan = await scanSkills({ workspace });
  const out = [];
  const seen = new Set();
  for (const raw of names) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('skills must be a list of non-empty skill names.');
    const colon = raw.lastIndexOf(':');
    const pluginHint = colon > 0 ? raw.slice(0, colon).trim() : null;
    const wanted = (colon > 0 ? raw.slice(colon + 1) : raw).trim();
    const slug = slugifySkillName(wanted);
    if (EXCLUDED.has(slug)) throw new Error(`Skill "${raw}" cannot be attached to a sub-agent (nested delegation is not allowed).`);
    let hit = scan.skills.find(s => s.name === wanted || s.rawName === wanted) ?? scan.skills.find(s => s.name === slug);
    if (hit && pluginHint && hit.plugin !== pluginHint) {
      // The winning entry came from elsewhere; prefer the named plugin's copy if it exists.
      const alt = hit.shadowed.find(s => s.plugin === pluginHint);
      if (alt) hit = { ...hit, path: alt.path, dir: path.dirname(alt.path), root: alt.root, plugin: alt.plugin, content: (await readFile(alt.path, 'utf8').then(t => splitFrontmatter(t).body).catch(() => hit.content)) };
    }
    if (!hit) {
      const looked = scan.roots.filter(r => r.exists).map(r => r.dir).join(', ') || '(no skill directories found)';
      throw new Error(`Unknown skill "${raw}". Looked in: ${looked}. Call deepseek_skills to list the names this server can attach.`);
    }
    if (seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({ name: hit.name, requested: raw, description: hit.description, content: hit.content, dir: hit.dir, path: hit.path, root: hit.root, plugin: hit.plugin });
  }
  return out;
}
