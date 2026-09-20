// Browser half of the plugin: a "DeepSeek Sub-agent" section inside the DSH
// harness's own Settings dialog, next to Models and Plugins. It is served by
// the harness's client-module system (declared as `dsh.client` in
// package.json) and talks to the host half through the /dsh-sub JSON routes in
// mcp-plugin.mjs, authenticated by the browser session the UI already holds.
//
// Written directly in the lazy-CJS factory form the harness loads, so there is
// no build step: React and the DSH UI primitives come from the shell's shared
// module table, and the CSS below only uses the harness's own design tokens.
window.__ModuleLoader__.load({
  id: 'dsh-sub-mcp',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const PLUGIN = 'dsh-sub-mcp';
    const SECTION_ID = 'deepseek-subagent';
    const NS = 'settings.deepseekSub';
    const API = '/dsh-sub';
    // The launcher page (/setup?key=…) lands on the UI with this fragment so the
    // section opens by itself on first run.
    const SETTINGS_HASH = '#settings/deepseek-subagent';
    const POLL_MS = 5000;

    // -------------------------------------------------------------------------
    // Styles — the same tokens the Models section uses, so the page reads as
    // part of the harness rather than a page bolted onto it.
    // -------------------------------------------------------------------------
    const css = `
.dsub-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.dsub-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsub-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.dsub-cards{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.dsub-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.dsub-cardHead{display:flex;align-items:center;gap:10px;min-height:28px}
.dsub-cardTitle{font-size:14px;font-weight:500;line-height:22px}
.dsub-cardSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsub-cardActions{margin-left:auto;display:inline-flex;align-items:center;gap:6px}
.dsub-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.dsub-code{font-family:var(--ds-font-family-code);font-size:12px}
.dsub-rows{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.dsub-row{display:flex;align-items:center;gap:10px;min-height:36px;padding:5px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsub-row:first-child{border-top:none}
.dsub-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsub-rowName{font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px;min-width:0}
.dsub-rowName>*{flex:none;white-space:nowrap}
.dsub-rowName>.dsub-code,.dsub-rowName>.dsub-shrink{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsub-rowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsub-rowMeta b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsub-rowEnd{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}
.dsub-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;align-items:center;font-size:13px;line-height:20px}
.dsub-kv dt{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsub-kv dd{margin:0;min-width:0;display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.dsub-inlineDot{display:inline-flex;align-items:center;gap:6px}
.dsub-log{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow-y:auto}
.dsub-log[data-ok=false]{color:var(--dsw-alias-state-error-primary)}
.dsub-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsub-empty{padding:14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsub-run{cursor:pointer;border-radius:8px;margin:0 -6px;padding:5px 6px}
.dsub-run:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsub-run[data-open=true]{background:var(--dsw-alias-bg-module-platform)}
.dsub-run[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}
.dsub-run:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsub-check{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dsub-check:disabled{opacity:.35;cursor:default}
.dsub-danger:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dsub-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsub-dialog{width:min(480px,100%)}
.dsub-runDetail{margin:-4px -6px 4px;padding:8px 12px 10px;border-radius:0 0 8px 8px;background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsub-runDetail p{margin:0;overflow-wrap:anywhere}
.dsub-runDetail .dsub-code{color:var(--dsw-alias-label-tertiary)}
.dsub-num{font-variant-numeric:tabular-nums}
.dsub-iconBtn{box-sizing:border-box;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dsub-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsub-iconBtn:disabled{opacity:.4;cursor:default}
.dsub-howto{display:flex;flex-direction:column;gap:6px;margin:0;font-size:12.5px;line-height:18px}
.dsub-howto>div{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 16px}
.dsub-howto dt{flex:1 1 220px;color:var(--dsw-alias-label-secondary);font-style:italic}
.dsub-howto dd{flex:0 1 auto;margin:0 0 0 auto;font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:right}
`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${PLUGIN}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN;
      tag.dataset.pluginCss = PLUGIN;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // -------------------------------------------------------------------------
    // Copy. English is the key-set source of truth; zh mirrors it.
    // -------------------------------------------------------------------------
    const en = {
      nav: 'Sub-agent',
      title: 'DeepSeek Sub-agent',
      intro: 'Let Claude Code or Codex CLI delegate work to a DeepSeek agent running in this harness. Every delegation shows up as a session in the sidebar.',
      loading: 'Reading…',
      loadError: 'The plugin API is unreachable: {error}',
      retry: 'Retry',
      // status card
      statusTitle: 'Status',
      apiKey: 'DeepSeek API key',
      keyConfigured: 'Configured',
      keyMissing: 'Missing — add it under Settings → Models, then come back.',
      endpoint: 'MCP endpoint',
      copy: 'Copy',
      copied: 'Copied',
      activity: 'Activity',
      activityText: '{running} running · {total} recorded',
      // agents card
      agentsTitle: 'Parent agents',
      agentsSub: 'Registers the server over stdio (the parent starts it on demand) and installs usage guidance so the parent knows when to delegate. Safe to click again.',
      claude: 'Claude Code',
      codex: 'Codex CLI',
      cliFound: 'CLI: {path}',
      cliMissing: 'CLI not found in the usual places — PATH will be tried.',
      guidanceInstalled: 'guidance installed',
      guidanceMissing: 'guidance not installed',
      connect: 'Connect',
      connecting: 'Connecting…',
      verify: 'Verify',
      verifying: 'Checking…',
      // models card
      modelsTitle: 'Allowed models',
      modelsSub: 'A model switched off here is refused when the parent asks for it.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      serving: 'serving',
      retired: 'left the API',
      default: 'default',
      modelToggle: 'Allow {model}',
      catalogSynced: 'Default: {model} · synced {when}',
      catalogUnverified: 'Default: {model} · not yet verified against the API',
      // runs card
      runsTitle: 'Recent delegations',
      runsSub: '{shown} most recent of {total}. Click a row for the task and session id.',
      runsEmpty: 'No delegations yet. They appear here as Claude Code or Codex calls the deepseek tools.',
      runsHint: 'Sessions live under .dsh-sub/sessions and can be opened from the sidebar once the workspace is added; any finished session can be resumed with deepseek_continue.',
      stop: 'Stop',
      stopping: 'Stopping…',
      turn: 'turn {n}',
      background: 'background',
      running: 'running',
      completed: 'completed',
      calls: '{n} calls',
      tokens: '{in} in / {out} out',
      cache: '{pct}% cache',
      files: '{n} files',
      pending: 'accounting settling',
      task: 'Task',
      workspace: 'Workspace',
      session: 'Session',
      reason: 'Why it stopped',
      // how-to card
      howtoTitle: 'How to use',
      howtoSub: 'Ask the parent naturally; the installed guidance maps phrases to tools.',
      howto1: '"use deepseek to review the auth module for bugs"',
      howto2: '"use deepseek to fix that bug"',
      howto3: '"ask deepseek to carry on where it stopped"',
      howto4: '"what is deepseek doing?"',
      howtoFoot: 'Long jobs: pass background: true and read the report later with deepseek_result. The server starts on demand; to stop it fully, end the node process holding port {port}.',
      // selection, deletion, navigation
      open: 'Open this chat',
      details: 'Details',
      selectRow: 'Select this delegation',
      selectAll: 'Select all',
      selectNone: 'Clear selection',
      deleteN: 'Delete {n}',
      deleteTitle: 'Delete {n} delegation(s)?',
      deleteDesc: 'Removes them from this list and deletes their stored reports. Their transcripts are archived in the harness (hidden from the sidebar), not erased.',
      deleting: 'Deleting…',
      confirmDelete: 'Delete',
      cancel: 'Cancel',
      close: 'Close',
      // restart
      restart: 'Restart server',
      restartTitle: 'Restart the server?',
      restartDesc: 'Restarts the harness on port {port}. The MCP endpoint and this UI drop out for a few seconds, and any chat in progress is interrupted. The page reloads once it is back.',
      confirmRestart: 'Restart',
      restarting: 'Restarting… the page reloads when the server is back.',
      restartFailed: 'The server did not come back within 60 seconds. Start it again with Start.vbs or npm start.',
    };
    const zh = {
      nav: '子代理',
      title: 'DeepSeek 子代理',
      intro: '让 Claude Code 或 Codex CLI 把任务委托给运行在本 Harness 中的 DeepSeek 代理。每次委托都会作为一个会话出现在侧边栏。',
      loading: '读取中…',
      loadError: '无法连接插件 API：{error}',
      retry: '重试',
      statusTitle: '状态',
      apiKey: 'DeepSeek API 密钥',
      keyConfigured: '已配置',
      keyMissing: '未配置 — 请先在“设置 → 模型”中添加，然后回到这里。',
      endpoint: 'MCP 端点',
      copy: '复制',
      copied: '已复制',
      activity: '活动',
      activityText: '{running} 个运行中 · 共记录 {total} 次',
      agentsTitle: '父代理',
      agentsSub: '通过 stdio 注册服务器（父代理按需启动它），并安装使用指引，让父代理知道何时委托。可重复点击。',
      claude: 'Claude Code',
      codex: 'Codex CLI',
      cliFound: 'CLI：{path}',
      cliMissing: '常见位置未找到 CLI — 将尝试 PATH。',
      guidanceInstalled: '指引已安装',
      guidanceMissing: '指引未安装',
      connect: '连接',
      connecting: '连接中…',
      verify: '检查',
      verifying: '检查中…',
      modelsTitle: '允许的模型',
      modelsSub: '在此关闭的模型，父代理请求时会被拒绝。',
      refresh: '刷新',
      refreshing: '刷新中…',
      serving: '可用',
      retired: '已从 API 下线',
      default: '默认',
      modelToggle: '允许 {model}',
      catalogSynced: '默认：{model} · 同步于 {when}',
      catalogUnverified: '默认：{model} · 尚未与 API 核对',
      runsTitle: '最近的委托',
      runsSub: '显示最近 {shown} 条，共 {total} 条。点击查看任务与会话 ID。',
      runsEmpty: '还没有委托。当 Claude Code 或 Codex 调用 deepseek 工具时会显示在这里。',
      runsHint: '会话保存在 .dsh-sub/sessions 下；把工作区加入侧边栏后即可打开。任何已结束的会话都可用 deepseek_continue 继续。',
      stop: '停止',
      stopping: '停止中…',
      turn: '第 {n} 轮',
      background: '后台',
      running: '运行中',
      completed: '已完成',
      calls: '{n} 次调用',
      tokens: '输入 {in} / 输出 {out}',
      cache: '缓存命中 {pct}%',
      files: '{n} 个文件',
      pending: '统计结算中',
      task: '任务',
      workspace: '工作区',
      session: '会话',
      reason: '停止原因',
      howtoTitle: '使用方法',
      howtoSub: '用自然语言告诉父代理即可；已安装的指引会把说法映射到工具。',
      howto1: '“用 deepseek 检查 auth 模块有没有 bug”',
      howto2: '“用 deepseek 修这个 bug”',
      howto3: '“让 deepseek 从停下的地方继续”',
      howto4: '“deepseek 在做什么？”',
      howtoFoot: '长任务：传 background: true，稍后用 deepseek_result 读取报告。服务器按需启动；要彻底停止，结束占用端口 {port} 的 node 进程。',
      open: '打开此对话',
      details: '详情',
      selectRow: '选择此委托',
      selectAll: '全选',
      selectNone: '取消选择',
      deleteN: '删除 {n} 项',
      deleteTitle: '删除 {n} 项委托？',
      deleteDesc: '将其从此列表移除并删除已保存的报告。对话记录会在 Harness 中归档（从侧边栏隐藏），不会被抹除。',
      deleting: '删除中…',
      confirmDelete: '删除',
      cancel: '取消',
      close: '关闭',
      restart: '重启服务器',
      restartTitle: '重启服务器？',
      restartDesc: '重启端口 {port} 上的 Harness。MCP 端点和此界面会中断几秒钟，正在进行的对话会被打断。服务器恢复后页面会自动刷新。',
      confirmRestart: '重启',
      restarting: '重启中… 服务器恢复后页面会自动刷新。',
      restartFailed: '服务器在 60 秒内未恢复。请用 Start.vbs 或 npm start 重新启动。',
    };

    // -------------------------------------------------------------------------
    // Wire helpers
    // -------------------------------------------------------------------------
    async function api(route, body) {
      const init = body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const response = await fetch(API + route, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data && typeof data.error === 'string') throw new Error(data.error);
      return data;
    }

    const fmt = n => Number(n ?? 0).toLocaleString();
    const clock = iso => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false });
    };
    // 12.3s · 14m 03s · 1h 02m — the run list mixes two-second lookups with
    // quarter-hour refactors, so one unit does not read well for both.
    function duration(ms) {
      if (ms === null || ms === undefined) return '—';
      const s = ms / 1000;
      if (s < 60) return `${s.toFixed(1)}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
      return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
    }
    const RELATIVE_UNIT = { now: 'second', minutes: 'minute', hours: 'hour', days: 'day', months: 'month', years: 'year' };
    function ago(iso, now) {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return '';
      const rel = P.relativeTime(t, now);
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      return rel.unit === 'now' ? rtf.format(0, 'second') : rtf.format(-rel.n, RELATIVE_UNIT[rel.unit]);
    }
    const dotFor = status => (
      status === 'completed' ? 'done'
        : status === 'running' ? 'ongoing'
          : status === 'cancelled' || status === 'interrupted' ? 'warning'
            : 'error'
    );

    // -------------------------------------------------------------------------
    // Small building blocks
    // -------------------------------------------------------------------------
    function Card({ title, sub, actions, children }) {
      return h('section', { className: 'dsub-card' },
        h('div', { className: 'dsub-cardHead' },
          h('div', null,
            h('div', { className: 'dsub-cardTitle' }, title),
            sub ? h('div', { className: 'dsub-cardSub' }, sub) : null),
          actions ? h('div', { className: 'dsub-cardActions' }, actions) : null),
        children);
    }

    function CopyButton({ text, t }) {
      const [done, setDone] = useState(false);
      const timer = useRef(null);
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
      return h(P.Tooltip, { label: done ? t('copied') : t('copy'), side: 'top' },
        h('button', {
          type: 'button',
          className: 'dsub-iconBtn',
          'aria-label': t('copy'),
          onClick: async () => {
            if (await P.writeClipboard(text)) {
              setDone(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setDone(false), 1500);
            }
          },
        }, h(done ? P.IconCheckOutline14 : P.IconCopyOutline16, { size: 14 })));
    }

    // -------------------------------------------------------------------------
    // Cards
    // -------------------------------------------------------------------------
    // Restart: ask, tell the host, then wait for it to answer again and reload
    // so the page picks up whatever the restart was for (a code change, say).
    function useRestart(t, port) {
      const [phase, setPhase] = useState('idle'); // idle | confirm | waiting | failed
      const [error, setError] = useState(null);
      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);
      const start = async () => {
        setPhase('waiting');
        setError(null);
        try {
          await api('/restart', {});
        } catch (e) {
          if (!alive.current) return;
          setError(String(e.message || e));
          setPhase('idle');
          return;
        }
        // Down first, then up again; a reply during the first second would be
        // the old process still draining.
        await new Promise(r => setTimeout(r, 1500));
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          try {
            const r = await fetch(API + '/state', { credentials: 'same-origin', cache: 'no-store' });
            if (r.ok) {
              location.hash = SETTINGS_HASH;
              location.reload();
              return;
            }
          } catch { /* still down */ }
          await new Promise(r => setTimeout(r, 1000));
        }
        if (alive.current) setPhase('failed');
      };
      const dialog = h(P.Modal, {
        open: phase === 'confirm',
        onClose: () => setPhase('idle'),
        title: t('restartTitle'),
        closeLabel: t('close'),
        description: t('restartDesc', { port: String(port) }),
        className: 'dsub-dialog',
        footer: h(React.Fragment, null,
          h(P.Button, { variant: 'outline', onClick: () => setPhase('idle') }, t('cancel')),
          h(P.Button, { variant: 'primary', onClick: start }, t('confirmRestart'))),
      });
      return { phase, error, dialog, ask: () => setPhase('confirm') };
    }

    function StatusCard({ state, t }) {
      const restart = useRestart(t, state.port);
      const note = restart.phase === 'waiting' ? t('restarting') : restart.phase === 'failed' ? t('restartFailed') : null;
      return h(Card, {
        title: t('statusTitle'),
        actions: h(P.Button, {
          variant: 'outline', size: 'sm', disabled: restart.phase === 'waiting', onClick: restart.ask,
          icon: h(P.IconRefreshOutline14, { size: 14 }),
        }, t('restart')),
      },
      h('dl', { className: 'dsub-kv' },
        h('dt', null, t('apiKey')),
        h('dd', null,
          h('span', { className: 'dsub-inlineDot' },
            h(P.StateDot, { state: state.key.configured ? 'done' : 'error', size: 8 }),
            state.key.configured ? t('keyConfigured') : t('keyMissing'))),
        h('dt', null, t('endpoint')),
        h('dd', null, h('span', { className: 'dsub-code' }, state.mcpUrl), h(CopyButton, { text: state.mcpUrl, t })),
        h('dt', null, t('activity')),
        h('dd', null, t('activityText', { running: String(state.running), total: String(state.totalRuns) }))),
      note ? h('p', { className: restart.phase === 'failed' ? 'dsub-error' : 'dsub-muted', role: 'status' }, note) : null,
      restart.error ? h('p', { className: 'dsub-error', role: 'alert' }, restart.error) : null,
      restart.dialog);
    }

    function AgentRow({ target, info, t, busy, onConnect, onVerify }) {
      const working = busy !== null;
      return h('li', { className: 'dsub-row' },
        h('div', { className: 'dsub-rowMain' },
          h('div', { className: 'dsub-rowName' },
            h('span', { className: 'dsub-shrink' }, t(target)),
            h(P.Tag, { tone: info.guidanceInstalled ? 'success' : 'warning' }, info.guidanceInstalled ? t('guidanceInstalled') : t('guidanceMissing'))),
          h('div', { className: 'dsub-rowMeta', title: info.cli ?? '' },
            info.cli ? t('cliFound', { path: info.cli }) : t('cliMissing'))),
        h('div', { className: 'dsub-rowEnd' },
          h(P.Button, { variant: 'outline', size: 'sm', disabled: working, onClick: onVerify },
            busy === 'verify' ? t('verifying') : t('verify')),
          h(P.Button, { variant: 'primary', size: 'sm', disabled: working, onClick: onConnect },
            busy === 'connect' ? t('connecting') : t('connect'))));
    }

    function AgentsCard({ state, t, reload }) {
      const [busy, setBusy] = useState(null); // { target, action }
      const [log, setLog] = useState(null); // { ok, text }
      const run = async (target, action) => {
        setBusy({ target, action });
        try {
          const result = await api(action === 'connect' ? '/register' : '/verify', { target });
          const label = `${t(target)} · ${result.exe}`;
          setLog({ ok: result.ok, text: `${result.ok ? '✓' : '✗'} ${label}\n${result.output || ''}`.trim() });
          reload();
        } catch (error) {
          setLog({ ok: false, text: `✗ ${String(error.message || error)}` });
        } finally {
          setBusy(null);
        }
      };
      return h(Card, { title: t('agentsTitle'), sub: t('agentsSub') },
        h('ul', { className: 'dsub-rows' },
          ['claude', 'codex'].map(target => h(AgentRow, {
            key: target,
            target,
            info: state.agents[target],
            t,
            busy: busy?.target === target ? busy.action : null,
            onConnect: () => run(target, 'connect'),
            onVerify: () => run(target, 'verify'),
          }))),
        log ? h('pre', { className: 'dsub-log', 'data-ok': log.ok }, log.text) : null);
    }

    function ModelsCard({ state, t, setCatalog }) {
      const [error, setError] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [saving, setSaving] = useState(null);
      const catalog = state.catalog;
      const toggle = async (model, enabled) => {
        setSaving(model);
        setError(null);
        try {
          const result = await api('/model', { model, enabled });
          setCatalog(result.catalog);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setSaving(null);
        }
      };
      const refresh = async () => {
        setRefreshing(true);
        setError(null);
        try {
          const result = await api('/models/refresh', {});
          setCatalog(result.catalog);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setRefreshing(false);
        }
      };
      const meta = catalog.catalogStale || !catalog.catalogCheckedAt
        ? t('catalogUnverified', { model: catalog.defaultModel })
        : t('catalogSynced', { model: catalog.defaultModel, when: ago(catalog.catalogCheckedAt, Date.parse(state.now)) });
      return h(Card, {
        title: t('modelsTitle'),
        sub: t('modelsSub'),
        actions: h(P.Button, {
          variant: 'outline', size: 'sm', disabled: refreshing || !state.key.configured, onClick: refresh,
          icon: h(P.IconRefreshOutline14, { size: 14 }),
        }, refreshing ? t('refreshing') : t('refresh')),
      },
      h('ul', { className: 'dsub-rows' },
        catalog.models.map(m => h('li', { className: 'dsub-row', key: m.model },
          h(P.Switch, {
            checked: m.enabled !== false,
            disabled: !m.listed || saving === m.model,
            label: t('modelToggle', { model: m.model }),
            onChange: next => toggle(m.model, next),
          }),
          h('div', { className: 'dsub-rowMain' },
            h('div', { className: 'dsub-rowName' },
              h('span', { className: 'dsub-code' }, m.model),
              m.model === catalog.defaultModel ? h(P.Tag, { tone: 'info' }, t('default')) : null),
            m.label && m.label !== m.model ? h('div', { className: 'dsub-rowMeta' }, m.label) : null),
          h('div', { className: 'dsub-rowEnd' },
            h(P.Tag, { tone: m.listed ? 'success' : 'warning' }, m.listed ? t('serving') : t('retired')))))),
      h('p', { className: 'dsub-muted' }, meta, catalog.message ? ` · ${catalog.message}` : ''),
      error ? h('p', { className: 'dsub-error', role: 'alert' }, error) : null);
    }

    // One delegation. Clicking the row opens the session in the harness (the
    // dialog closes so the conversation is visible); the chevron shows the
    // task, workspace and id in place; the checkbox is for bulk deletion.
    function RunRow({ run, now, t, onStop, onOpen, selected, onSelect }) {
      const [open, setOpen] = useState(false);
      const [stopping, setStopping] = useState(false);
      const running = run.status === 'running';
      const stats = [];
      if (running) {
        if (run.toolCalls !== null) stats.push(t('calls', { n: fmt(run.toolCalls) }));
        if (run.lastTool) stats.push(run.lastTool);
      } else {
        if (run.reason) stats.push(run.reason);
        if (run.usage) {
          if (run.usage.pending) stats.push(t('pending'));
          else {
            stats.push(t('tokens', { in: fmt(run.usage.inputTokens), out: fmt(run.usage.outputTokens) }));
            stats.push(t('cache', { pct: (run.usage.cacheHitRatio * 100).toFixed(0) }));
          }
        }
        if (run.changedFiles !== null) stats.push(t('files', { n: fmt(run.changedFiles) }));
      }
      const stop = async event => {
        event.stopPropagation();
        setStopping(true);
        try { await onStop(run.sessionId); } finally { setStopping(false); }
      };
      const openable = Boolean(run.sessionId);
      const activate = () => { if (openable) onOpen(run.sessionId); };
      const statusLabel = running ? t('running') : run.status === 'completed' ? t('completed') : run.status;
      return h('li', null,
        h('div', {
          className: 'dsub-row dsub-run',
          'data-open': open,
          'data-selected': selected,
          role: openable ? 'button' : undefined,
          tabIndex: openable ? 0 : undefined,
          title: openable ? t('open') : undefined,
          onClick: activate,
          onKeyDown: e => { if (openable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } },
        },
        h('input', {
          type: 'checkbox',
          className: 'dsub-check',
          checked: selected,
          disabled: running || !openable,
          'aria-label': t('selectRow'),
          onClick: e => e.stopPropagation(),
          onChange: e => onSelect(run.sessionId, e.target.checked),
        }),
        h(P.StateDot, { state: dotFor(run.status), size: 8 }),
        h('div', { className: 'dsub-rowMain' },
          h('div', { className: 'dsub-rowName' },
            h(P.Tag, { tone: run.role === 'code' ? 'solid' : 'neutral' }, run.role),
            h('span', { className: 'dsub-code' }, run.model),
            run.turn > 1 ? h(P.Tag, { tone: 'quiet' }, t('turn', { n: String(run.turn) })) : null,
            run.background ? h(P.Tag, { tone: 'quiet' }, t('background')) : null,
            h('span', { className: 'dsub-muted' }, statusLabel)),
          h('div', { className: 'dsub-rowMeta', title: stats.join(' · ') }, stats.join(' · ') || '—')),
        h('div', { className: 'dsub-rowEnd' },
          h('span', { className: 'dsub-muted dsub-num', title: run.time }, `${ago(run.time, now)} · ${duration(run.durationMs)}`),
          running ? h(P.Button, { variant: 'outline', size: 'sm', disabled: stopping || run.stopping !== null, onClick: stop },
            stopping || run.stopping ? t('stopping') : t('stop')) : null,
          h('button', {
            type: 'button',
            className: 'dsub-iconBtn',
            'aria-label': t('details'),
            'aria-expanded': open,
            onClick: e => { e.stopPropagation(); setOpen(!open); },
          }, h(open ? P.IconChevronUpOutline14 : P.IconChevronDownOutline14, { size: 14 })))),
        open ? h('div', { className: 'dsub-runDetail' },
          h('p', null, h('b', null, `${t('task')}: `), run.task),
          h('p', null, h('b', null, `${t('workspace')}: `), h('span', { className: 'dsub-code' }, run.workspace)),
          run.reason && !running ? h('p', null, h('b', null, `${t('reason')}: `), run.reason) : null,
          h('p', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('b', null, `${t('session')}: `),
            h('span', { className: 'dsub-code' }, run.sessionId ?? '—'),
            run.sessionId ? h(CopyButton, { text: run.sessionId, t }) : null)) : null);
    }

    function RunsCard({ state, t, reload, openSession }) {
      const now = Date.parse(state.now);
      const [selected, setSelected] = useState(() => new Set());
      const [confirming, setConfirming] = useState(false);
      const [deleting, setDeleting] = useState(false);
      const [error, setError] = useState(null);
      // A poll can drop rows (a finished delete, a pruned history): keep the
      // selection to ids that are still on screen and not running.
      const selectable = state.runs.filter(r => r.sessionId && r.status !== 'running').map(r => r.sessionId);
      const live = new Set(selectable);
      const picked = [...selected].filter(id => live.has(id));
      const onSelect = (id, on) => setSelected(prev => {
        const next = new Set(prev);
        if (on) next.add(id); else next.delete(id);
        return next;
      });
      const onStop = async sessionId => {
        await api('/cancel', { sessionId }).catch(() => {});
        reload();
      };
      const remove = async () => {
        setDeleting(true);
        setError(null);
        try {
          await api('/delete', { sessionIds: picked });
          setSelected(new Set());
          setConfirming(false);
          reload();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setDeleting(false);
        }
      };
      const allPicked = selectable.length > 0 && picked.length === selectable.length;
      return h(Card, {
        title: t('runsTitle'),
        sub: state.runs.length ? t('runsSub', { shown: String(state.runs.length), total: String(state.totalRuns) }) : undefined,
        actions: state.runs.length ? h(React.Fragment, null,
          h(P.Button, {
            variant: 'ghost', size: 'sm', disabled: !selectable.length,
            onClick: () => setSelected(allPicked ? new Set() : new Set(selectable)),
          }, allPicked ? t('selectNone') : t('selectAll')),
          h(P.Button, {
            variant: 'outline', size: 'sm', className: 'dsub-danger', disabled: !picked.length,
            icon: h(P.IconTrashOutline16, { size: 14 }),
            onClick: () => setConfirming(true),
          }, t('deleteN', { n: String(picked.length) }))) : undefined,
      },
      state.runs.length
        ? h('ul', { className: 'dsub-rows' }, state.runs.map(run => h(RunRow, {
          key: run.id, run, now, t, onStop, onOpen: openSession,
          selected: Boolean(run.sessionId) && selected.has(run.sessionId), onSelect,
        })))
        : h('div', { className: 'dsub-empty' }, t('runsEmpty')),
      error ? h('p', { className: 'dsub-error', role: 'alert' }, error) : null,
      state.runs.length ? h('p', { className: 'dsub-muted' }, t('runsHint')) : null,
      h(P.Modal, {
        open: confirming,
        onClose: () => { if (!deleting) setConfirming(false); },
        title: t('deleteTitle', { n: String(picked.length) }),
        closeLabel: t('close'),
        description: t('deleteDesc'),
        className: 'dsub-dialog',
        footer: h(React.Fragment, null,
          h(P.Button, { variant: 'outline', disabled: deleting, onClick: () => setConfirming(false) }, t('cancel')),
          h(P.Button, { variant: 'outline', className: 'dsub-danger', disabled: deleting, onClick: remove }, deleting ? t('deleting') : t('confirmDelete'))),
      }));
    }

    function HowToCard({ state, t }) {
      const rows = [
        [t('howto1'), 'deepseek_research'],
        [t('howto2'), 'deepseek_code'],
        [t('howto3'), 'deepseek_continue'],
        [t('howto4'), 'deepseek_sessions · deepseek_result · deepseek_steer · deepseek_cancel'],
      ];
      return h(Card, { title: t('howtoTitle'), sub: t('howtoSub') },
        h('dl', { className: 'dsub-howto' }, rows.map(([phrase, tool]) => h('div', { key: tool },
          h('dt', null, phrase),
          h('dd', null, tool)))),
        h('p', { className: 'dsub-muted' }, t('howtoFoot', { port: String(state.port) })));
    }

    // -------------------------------------------------------------------------
    // The section: one snapshot of the host, polled while the page is open.
    // -------------------------------------------------------------------------
    function Section({ t, close, openSession }) {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const alive = useRef(true);
      const load = useCallback(async () => {
        try {
          const next = await api('/state');
          if (!alive.current) return;
          setState(next);
          setError(null);
        } catch (e) {
          if (!alive.current) return;
          setError(String(e.message || e));
        }
      }, []);
      useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
        return () => { alive.current = false; clearInterval(timer); };
      }, [load]);
      const setCatalog = useCallback(catalog => setState(prev => (prev ? { ...prev, catalog } : prev)), []);

      let body;
      if (state === null) {
        body = error
          ? h('div', { className: 'dsub-cards' },
            h('p', { className: 'dsub-error', role: 'alert' }, t('loadError', { error })),
            h('div', null, h(P.Button, { variant: 'outline', size: 'sm', onClick: load }, t('retry'))))
          : h('p', { className: 'dsub-muted' }, t('loading'));
      } else {
        body = h('div', { className: 'dsub-cards' },
          error ? h('p', { className: 'dsub-error', role: 'alert' }, t('loadError', { error })) : null,
          h(StatusCard, { state, t }),
          h(AgentsCard, { state, t, reload: load }),
          h(ModelsCard, { state, t, setCatalog }),
          h(RunsCard, { state, t, reload: load, openSession: id => { close(); openSession(id); } }),
          h(HowToCard, { state, t }));
      }
      return h('div', { className: 'dsub-section' },
        h('h2', { className: 'dsub-title' }, t('title')),
        h('p', { className: 'dsub-intro' }, t('intro')),
        body);
    }

    // The launcher deep link. Onboarding steps are the one place the shell hands
    // out `openSection`, so a step that completes itself at once is how the
    // fragment turns into an open panel. It only runs while the UI is on a blank
    // session — on a restored conversation the fragment simply does nothing.
    let deepLinkPending = false;
    function DeepLinkStep({ complete, openSection }) {
      useEffect(() => {
        if (deepLinkPending) {
          deepLinkPending = false;
          openSection(SECTION_ID);
        }
        complete();
      }, [complete, openSection]);
      return null;
    }

    // -------------------------------------------------------------------------
    // Plugin entry
    // -------------------------------------------------------------------------
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-sub-mcp: copy dictionaries');
      const t = ctx.locale.bind(NS);

      if (typeof location !== 'undefined' && location.hash === SETTINGS_HASH) {
        deepLinkPending = true;
        history.replaceState(null, '', location.pathname + location.search);
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 12,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ openSession: id => ctx.get('uiWorkspace')?.openSession(id) }),
      }, Section));

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'dsh-sub-deep-link',
        order: 1000,
        inject: () => ({}),
      }, DeepLinkStep));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
