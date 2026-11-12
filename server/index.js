import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { readFile, writeFile } from 'fs/promises';
import { watch } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_FILE = join(__dirname, 'config.yaml');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../dist')));

let config = { providers: [], models: [], proxyKey: '', activeModel: '', spreadMode: false };
let wsClients = new Set();

// ==================== DEFAULTS ====================
const UNIFIED_MODEL = 'kartik-proxy-codes';

const DEFAULT_MODELS = [
  { id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash Free', map: { opencode: 'glm-5.3-flash-free', openrouter: 'z-ai/glm-5.3-flash', nvidia: 'z-ai/glm-5.3-flash' } },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', map: { openrouter: 'nvidia/nemotron-3-ultra-550b-a55b:free', nvidia: 'nvidia/nemotron-3-ultra-550b-a55b' } },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', map: { opencode: 'kimi-k2.6', openrouter: 'moonshotai/kimi-k2.6', nvidia: 'moonshotai/kimi-k2.6' } },
  { id: 'gemini-3.8-flash-free', name: 'Gemini 3.8 Flash Free', map: { google: 'gemini-3.8-flash' } },
  { id: 'gemini-3.1-lite-free', name: 'Gemini 3.1 Flash-Lite Free', map: { google: 'gemini-3.1-flash-lite' } },
  { id: 'gpt-oss-120b-free', name: 'GPT-OSS 120B Free (Groq)', map: { groq: 'openai/gpt-oss-120b' } },
  { id: 'qwen-3.8-27b-free', name: 'Qwen 3.8 27B Free (Groq)', map: { groq: 'qwen/qwen3.8-27b' } },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'OpenCode/1.0 (Linux; x64)',
  'OpenCode/1.0 (Windows; x64)',
  'OpenCode/1.0 (MacOS; arm64)',
];

function detectType(apiKey, baseUrl) {
  if (baseUrl?.includes('opencode')) return 'opencode';
  if (baseUrl?.includes('openrouter')) return 'openrouter';
  if (baseUrl?.includes('integrate.api.nvidia') || baseUrl?.includes('nvidia')) return 'nvidia';
  if (baseUrl?.includes('groq.com')) return 'groq';
  if (baseUrl?.includes('generativelanguage') || baseUrl?.includes('googleapis')) return 'google';
  if (apiKey?.startsWith('nvapi-')) return 'nvidia';
  if (apiKey?.startsWith('gsk_')) return 'groq';
  if (apiKey?.startsWith('AIza') || apiKey?.startsWith('AQ.')) return 'google'; // AQ.= new Google key format
  if (apiKey?.startsWith('oc_sk_')) return 'opencode';
  if (apiKey?.startsWith('opencode_')) return 'opencode';
  if (apiKey?.startsWith('sk-or-')) return 'openrouter';
  return 'auto';
}

function getFingerprint(index, type) {
  const ua = type === 'opencode' ? USER_AGENTS[4 + (index % 3)] : USER_AGENTS[index % 4];
  return { userAgent: ua, requestJitterMs: 50 + Math.random() * 150 };
}

// ==================== CONFIG LOAD/SAVE ====================
async function loadConfig() {
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    const yaml = (await import('yaml')).default;
    const parsed = yaml.parse(content) || {};
    config = {
      providers: parsed.providers || [],
      models: parsed.models?.length ? parsed.models : DEFAULT_MODELS,
      proxyKey: parsed.proxyKey || '',
      activeModel: parsed.activeModel || '',
      spreadMode: !!parsed.spreadMode,
    };
    if (!config.proxyKey) config.proxyKey = 'kx_' + randomBytes(16).toString('hex');
    if (!config.activeModel) config.activeModel = config.models[0]?.id || 'glm-5.3-flash-free';

    // Migration: assign defaults to old providers
    config.providers.forEach((p, i) => {
      const type = p.type || detectType(p.apiKey, p.baseUrl);
      if (!p.type) p.type = type;
      if (!p.fingerprint) p.fingerprint = getFingerprint(i, type);
      if (!p.models) {
        p.models = type === 'openrouter'
          ? ['glm-5.3-flash-free', 'nemotron-3.5-super-vl-free']
          : ['glm-5.3-flash-free'];
      }
    });
    broadcast({ type: 'config', config });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Config load error:', e);
    config = {
      providers: [],
      models: DEFAULT_MODELS,
      proxyKey: 'kx_' + randomBytes(16).toString('hex'),
      activeModel: 'glm-5.3-flash-free',
      spreadMode: false,
    };
  }
}

