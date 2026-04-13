# azure-openai-forwarder

A lightweight Cloudflare Worker that sits between any OpenAI-compatible client
and an Azure OpenAI deployment.  Deploy once, point your client at the Worker
URL, and never touch Azure's deployment-specific URLs or `api-version` strings
again.

```
Client (OpenAI SDK / Hermes / …)
  └─▶  https://your-worker.workers.dev/v1/…
         └─▶  Cloudflare Worker
                └─▶  Azure OpenAI Gateway
```

## What problems does it solve?

| Problem | Solution |
|---------|----------|
| Azure requires a deployment-specific URL and `api-version` query param | Worker injects both automatically |
| Azure uses `api-key` header; clients send `Authorization: Bearer …` | Worker swaps the header |
| Newer OpenAI SDK calls `/v1/responses` instead of `/v1/chat/completions` | Worker translates the request and response |
| Azure does not support SSE streaming | Worker fetches a complete response and re-emits it as a fake SSE stream |
| gpt-5 / o-series models reject `temperature`, `top_p`, etc. | Worker strips unsupported parameters silently |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Proxied directly to Azure |
| `POST` | `/v1/responses` | OpenAI Responses API → Chat Completions adapter with fake streaming |
| `GET`  | `/v1/models` | Returns the configured deployment as a model stub |
| `GET`  | `/v1/balance` | Proxies to the upstream balance endpoint |
| `GET`  | `/health` | Returns service info (upstream host, deployment, api_version) |

---

## Quick start

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js ≥ 18
- An Azure OpenAI API key

### 1 — Clone and install

```bash
git clone https://github.com/your-username/azure-openai-forwarder
cd azure-openai-forwarder
npm install
```

### 2 — Configure local environment

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```ini
AZURE_UPSTREAM_HOST=https://your-tenant.azure-api.net
AZURE_DEPLOYMENT=gpt-4o-mini
AZURE_API_VERSION=2025-02-01-preview
AZURE_API_KEY=your-azure-api-key
```

### 3 — Run locally

```bash
npm run dev
# Worker is available at http://127.0.0.1:8787
```

Smoke test:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

### 4 — Deploy to Cloudflare

```bash
# Log in (one-time)
npx wrangler login

# Upload your API key as a secret – never commit this
npx wrangler secret put AZURE_API_KEY

# Edit wrangler.jsonc: set AZURE_UPSTREAM_HOST, AZURE_DEPLOYMENT, AZURE_API_VERSION

# Deploy
npm run deploy
```

The Worker will be live at `https://azure-openai-forwarder.<your-subdomain>.workers.dev`.

### 5 — (Optional) Bind a custom domain

Add a route in `wrangler.jsonc`:

```jsonc
"routes": ["ai.your-domain.com/*"]
```

Your domain must be proxied through Cloudflare. Re-run `npm run deploy`.

---

## HKUST users — quick setup

HKUST provides an Azure OpenAI gateway for students and staff.

### Step 1 — Get your API key

Obtain your `api-key` from the HKUST IT / AI platform portal.

### Step 2 — Deploy the Worker

```bash
# Clone and install (see Quick start above)

# Set your HKUST API key as a Cloudflare secret
npx wrangler secret put AZURE_API_KEY
# Paste your key when prompted

# Deploy (wrangler.jsonc already has the correct HKUST defaults)
npm run deploy
```

The default `wrangler.jsonc` is pre-configured for HKUST:

```jsonc
"vars": {
  "AZURE_UPSTREAM_HOST": "https://hkust.azure-api.net",
  "AZURE_DEPLOYMENT":    "gpt-5-mini",
  "AZURE_API_VERSION":   "2025-02-01-preview"
}
```

### Step 3 — Check your balance

```bash
curl https://<your-worker>.workers.dev/v1/balance
# → 7.45
```

### Step 4 — Use with Hermes

```yaml
# ~/.hermes/config.yaml
model:
  provider: custom
  default: gpt-5-mini
  base_url: https://<your-worker>.workers.dev/v1
```

No other configuration is needed.  The Worker handles:

- Responses API ↔ Chat Completions translation
- Fake SSE streaming (Azure does not support real streaming)
- Automatic removal of unsupported parameters for gpt-5 models

---

## Configuration reference

All values are set via environment variables or Cloudflare Secrets.

| Variable | Default | Description |
|----------|---------|-------------|
| `AZURE_UPSTREAM_HOST` | `https://hkust.azure-api.net` | Base URL of the Azure gateway |
| `AZURE_DEPLOYMENT` | `gpt-4o-mini` | Azure deployment name |
| `AZURE_API_VERSION` | `2025-02-01-preview` | Azure `api-version` query parameter |
| `AZURE_API_KEY` | — | **Required.** Set with `wrangler secret put` |

---

## Client examples

**Python (openai SDK)**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="any-string",   # ignored by the Worker; Azure key is injected server-side
)

response = client.chat.completions.create(
    model="gpt-5-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

**curl**

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "content-type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

---

## Security

- `AZURE_API_KEY` is stored as a Cloudflare Secret and is never logged or exposed to clients.
- The client's `Authorization` header is stripped before forwarding to Azure.
- `.dev.vars` is git-ignored.

## License

MIT
