# ⚡ Kartik Codes Proxy

A **local API-key pooling proxy** for teams. Pool everyone's free-tier API keys (OpenRouter, OpenCode, NVIDIA NIM, Google AI Studio, Groq) into **one single model** that your coding agent (OpenCode, or anything OpenAI-compatible) uses — and never see a quota error again.

```
Your editor ──► "kartik-proxy-codes" ──► PROXY ──► tries keys in order ──► answer
                                            │
                                            ├─ quota hit?  → silently switch to next key
                                            ├─ key dead?   → skip it
                                            ├─ model overloaded? → try another provider
                                            └─ all fail?   → clear error message
```

---

## ✨ Features

- **One model in your editor** — `kartik-proxy-codes` hides the whole key pool behind it
- **Multi-provider pool** — OpenRouter, OpenCode, NVIDIA NIM, Google AI Studio (incl. new `AQ.`-format keys), Groq — auto-detected from the key prefix
- **Per-provider model mapping** — the same unified model translates to each provider's real ID (e.g. GLM → `z-ai/glm-5.3-flash` on OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b` on NVIDIA)
- **Automatic failover** — 429 / free-limit / invalid key / overloaded (5xx) / missing model → instantly tries the next key, your session never breaks
- **⚖ Priority / 🔄 Spread modes** — burn keys in order, or rotate usage evenly across all keys (with latency-aware ordering: slow and failing keys go to the back of the line automatically)
- **Combined balances dashboard** — real OpenRouter credits + proxy-tracked token usage per key
- **Web UI** — add keys, tick which models each key serves, reorder with ▲▼, switch the active model with one click (no editor restart needed)
- **Live sync** — WebSocket pushes config changes to every open browser tab
- **Hot reload** — edit `server/config.yaml` directly, the proxy picks it up instantly

## 🚀 Quick Start

### 1. Install & run

```bash
git clone https://github.com/kartikpatel15092006/kartik-codes-proxy.git
cd kartik-codes-proxy
npm install
cd client && npm install && cd ..
npm run build
npm start
```

> **Windows shortcut:** double-click `Start Proxy.bat` — it installs, builds and starts everything on first run.

### 2. Add your keys

Open **http://localhost:4000** → 🔑 **API Keys** tab:

1. Paste a member's API key (type is auto-detected)
2. **Tick the models that key can serve** (e.g. GLM Flash Free, Nemotron Ultra)
3. Click **Add Key** — order keys with ▲▼ (higher = tried first)

### 3. Connect OpenCode

In the ⚙️ **OpenCode Setup** tab, click **⬇ Download opencode.json** and place it in your OpenCode config folder:

- **Global:** `~/.config/opencode/opencode.json`
- **Per project:** next to where you run `opencode`

Then restart OpenCode and pick the model **`kartik_codes → kartik-proxy-codes`**.

<details>
<summary>What the generated opencode.json looks like</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kartik_codes": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "kartik_codes",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "<your generated proxy key>"
      },
      "models": {
        "kartik-proxy-codes": { "name": "Kartik Proxy Codes" }
      }
    }
  }
}
```
</details>

### 4. Use any OpenAI-compatible client

Point any tool at `http://localhost:4000/v1` with your proxy key as the API key:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <your-proxy-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"kartik-proxy-codes","messages":[{"role":"user","content":"hello"}]}'
```

---

## 🧠 How routing works

1. Your editor always requests **`kartik-proxy-codes`**
2. The proxy translates it to the **active model** (selected in the UI header — switchable live)
3. It filters the pool to keys that **serve that model** (per-key ticks)
4. It translates the model ID to the provider's **native ID** (mapping table in the Model Catalog tab)
5. It tries keys in order (priority) or rotated (spread) — on any quota/limit/dead-key/overload error it **silently fails over** to the next one

### Free keys that work great in the pool

| Provider | Key prefix | Get a free key | Good free models |
|----------|-----------|----------------|------------------|
| OpenRouter | `sk-or-v1-…` | openrouter.ai | GLM Flash, Nemotron Ultra |
| NVIDIA NIM | `nvapi-…` | build.nvidia.com | Nemotron 3 Ultra, GLM, Kimi |
| Google AI Studio | `AIza…` / `AQ.…` | aistudio.google.com | Gemini 3.x Flash (free tier) |
| Groq | `gsk_…` | console.groq.com | GPT-OSS 120B, Qwen 3.8 |
| OpenCode | `oc_sk_…` | opencode.ai | GLM Flash (free tier) |

---

## 📖 The UI

| Tab | What you do there |
|-----|-------------------|
| 🔑 **API Keys** | Add/delete keys, tick served models, ▲▼ priority, test ▶, reset quota ↺, live balances |
| 🧠 **Model Catalog** | Define unified models and their per-provider real IDs |
| ⚙️ **OpenCode Setup** | Download/copy `opencode.json`, setup steps |

**Header controls:** `⚖ Priority ↔ 🔄 Spread` toggle · `Serving model` dropdown (switches the real model behind `kartik-proxy-codes` live) · connection indicator

### Balances

- **OpenRouter keys** → real USD balance, live from OpenRouter's credits API
- **Other keys** → token usage tracked by the proxy (requests, tokens in/out)
- **Combined totals** at the top of the keys tab

---

## ⚙️ Configuration

Everything lives in `server/config.yaml` (auto-created on first start, hot-reloads on change):

```yaml
proxyKey: ""                 # auto-generated if empty — this is the key your editor uses
activeModel: glm-5.3-flash-free
spreadMode: false            # false = priority order, true = rotate evenly (latency-aware)
models:                      # unified model → per-provider real IDs
  - id: glm-5.3-flash-free
    name: GLM 5.3 Flash Free
    map:
      openrouter: z-ai/glm-5.3-flash
      nvidia: z-ai/glm-5.3-flash
providers: []                # your pooled keys — add via UI or here
```

See **`server/config.example.yaml`** for a fully annotated template.

> 🔐 `config.yaml` contains your real API keys and is **git-ignored** — never commit it. Start from `config.example.yaml`.

---

## 🛡 Responsible use

This tool is for pooling **your own and your team members' legitimately-obtained API keys** with human-like pacing (per-key minimum gaps + jitter in spread mode). It is not designed to evade provider fraud systems — don't mass-create accounts or rotate identities to bypass per-IP limits. Providers' free tiers have per-key/per-network limits; respect them and use paid tiers for heavy sustained workloads.

---

## 🧰 Tech Stack

- **Backend:** Node.js + Express + WebSocket (`ws`), zero-database (YAML file storage)
- **Frontend:** React + Vite (served statically by the same server on port 4000)
- **Auth:** single generated proxy key (`kx_…`)

## 📄 License

MIT — use it, share it, improve it.
