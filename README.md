# uniport-backend

Backend API proxy for the Uniport SDK, running on Cloudflare Workers. Securely stores the NEAR Intents API key and proxies 1Click cross-chain swap requests.

## How it runs

The backend is a Cloudflare Worker. The Express app in `src/app.ts` runs through Cloudflare's Node.js HTTP server support; `src/worker.ts` is the entry and `wrangler.jsonc` holds the configuration.

| Piece | What it does |
|-------|--------------|
| Worker | Serves the API |
| Hyperdrive (`HYPERDRIVE`) | Connection pool to Neon Postgres, where quotes and status changes are recorded |
| Rate Limiting binding (`GLOBAL_LIMITER`) | 100 requests per minute per IP |
| Durable Object (`LiveQuoteLimiter`) | 150 live quotes per 10 minutes per IP |

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your NEAR API key
```

## Configuration

| Name | Where | Required | Description |
|------|-------|----------|-------------|
| `NEAR_API_KEY` | Secret | **Yes** | Your NEAR Intents API key. Get one at [partners.near-intents.org](https://partners.near-intents.org/). Without it every `/api` call returns 503 |
| `UNIPORT_INTENTS_REFUND_ACCOUNT` | Secret or `vars` | For `EXACT_OUTPUT` | Uniport-controlled Intents account that receives rounded surplus and failed-swap refunds |
| `ONECLICK_BASE_URL` | `vars` in `wrangler.jsonc` | No | 1Click API base URL (default `https://1click.chaindefuser.com`) |
| `VERIFY_QUOTE_SIGNATURES` | `vars` | No | Verify 1Click's signature on every quote, and that it was signed for this request, before returning it (default `true`). Set to `false` only if 1Click changes its signing and quotes start failing with `QUOTE_UNVERIFIED` |
| `HYPERDRIVE` | Binding in `wrangler.jsonc` | No | Hyperdrive config for the Neon database. Without it, or if the database is unreachable, the API works as normal and nothing is recorded |
| `DATABASE_URL_UNPOOLED` | `.env.local`, for `npm run migrate` only | For migrations | Direct (non-pooled) Neon connection string |

Secrets are set with `npx wrangler secret put <NAME>` for the deployed Worker and in `.dev.vars` for local development.

## Database

Live (non-dry) quotes are saved to the `quotes` table, and each status change seen by `/api/status` is added to `quote_status_events`. Writes happen after the response is sent, so the database never slows down or fails a request.

The schema lives in `migrations/` as plain SQL files, applied in name order:

```bash
neon env pull      # writes DATABASE_URL and DATABASE_URL_UNPOOLED to .env.local
npm run migrate    # applies any migrations that have not run yet
```

Run `npm run migrate` before deploying a change that adds a migration. Migrations run from your machine or CI against Neon directly, not from the Worker.

## Development

```bash
npm run dev        # wrangler dev, on http://localhost:8787
npm run build      # type-check and bundle without deploying
npm run smoke -- http://localhost:8787          # dry quotes only
npm run smoke -- http://localhost:8787 --live   # also one real quote and a status call
```

To record to a database locally, give `wrangler dev` a connection string for the Hyperdrive binding. Use a Neon development branch, not production:

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://..." npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/quote` | Get a cross-chain swap quote |
| `POST` | `/api/deposit` | Submit a deposit transaction hash |
| `GET` | `/api/status/:depositAddress` | Get swap execution status |

Requests are limited to 100 per minute per IP across all endpoints; this limit is approximate and counted separately in each Cloudflare location. Live (non-dry) quotes are also limited to 150 per 10 minutes per IP, counted exactly. IPv6 clients are counted per /64.

## Deployment (Cloudflare Workers)

First-time setup, once per Cloudflare account:

```bash
# 1. Sign in (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
npx wrangler login

# 2. Create the Hyperdrive config from Neon's direct (non-pooled) connection string.
#    This app only writes, so query caching is off.
npx wrangler hyperdrive create uniport-neon \
  --connection-string="$DATABASE_URL_UNPOOLED" \
  --caching-disabled --origin-connection-limit 5
#    Paste the printed id into "hyperdrive" in wrangler.jsonc.

# 3. Deploy. This creates the Worker, the Durable Object and the workers.dev URL.
npm run deploy

# 4. Set the secrets
npx wrangler secret put NEAR_API_KEY
npx wrangler secret put UNIPORT_INTENTS_REFUND_ACCOUNT

# 5. Check it
npm run smoke -- https://uniport-backend.<your-subdomain>.workers.dev --live
```

After that, `npm run deploy` ships the current checkout. To serve it from your own domain, add a route to `wrangler.jsonc` and deploy again:

```jsonc
"routes": [{ "pattern": "api.example.com", "custom_domain": true }]
```

Then set the SDK's default backend URL (`DEFAULT_HOSTED_BACKEND_URL` in `uniport/src/core/config.ts`) to the Worker's URL.

Useful afterwards:

```bash
npx wrangler tail        # live logs
npx wrangler rollback    # go back to the previous version
```