async function saveConfig() {
  const yaml = (await import('yaml')).default;
  await writeFile(CONFIG_FILE, yaml.stringify(config), 'utf-8');
  broadcast({ type: 'config', config });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wsClients.forEach(ws => ws.readyState === 1 && ws.send(data));
}

// ==================== ROUTING ====================
// Providers that (a) can serve the given model, (b) are alive
// Priority mode: config order. Spread mode: least-recently-used first (natural office pattern),
// BUT latency-aware — slow keys (>15s) and keys that just failed go to the back of the line,
// so rotation happens across the FAST pool, not into timeouts.
function getProvidersFor(model, excludeIds = []) {
  const eligible = config.providers
    .filter(p => p.enabled !== false && !p.quotaExhausted && p.apiKey)
    .filter(p => (p.models || []).includes(model))
    .filter(p => !excludeIds.includes(p.id))
    .filter(p => resolveModel(model, p)); // never send a model the provider has no native ID for

  if (config.spreadMode) {
    const now = Date.now();
    const bucket = p => {
      if (p.lastFailAt && now - p.lastFailAt < 120000) return 2; // failed recently → last resort
      if ((p.stats?.lastLatencyMs || 0) > 15000) return 1;       // slow key → backup
      return 0;                                                  // fast & healthy
    };
    const lru = (a, b) => (a.lastRequestAt || 0) - (b.lastRequestAt || 0);
    return eligible
      .map(p => ({ p, b: bucket(p) }))
      .sort((x, y) => x.b - y.b || lru(x.p, y.p))
      .map(x => x.p);
  }
  return eligible.sort((a, b) => (a.priority || 0) - (b.priority || 0));
}

// Translate a unified model ID into the provider's native ID.
// Returns null when this provider has NO native mapping — the caller must skip it.
function resolveModel(model, provider) {
  const type = provider.type || detectType(provider.apiKey, provider.baseUrl);
  const m = config.models.find(x => x.id === model);
  return m?.map?.[type] || null;
}

function markQuotaExhausted(apiKey) {
  const p = config.providers.find(x => x.apiKey === apiKey);
  if (p) { p.quotaExhausted = true; p.quotaExhaustedAt = new Date().toISOString(); saveConfig(); }
}

// Track tokens used through the proxy per key
function trackUsage(provider, usage) {
  provider.stats = provider.stats || { requests: 0, tokensIn: 0, tokensOut: 0 };
  provider.stats.requests = (provider.stats.requests || 0) + 1;
  if (usage) {
    provider.stats.tokensIn = (provider.stats.tokensIn || 0) + (usage.prompt_tokens || 0);
    provider.stats.tokensOut = (provider.stats.tokensOut || 0) + (usage.completion_tokens || 0);
  }
  provider.stats.lastUsed = new Date().toISOString();
  saveConfig();
}

