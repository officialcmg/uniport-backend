# uniport-backend

Backend API proxy for the Uniport SDK, running on Cloudflare Workers. Securely stores the NEAR Intents API key and proxies 1Click cross-chain swap requests.

## How it runs

The backend is a Cloudflare Worker with no web framework and one small runtime dependency. `src/worker.ts` is the entry (CORS, rate limiting, routing), `src/api/routes.ts` holds the three routes, and `wrangler.jsonc` the configuration. It is written to stay well inside the free plan's 10 ms of CPU per request; see [CPU time](#cpu-time) before adding dependencies.

| Piece | What it does |
|-------|--------------|
| Worker | Serves the API |
| Neon Postgres (`DATABASE_URL`) | Where quotes and status changes are recorded, written over Neon's SQL-over-HTTP endpoint |
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
| `UNIPORT_INTENTS_REFUND_ACCOUNT` | `vars` in `wrangler.jsonc` | For `EXACT_OUTPUT` | Uniport-controlled NEAR Intents account that receives rounded surplus and failed-swap refunds: a NEAR account or an EVM address. ENS names are not resolved; 1Click accepts any well-formed name, including ones nobody controls |
| `ONECLICK_BASE_URL` | `vars` in `wrangler.jsonc` | No | 1Click API base URL (default `https://1click.chaindefuser.com`) |
| `APP_ID_HMAC_SECRET` | Secret | For App IDs | Signs the short tag inside App IDs. The dashboard must hold the same value. Without it App IDs cannot be checked and callers are treated as unidentified |
| `APP_ID_ENFORCEMENT` | `vars` in `wrangler.jsonc` | No | `on` refuses quotes from websites that send no App ID (default `off`) |
| `VERIFY_QUOTE_SIGNATURES` | `vars` | No | Verify 1Click's signature on every quote, and that it was signed for this request, before returning it (default `true`). Set to `false` only if 1Click changes its signing and quotes start failing with `QUOTE_UNVERIFIED` |
| `DATABASE_URL` | Secret | No | Neon connection string (pooled). When set, live quotes and payment status changes are recorded. Without it, or if the database is unreachable, the API works as normal and nothing is recorded |
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
npm test           # checks the quote hash and signature verification against the 1Click SDK
npm run smoke -- http://localhost:8787          # dry quotes only
npm run smoke -- http://localhost:8787 --live   # also one real quote and a status call
```

To record to a database locally, add `DATABASE_URL` to `.dev.vars`. Use a Neon development branch, not production (`neon checkout dev --create` makes one and writes its URLs to `.env.local`).

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/quote` | Get a cross-chain swap quote |
| `POST` | `/api/deposit` | Submit a deposit transaction hash |
| `GET` | `/api/status/:depositAddress` | Get swap execution status |
| `GET` | `/v1/payments/:depositAddress` | Everything a merchant's server needs to confirm a payment |

Requests are limited to 100 per minute per IP across all endpoints; this limit is approximate and counted separately in each Cloudflare location. Live (non-dry) quotes are also limited per IP, counted exactly: 150 per 10 minutes, or 20 for callers with no App ID. A registered app is limited to 600 quote requests per minute across all its users. IPv6 clients are counted per /56.

## App IDs

A developer registers an app in the dashboard and puts its public **App ID** in their code. The SDK sends it as the `X-Uniport-App-Id` header on `POST /api/quote`, and the quote is recorded against the app. The ID is public: what it protects is which websites may use it, not access to the API.

| Request | Result |
|---------|--------|
| App ID, from an origin the app allows | Quote |
| App ID, from another website | 403 `ORIGIN_NOT_ALLOWED` |
| Unknown, disabled or malformed App ID | 403 `APP_NOT_FOUND` |
| Recipient not on the app's recipient list, when it has one | 403 `RECIPIENT_NOT_ALLOWED` |
| No App ID, from `localhost` or with no `Origin` header (a server or script) | Quote, with the lower live-quote limit |
| No App ID, from a website | Quote while `APP_ID_ENFORCEMENT` is `off`; 403 `APP_ID_REQUIRED` once it is `on` |

