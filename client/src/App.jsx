import { useState, useEffect, useCallback } from 'react';

const API = 'http://localhost:4000/api';
const WS_URL = 'ws://localhost:4000';
const UNIFIED_MODEL = 'kartik-proxy-codes';

export default function App() {
  const [config, setConfig] = useState({ providers: [], models: [], proxyKey: '', activeModel: '' });
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('keys');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 5000); };

  const api = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }, []);

  const refresh = useCallback(async () => {
    try { setConfig(await api('/config')); } catch (e) {}
  }, [api]);

  useEffect(() => {
    refresh();
    const socket = new WebSocket(WS_URL);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'config') setConfig(msg.config);
        if (msg.type === 'testResult') showToast(msg.result);
      } catch (err) {}
    };
    return () => socket.close();
  }, [refresh]);

  const activeCount = config.providers.filter(p => p.enabled && !p.quotaExhausted).length;
  const [balances, setBalances] = useState(null);

  const loadBalances = useCallback(async () => {
    try { setBalances(await api('/balances')); } catch (e) {}
  }, [api]);

  useEffect(() => { loadBalances(); }, [loadBalances, config.providers.length]);

  return (
    <div className="app">
      <header className="header">
        <div className="hl">
          <h1>⚡ Kartik Codes Proxy</h1>
          <span className="badge">{activeCount}/{config.providers.length} keys live</span>
        </div>
        <div className="hr">
          <button
            className={config.spreadMode ? 'mode-btn spread' : 'mode-btn'}
            title={config.spreadMode
              ? 'Spread: rotates across ALL keys evenly (least-used first) — natural office pattern'
              : 'Priority: burns key #1 first, then #2, #3… Click to switch to Spread mode'}
            onClick={async () => {
              const next = !config.spreadMode;
              await api('/spreadmode', { method: 'POST', body: JSON.stringify({ spreadMode: next }) });
              await refresh();
              showToast(next ? '🔄 Spread mode: usage rotates evenly across all keys' : '⚖ Priority mode: key #1 used first, then failover');
            }}
          >
            {config.spreadMode ? '🔄 Spread' : '⚖ Priority'}
          </button>
          {config.models.length > 0 && (
            <label className="am-label">
              Serving model
              <select
                className="am-select"
                value={config.activeModel || ''}
                onChange={async e => {
                  await api('/activemodel', { method: 'POST', body: JSON.stringify({ id: e.target.value }) });
                  await refresh();
                  showToast(`kartik-proxy-codes now serves: ${e.target.value}`);
                }}
              >
                {config.models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
            </label>
          )}
          <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '●' : '○'}</span>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'keys' ? 'tab active' : 'tab'} onClick={() => setTab('keys')}>🔑 API Keys</button>
        <button className={tab === 'models' ? 'tab active' : 'tab'} onClick={() => setTab('models')}>🧠 Model Catalog</button>
        <button className={tab === 'setup' ? 'tab active' : 'tab'} onClick={() => setTab('setup')}>⚙️ OpenCode Setup</button>
      </nav>

      <main className="main">
        {tab === 'keys' && <KeysTab config={config} api={api} refresh={refresh} showToast={showToast} balances={balances} loadBalances={loadBalances} />}
        {tab === 'models' && <ModelsTab config={config} api={api} refresh={refresh} showToast={showToast} />}
        {tab === 'setup' && <SetupTab config={config} showToast={showToast} />}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ---------------- KEYS TAB ---------------- */