function buildHeaders(provider) {
  return {
    'Authorization': `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': provider.fingerprint?.userAgent || USER_AGENTS[0],
    'Accept': 'application/json',
    'HTTP-Referer': 'https://opencode.ai',
    'X-Title': 'Kartik Codes Proxy',
  };
}

function targetFor(provider, path) {
  if (provider.type === 'opencode') return `https://opencode.ai/inference/openai${path}`;
  if (provider.type === 'nvidia') return `https://integrate.api.nvidia.com${path}`;
  if (provider.type === 'groq') return `https://api.groq.com/openai${path}`;
  // Google's OpenAI-compat endpoint lives at /v1beta/openai/* (no second /v1)
  if (provider.type === 'google') return `https://generativelanguage.googleapis.com/v1beta/openai${path.replace('/v1', '')}`;
  return `${provider.baseUrl}${path}`;
}

// Test a provider key using its first enabled model that has a native mapping
async function testProvider(provider) {
  const model = (provider.models || []).find(mid => resolveModel(mid, provider))
    || (provider.models || [])[0]
    || config.models[0]?.id
    || 'glm-5.3-flash-free';
  const nativeModel = resolveModel(model, provider);
  const url = targetFor(provider, '/v1/chat/completions');
  const headers = buildHeaders(provider);
  const body = JSON.stringify({ model: nativeModel, messages: [{ role: 'user', content: 'test' }], max_tokens: 5 });

  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
    const text = await res.text().catch(() => '');
    const lower = text.toLowerCase();

    if (res.status === 200) return { success: true, status: 200, model: nativeModel };
    if (res.status === 429 || lower.includes('freeusagelimiterror') || lower.includes('free usage limit')) {
      return { success: false, error: 'Quota/limit reached (key valid)', status: res.status, quota: true };
    }
    if (res.status === 401 || res.status === 403) return { success: false, error: 'Invalid API key', status: res.status };
    if (lower.includes('permission') || lower.includes('model access')) {
      return { success: false, error: 'Key valid - enable model in console', status: res.status, keyValid: true };
    }
    if (res.status === 400 && (lower.includes('not a valid model') || lower.includes('no endpoints found'))) {
      return { success: false, error: `Model ${nativeModel} not on this provider`, status: res.status, keyValid: true };
    }
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 80)}`, status: res.status, keyValid: true };
  } catch (e) {
    return { success: false, error: 'Connection failed: ' + e.message };
  }
}

// ==================== MAIN PROXY ====================
async function handleChat(req, res) {
  // OpenCode always asks for kartik-proxy-codes → translate to active model
  const activeModel = config.activeModel || config.models[0]?.id;
  let lastError = 'No keys configured';

  const providers = getProvidersFor(activeModel);
  if (providers.length === 0) {
    return res.status(503).json({
      error: { type: 'proxy_error', message: `No enabled key serves model "${activeModel}". Open the proxy UI and enable it on at least one key.` },
    });
  }

  for (const provider of providers) {
    const nativeModel = resolveModel(activeModel, provider);
    if (!nativeModel) continue; // safety net (already filtered, but never send a raw unified ID)
    const url = targetFor(provider, '/v1/chat/completions');
    const headers = buildHeaders(provider);
    const body = JSON.stringify({ ...req.body, model: nativeModel });

    // Human-like pacing (anti-drain, spread mode only): never hit the same key
    // twice faster than ~1.5-3s. Priority mode stays snappy with tiny jitter.
    const since = Date.now() - (provider.lastRequestAt || 0);
    const minGap = config.spreadMode ? (1500 + Math.random() * 1500) : 0;
    const jitter = provider.fingerprint?.requestJitterMs || 100;
    const wait = Math.max(since < minGap ? minGap - since : 0, Math.random() * jitter);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    provider.lastRequestAt = Date.now();

    try {
      const t0 = Date.now();
      const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(180000) });

      // 200 → stream straight back to OpenCode (SSE works) + track usage
      if (response.status === 200) {
        provider.stats = provider.stats || { requests: 0, tokensIn: 0, tokensOut: 0 };
        provider.stats.lastLatencyMs = Date.now() - t0;
        provider.lastFailAt = null;
        res.status(200);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
          let acc = '';
          for await (const chunk of response.body) {
            res.write(chunk);
            acc += chunk.toString();
            if (acc.length > 500000) acc = acc.slice(-100000);
          }
          res.end();
          const m = acc.match(/"usage"\s*:\s*\{[^{}]*\}/);
          if (m) { try { trackUsage(provider, JSON.parse(m[0].slice(8))); } catch { trackUsage(provider, null); } }
          else trackUsage(provider, null);
        } else {
          const text = await response.text();
          res.send(text);
          try { const j = JSON.parse(text); trackUsage(provider, j.usage); } catch { trackUsage(provider, null); }
        }
        return;
      }

      const text = await response.text();
      const lower = text.toLowerCase();

      // Quota / free-limit / rate-limit → exhaust key, try next
      const quotaHit = response.status === 429
        || lower.includes('freeusagelimiterror')
        || lower.includes('free usage limit')
        || (lower.includes('quota') && lower.includes('exhaust'))
        || (lower.includes('rate') && lower.includes('limit'));
      if (quotaHit) {
        markQuotaExhausted(provider.apiKey);
        provider.lastFailAt = Date.now();
        lastError = `${provider.name}: quota/rate limit`;
        continue;
      }

      // Provider overloaded / server error (5xx) → temporary, try next key
      if (response.status >= 500) {
        provider.lastFailAt = Date.now();
        lastError = `${provider.name}: server overloaded (HTTP ${response.status})`;
        continue;
      }

      // Invalid key → disable, try next
      if (response.status === 401 || response.status === 403) {
        markQuotaExhausted(provider.apiKey);
        lastError = `${provider.name}: invalid key`;
        continue;
      }

      // Model not on this provider → skip to next
      if (lower.includes('not a valid model') || lower.includes('no endpoints found') || lower.includes('model_not_found')
        || lower.includes('is not found for api version') || lower.includes('not supported for generatecontent')) {
        provider.lastFailAt = Date.now();
        lastError = `${provider.name}: model ${nativeModel} unavailable`;
        continue;
      }

      // Other error (5xx, bad request) → return as-is
      res.status(response.status);
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
      res.send(text);
      return;

    } catch (err) {
      provider.lastFailAt = Date.now();
      lastError = `${provider.name}: ${err.message}`;
      continue;
    }
  }

  res.status(503).json({
    error: { type: 'proxy_error', message: `All keys failed for "${activeModel}". Last: ${lastError}` },
  });
}

function checkAuth(req, res, next) {
  const key = (req.headers.authorization || '').replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: { message: 'API key required' } });
  next();
}

// ---- OpenAI-compatible endpoints for OpenCode ----
app.get('/v1/models', checkAuth, (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: UNIFIED_MODEL,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'kartik-codes',
      name: 'Kartik Proxy Codes',
    }],
  });
});

app.post('/v1/chat/completions', checkAuth, handleChat);

// other /v1/* → pass to first available provider
app.all('/v1/*', checkAuth, (req, res) => {
  if (req.path === '/v1/models' || req.path === '/v1/chat/completions') return;
  const provider = config.providers.find(p => p.enabled !== false && !p.quotaExhausted && p.apiKey);
  if (!provider) return res.status(503).json({ error: 'No available providers' });
  fetch(targetFor(provider, req.path), {
    method: req.method,
    headers: buildHeaders(provider),
    body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
  }).then(async r => {
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    if (r.body) { for await (const c of r.body) res.write(c); }
    res.end();
  }).catch(() => res.status(502).json({ error: 'Bad gateway' }));
});

// ==================== MANAGEMENT API ====================
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/providers', async (req, res) => {
  const { name, apiKey, baseUrl, type, models } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  const detectedType = type && type !== 'auto' ? type : detectType(apiKey, baseUrl);
  const provider = {
    id: randomUUID(),
    name: name || (detectedType === 'opencode' ? 'OpenCode Key' : 'OpenRouter Key'),
    apiKey,
    baseUrl: baseUrl || (detectedType === 'opencode' ? 'https://opencode.ai' : 'https://openrouter.ai/api'),
    type: detectedType,
    enabled: true,
    priority: config.providers.length,
    models: models && models.length ? models : (detectedType === 'openrouter'
      ? ['glm-5.3-flash-free', 'nemotron-3-ultra-free']
      : detectedType === 'nvidia'
        ? ['nemotron-3-ultra-free', 'glm-5.3-flash-free']
        : detectedType === 'google'
          ? ['gemini-3.8-flash-free']
          : detectedType === 'groq'
            ? ['gpt-oss-120b-free', 'qwen-3.8-27b-free']
            : ['glm-5.3-flash-free']),
    fingerprint: getFingerprint(config.providers.length, detectedType),
  };
  config.providers.push(provider);
  await saveConfig();
  res.json(provider);
});

app.patch('/api/providers/:id', async (req, res) => {
  const p = config.providers.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const updates = { ...req.body };
  delete updates.id;
  delete updates.priority;
  Object.assign(p, updates);
  await saveConfig();
  res.json(p);
});

app.delete('/api/providers/:id', async (req, res) => {
  config.providers = config.providers.filter(p => p.id !== req.params.id);
  await saveConfig();
  res.json({ ok: true });
});

app.post('/api/providers/reorder', async (req, res) => {
  const { ids } = req.body;
  const map = Object.fromEntries(config.providers.map(p => [p.id, p]));
  config.providers = ids.map((id, i) => (map[id] ? { ...map[id], priority: i } : null)).filter(Boolean);
  await saveConfig();
  res.json({ ok: true });
});

app.post('/api/providers/:id/reset-quota', async (req, res) => {
  const p = config.providers.find(x => x.id === req.params.id);
  if (p) { p.quotaExhausted = false; p.quotaExhaustedAt = null; await saveConfig(); }
  res.json({ ok: true });
});

app.post('/api/providers/:id/test', async (req, res) => {
  const provider = config.providers.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  const result = await testProvider(provider);
  provider.lastTested = new Date().toISOString();
  provider.lastTestResult = result.success
    ? `OK — served model ${result.model}`
    : result.error;
  if (result.quota) provider.quotaExhausted = true;
  await saveConfig();
  const msg = `${provider.name}: ${provider.lastTestResult}`;
  broadcast({ type: 'testResult', result: msg });
  res.json({ ok: true, result });
});

// ---- Model catalog ----
app.post('/api/models', async (req, res) => {
  const { id, name, map } = req.body;
  if (!id) return res.status(400).json({ error: 'Model id required' });
  if (config.models.find(m => m.id === id)) return res.status(400).json({ error: 'Model already exists' });
  config.models.push({ id, name: name || id, map: map || {} });
  if (!config.activeModel) config.activeModel = id;
  await saveConfig();
  res.json({ ok: true });
});

app.patch('/api/models/:id', async (req, res) => {
  const m = config.models.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { name, map } = req.body;
  if (name !== undefined) m.name = name;
  if (map !== undefined) m.map = map;
  await saveConfig();
  res.json(m);
});

app.delete('/api/models/:id', async (req, res) => {
  config.models = config.models.filter(m => m.id !== req.params.id);
  if (config.activeModel === req.params.id) config.activeModel = config.models[0]?.id || '';
  await saveConfig();
  res.json({ ok: true });
});

// ---- Spread mode toggle ----
app.post('/api/spreadmode', async (req, res) => {
  config.spreadMode = !!req.body.spreadMode;
  await saveConfig();
  res.json({ ok: true, spreadMode: config.spreadMode });
});

// ---- Active model (what kartik-proxy-codes serves) ----
app.post('/api/activemodel', async (req, res) => {
  const { id } = req.body;
  if (!config.models.find(m => m.id === id)) return res.status(400).json({ error: 'Unknown model' });
  config.activeModel = id;
  await saveConfig();
  res.json({ ok: true, activeModel: config.activeModel });
});

// ---- Combined balances / tokens left ----
app.get('/api/balances', async (req, res) => {
  const keys = await Promise.all(config.providers.map(async p => {
    const type = p.type || detectType(p.apiKey, p.baseUrl);
    let balance = null, error = null;
    if (type === 'openrouter') {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/credits', {
          headers: { 'Authorization': `Bearer ${p.apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          balance = Math.round(((j.data?.total_credits || 0) - (j.data?.total_usage || 0)) * 10000) / 10000;
        } else error = 'HTTP ' + r.status;
      } catch (e) { error = e.message; }
    }
    return {
      id: p.id,
      name: p.name,
      type,
      balance,
      error,
      quotaExhausted: !!p.quotaExhausted,
      stats: p.stats || { requests: 0, tokensIn: 0, tokensOut: 0 },
    };
  }));
  res.json({
    combinedCredits: keys.reduce((s, k) => s + (k.balance || 0), 0),
    tokensUsed: keys.reduce((s, k) => s + (k.stats.tokensIn || 0) + (k.stats.tokensOut || 0), 0),
    keys,
  });
});