- An app's allowed origins are exact (`https://shop.example.com`) or a subdomain wildcard (`https://*.example.com`). `localhost` is allowed unless the app turns it off.
- A request with no `Origin` header is not checked against the list: only browsers send `Origin`, and anything else could send whatever it liked.
- The format is `app_` plus 22 characters, which carry a short signature made with `APP_ID_HMAC_SECRET` (`src/app-id.ts`). The Worker rejects made-up IDs without touching the database. The dashboard creates IDs with the same secret.
- Apps live in the `apps` and `app_ids` tables. The Worker remembers each lookup for a minute, so a change in the dashboard takes up to a minute to apply. If the database cannot be reached, the request goes through as an unidentified caller, so payments keep working.
- `status` and `deposit` calls need no App ID; they are keyed by a deposit address that cannot be guessed.
- `npx tsx scripts/create-app.ts "<name>" <origin>...` creates an app directly in the database, for apps Uniport runs itself.

## Confirming a payment on a server

A merchant must not fulfil an order because the browser said the payment succeeded. `GET /v1/payments/:depositAddress` (add `?memo=` for chains that use one) returns the payment as 1Click reports it, with the quote 1Click signed. The merchant's server should check:

- `appId` is its own App ID,
- `recipient` and `destinationAsset` are what it expected,
- `amountOut` is at least the order amount,
- `status` is `SUCCESS`,
- and that it has not already accepted this deposit address for another order.

No secret is needed. The payment details come live from 1Click; only `appId` and `createdAt` come from Uniport's record of the quote. If that record could not be read, `appIdKnown` is `false` and `appId` is `null`.

## Deployment (Cloudflare Workers)

First-time setup, once per Cloudflare account:

```bash
# 1. Sign in (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
npx wrangler login

# 2. Deploy. This creates the Worker, the Durable Object and the workers.dev URL.
npm run deploy

# 3. Set the secrets. Until NEAR_API_KEY is set, /api calls return 503.
npx wrangler secret put NEAR_API_KEY
npx wrangler secret put DATABASE_URL    # Neon's pooled connection string
npx wrangler secret put APP_ID_HMAC_SECRET   # any long random string; the dashboard needs the same one

#    On a new database, create the tables first (see Database above):
npm run migrate

# 4. Check it
npm run smoke -- https://uniport-backend.<your-subdomain>.workers.dev --live
```

After that, `npm run deploy` ships the current checkout. To serve it from your own domain, add a route to `wrangler.jsonc` and deploy again:

```jsonc
"routes": [{ "pattern": "api.example.com", "custom_domain": true }]
```

Then set the SDK's default backend URL (`DEFAULT_HOSTED_BACKEND_URL` in `uniport/src/core/config.ts`) to the Worker's URL.

Useful afterwards:

```bash
npx wrangler tail --format json   # live logs, with cpuTime per request
npx wrangler rollback             # go back to the previous version
```

### Free plan limits

The free Workers plan allows 100,000 requests a day for the whole account. Every request counts, including ones answered with 429 and CORS preflights, and once the allowance is used the API returns Cloudflare's error 1027 until midnight UTC. The rate limits here protect 1Click and the database, not this allowance: one client sending 70 requests a minute, which is under the 100 per minute limit, uses it up in a day, and a faster one much sooner. Before real traffic, add a rate limiting rule for the custom domain in the Cloudflare dashboard, or move to the paid plan.

Both rate limiters let requests through if the limiter itself fails, so a limiter outage does not take the API down.

### CPU time

The free Workers plan allows 10 ms of CPU per request; time spent waiting on 1Click or the database does not count. Measured on the deployed Worker with `wrangler tail`, a quote uses about 2 ms (7 ms at most, straight after a deploy) and a status poll about 1 ms.

It stays there because very little code runs, or is even loaded, per request. Each of these was measured and removed:

| Removed | CPU it cost per request |
|---------|-------------------------|
| Express on the Node compatibility layer | 7 to 12 ms |
| The 1Click SDK's request layer (axios) | about 10 ms |
| The SDK's JavaScript Ed25519 check (tweetnacl) | 20 to 30 ms |
| A Postgres connection per request, even through Hyperdrive | 10 to 25 ms |
| Bundling the SDK, a router and Neon's driver (460 KiB against 37 KiB now) | several ms on the first requests of each instance |

So: 1Click and Neon are called with `fetch`; signatures are verified with the runtime's native Ed25519 and SHA-256; the 1Click SDK is a dev dependency, used for its types and by the tests. `src/api/quote-hash.ts` reproduces the SDK's quote hash, and `npm test` checks it against the SDK and against real signed quotes, so run the tests after every SDK upgrade.

Before adding a runtime dependency, deploy and check `cpuTime` in `npx wrangler tail --format json`.