function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function BalancesBar({ balances, loadBalances, showToast }) {
  if (!balances) return null;
  return (
    <div className="card form-card balances-card">
      <div className="bal-row">
        <div className="bal-item">
          <span className="bal-label">💰 Combined credits left</span>
          <span className="bal-val">${balances.combinedCredits.toFixed(4)}</span>
          <span className="bal-sub">OpenRouter real balance</span>
        </div>
        <div className="bal-item">
          <span className="bal-label">🔢 Tokens used via proxy</span>
          <span className="bal-val">{fmtNum(balances.tokensUsed)}</span>
          <span className="bal-sub">in + out, all keys</span>
        </div>
        <button className="btn sm" onClick={async () => { showToast('Refreshing balances…'); await loadBalances(); showToast('Balances updated ✓'); }}>↻ Refresh</button>
      </div>
      <div className="bal-keys">
        {balances.keys.map(k => (
          <span key={k.id} className={'bk-chip' + (k.quotaExhausted ? ' dead' : '')}>
            <b>{k.name}</b>
            {k.type === 'openrouter'
              ? ` · $${(k.balance ?? 0).toFixed(4)}${k.error ? ' (' + k.error + ')' : ''}`
              : ` · ${fmtNum((k.stats.tokensIn || 0) + (k.stats.tokensOut || 0))} tok`}
          </span>
        ))}
      </div>
    </div>
  );
}