// Reset proxy-tracked usage stats
app.post('/api/usage/reset', async (req, res) => {
  config.providers.forEach(p => { p.stats = { requests: 0, tokensIn: 0, tokensOut: 0 }; });
  await saveConfig();
  res.json({ ok: true });
});

// ---- Proxy key ----
app.post('/api/proxykey', async (req, res) => {
  config.proxyKey = req.body.proxyKey || ('kx_' + randomBytes(16).toString('hex'));
  await saveConfig();
  res.json({ ok: true, proxyKey: config.proxyKey });
});

// ---- Generated opencode.json ----
app.get('/api/opencode-config', (req, res) => {
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
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(cfg, null, 2));
});

app.get('/health', (req, res) => res.json({
  ok: true,
  providers: config.providers.length,
  active: config.providers.filter(p => p.enabled && !p.quotaExhausted).length,
  models: config.models.length,
  activeModel: config.activeModel,
}));

app.get('*', (req, res) => res.sendFile(join(__dirname, '../dist/index.html')));

// ==================== START ====================
const server = app.listen(4000, () => {
  console.log('Proxy running on http://localhost:4000');
  console.log('OpenCode uses single model: kartik-proxy-codes');
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'config', config }));
  ws.on('close', () => wsClients.delete(ws));
});

watch(CONFIG_FILE, () => loadConfig());
loadConfig();