function KeysTab({ config, api, refresh, showToast, balances, loadBalances }) {
  const [form, setForm] = useState({ name: '', apiKey: '', type: 'auto', models: [] });
  const [busy, setBusy] = useState(false);

  const toggleModel = (mid) => {
    setForm(f => ({
      ...f,
      models: f.models.includes(mid) ? f.models.filter(m => m !== mid) : [...f.models, mid],
    }));
  };

  const add = async (e) => {
    e.preventDefault();
    if (!form.apiKey.trim()) return;
    setBusy(true);
    try {
      await api('/providers', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', apiKey: '', type: 'auto', models: [] });
      await refresh();
      showToast('Key added ✓');
    } catch (err) { showToast('Error: ' + err.message); }
    setBusy(false);
  };

  const toggleOnKey = async (p, mid) => {
    const models = (p.models || []).includes(mid)
      ? (p.models || []).filter(m => m !== mid)
      : [...(p.models || []), mid];
    await api(`/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ models }) });
    await refresh();
  };

  const del = async (id) => { await api(`/providers/${id}`, { method: 'DELETE' }); await refresh(); };
  const reset = async (id) => { await api(`/providers/${id}/reset-quota`, { method: 'POST' }); await refresh(); showToast('Quota reset ✓'); };
  const test = async (id) => { showToast('Testing…'); await api(`/providers/${id}/test`, { method: 'POST' }); };
  const move = async (id, dir) => {
    const ps = [...config.providers];
    const i = ps.findIndex(p => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    await api('/providers/reorder', { method: 'POST', body: JSON.stringify({ ids: ps.map(p => p.id) }) });
    await refresh();
  };

  return (
    <>
      <BalancesBar balances={balances} loadBalances={loadBalances} showToast={showToast} />

      <div className="card form-card">
        <h3>Add Member Key</h3>
        <div className="fgrid">
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
              <option value="auto">Auto-detect</option>
              <option value="opencode">OpenCode (oc_sk_…)</option>
              <option value="openrouter">OpenRouter (sk-or-v1-…)</option>
              <option value="nvidia">NVIDIA NIM (nvapi-…)</option>
              <option value="google">Google AI Studio (AIza… / AQ.…)</option>
              <option value="groq">Groq (gsk_…)</option>
            </select>
          </div>
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Rahul's key" />
          </div>
          <div className="field full">
            <label>API Key</label>
            <input type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="oc_sk_… or sk-or-v1-…" />
          </div>
        </div>
        <div className="mselect">
          <label>Models this key can serve</label>
          <div className="mchips">
            {config.models.map(m => (
              <button
                type="button"
                key={m.id}
                className={form.models.includes(m.id) ? 'chip on' : 'chip'}
                onClick={() => toggleModel(m.id)}
              >
                {m.id}{form.models.includes(m.id) ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary" onClick={add} disabled={busy}>{busy ? 'Adding…' : '+ Add Key'}</button>
      </div>

      <div className="list-head">
        Priority = the order keys are tried. ▲▼ to reorder. Ticking a model on/off a key updates instantly.
      </div>

      {config.providers.length === 0 && <div className="empty">No keys yet. Add your first member key above ↑</div>}

      {config.providers.map((p, i) => {
        const status = p.quotaExhausted ? { c: 'var(--red)', t: 'EXHAUSTED' } : p.enabled ? { c: 'var(--accent)', t: 'ACTIVE' } : { c: 'var(--muted)', t: 'OFF' };
        return (
          <div key={p.id} className="row" style={{ borderLeft: `4px solid ${status.c}` }}>
            <div className="row-top">
              <div className="ord">
                <button className="mv" onClick={() => move(p.id, -1)} disabled={i === 0}>▲</button>
                <span className="ordn">#{i + 1}</span>
                <button className="mv" onClick={() => move(p.id, 1)} disabled={i === config.providers.length - 1}>▼</button>
              </div>
              <span className={`tag ${p.type}`}>{p.type === 'opencode' ? 'OpenCode API' : p.type === 'openrouter' ? 'OpenRouter API' : p.type === 'nvidia' ? 'NVIDIA NIM' : p.type === 'google' ? 'Google AI Studio' : p.type === 'groq' ? 'Groq API' : p.type}</span>
              <span className="pname">{p.name}</span>
              <span className="pkey">{p.apiKey.slice(0, 10)}…{p.apiKey.slice(-4)}</span>
              <span className="st" style={{ color: status.c }}>● {status.t}</span>
              <div className="acts">
                <button className="ib test" onClick={() => test(p.id)} title="Test key">▶</button>
                <button className="ib reset" onClick={() => reset(p.id)} title="Reset quota" disabled={!p.quotaExhausted}>↺</button>
                <button className="ib del" onClick={() => del(p.id)} title="Delete">✕</button>
              </div>
            </div>
            <div className="row-models">
              <span className="rm-label">serves:</span>
              {config.models.map(m => {
                const on = (p.models || []).includes(m.id);
                return (
                  <button key={m.id} className={on ? 'chip on sm' : 'chip sm'} onClick={() => toggleOnKey(p, m.id)}>
                    {m.id}
                  </button>
                );
              })}
            </div>
            {balances && (
              <div className="row-models">
                <span className="rm-label">usage:</span>
                <span className="use-chip">
                  {p.type === 'openrouter' && balances.keys.find(k => k.id === p.id)?.balance != null
                    ? `$${balances.keys.find(k => k.id === p.id).balance.toFixed(4)} left`
                    : `${fmtNum((balances.keys.find(k => k.id === p.id)?.stats.tokensIn || 0) + (balances.keys.find(k => k.id === p.id)?.stats.tokensOut || 0))} tok via proxy`}
                </span>
                <span className="use-chip dim">{balances.keys.find(k => k.id === p.id)?.stats.requests || 0} requests</span>
              </div>
            )}
            {p.lastTested && (
              <div className="row-sub">Tested {new Date(p.lastTested).toLocaleTimeString()} — {p.lastTestResult}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- MODELS TAB ---------------- */
function ModelsTab({ config, api, refresh, showToast }) {
  const [f, setF] = useState({ id: '', name: '', oc: '', or_: '' });

  const add = async (e) => {
    e.preventDefault();
    if (!f.id.trim()) return;
    const map = {};
    if (f.oc.trim()) map.opencode = f.oc.trim();
    if (f.or_.trim()) map.openrouter = f.or_.trim();
    try {
      await api('/models', { method: 'POST', body: JSON.stringify({ id: f.id.trim(), name: f.name.trim() || f.id.trim(), map }) });
      setF({ id: '', name: '', oc: '', or_: '' });
      await refresh();
      showToast('Model added ✓');
    } catch (err) { showToast('Error: ' + err.message); }
  };

  const del = async (mid) => { await api(`/models/${mid}`, { method: 'DELETE' }); await refresh(); };

  return (
    <>
      <div className="card form-card">
        <h3>Model Catalog</h3>
        <p className="muted">
          OpenCode only ever sees <code>kartik-proxy-codes</code>. These are the real models behind it.
          When a key serves a model, the ID is translated per provider (mapping below).
          The <b>active model</b> selector in the header decides what <code>kartik-proxy-codes</code> serves right now.
        </p>
        <div className="fgrid">
          <div className="field">
            <label>Model ID (proxy name) *</label>
            <input value={f.id} onChange={e => setF({ ...f, id: e.target.value })} placeholder="glm-5.3-flash-free" />
          </div>
          <div className="field">
            <label>Display Name</label>
            <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="GLM 5.3 Flash Free" />
          </div>
          <div className="field">
            <label>→ OpenCode API ID</label>
            <input value={f.oc} onChange={e => setF({ ...f, oc: e.target.value })} placeholder="same as Model ID if empty" />
          </div>
          <div className="field">
            <label>→ OpenRouter ID</label>
            <input value={f.or_} onChange={e => setF({ ...f, or_: e.target.value })} placeholder="z-ai/glm-5.3-flash" />
          </div>
        </div>
        <button className="btn primary" onClick={add}>+ Add Model</button>
      </div>

      {config.models.length === 0 && <div className="empty">No models in catalog.</div>}
      {config.models.map(m => {
        const active = config.activeModel === m.id;
        return (
          <div key={m.id} className={'row model-row' + (active ? ' active-row' : '')}>
            <code className="mid">{m.id}</code>
            <div className="maps">
              <span className="mapchip">OpenCode → {m.map?.opencode || m.id}</span>
              <span className="mapchip">OpenRouter → {m.map?.openrouter || m.id}</span>
            </div>
            {active && <span className="tag opencode">ACTIVE</span>}
            <button className="ib del" onClick={() => del(m.id)}>✕</button>
          </div>
        );
      })}
    </>
  );
}

/* ---------------- SETUP TAB ---------------- */
function SetupTab({ config, showToast }) {
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      kartik_codes: {
        npm: '@ai-sdk/openai-compatible',
        name: 'kartik_codes',
        options: {
          baseURL: 'http://localhost:4000/v1',
          apiKey: config.proxyKey || 'PASTE_PROXY_KEY_HERE',
        },
        models: {
          [UNIFIED_MODEL]: { name: 'Kartik Proxy Codes' },
        },
      },
    },
  };

  const copy = (text, label) => navigator.clipboard.writeText(text).then(() => showToast(label + ' copied ✓'));

  const download = () => {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'opencode.json';
    a.click();
    showToast('Downloaded — put it where you run opencode (or ~/.config/opencode/)');
  };

  return (
    <>
      <div className="card form-card">
        <h3>Step 1 — opencode.json (single model, key included)</h3>
        <p className="muted">OpenCode shows exactly one model: <code>{UNIFIED_MODEL}</code>. Everything (provider choice, failover, model switching) is handled by this proxy.</p>
        <pre className="code">{JSON.stringify(cfg, null, 2)}</pre>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={download}>⬇ Download opencode.json</button>
          <button className="btn primary" style={{ flex: 1 }} onClick={() => copy(JSON.stringify(cfg, null, 2), 'Config')}>📋 Copy</button>
        </div>
      </div>

      <div className="card form-card">
        <h3>Step 2 — Place the file</h3>
        <ol className="steps">
          <li><b>Global:</b> <code>C:\Users\Asus\.config\opencode\opencode.json</code></li>
          <li><b>Per project:</b> <code>opencode.json</code> in the folder where you run <code>opencode</code></li>
          <li>Restart opencode</li>
        </ol>
      </div>

      <div className="card form-card">
        <h3>Step 3 — Use it</h3>
        <ol className="steps">
          <li>Open opencode → model picker (Tab key or <code>/models</code>)</li>
          <li>Pick <b>kartik_codes → kartik-proxy-codes</b></li>
          <li>To switch the real model (GLM ↔ Nemotron ↔ …) just change it in the proxy header — no OpenCode restart needed</li>
        </ol>
      </div>

      <div className="card form-card">
        <h3>Daily workflow</h3>
        <ol className="steps">
          <li>Member gives you a new key → <b>🔑 API Keys</b> tab → paste key → tick models it can serve → Add</li>
          <li>Order it with ▲▼ (higher = tried first)</li>
          <li>Proxy auto-fails-over: quota/limit → next key instantly, silently</li>
        </ol>
      </div>
    </>
  );
}