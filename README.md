# uniport-backend

Backend API proxy for the Uniport SDK. Securely stores the NEAR Intents API key and proxies 1Click cross-chain swap requests.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your NEAR API key
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEAR_API_KEY` | **Yes** | — | Your NEAR Intents API key. Get one at [partners.near-intents.org](https://partners.near-intents.org/) |
| `PORT` | No | `3001` | Port the server listens on |
| `ONECLICK_BASE_URL` | No | `https://1click.chaindefuser.com` | 1Click API base URL (override for staging/testing) |
| `UNIPORT_INTENTS_REFUND_ACCOUNT` | For `EXACT_OUTPUT` | — | Uniport-controlled Intents account that receives rounded surplus and failed-swap refunds |
| `VERIFY_QUOTE_SIGNATURES` | No | `true` | Verify 1Click's signature on every quote, and that it was signed for this request, before returning it. Set to `false` only if 1Click changes its signing and quotes start failing with `QUOTE_UNVERIFIED` |
| `DATABASE_URL` | No | — | Neon Postgres connection string (pooled). When set, live quotes and payment status changes are recorded. Without it, or if the database is unreachable, the API works as normal and nothing is recorded |
| `DATABASE_URL_UNPOOLED` | For `npm run migrate` | — | Direct (non-pooled) Neon connection string, used only to run migrations |

## Database

Live (non-dry) quotes are saved to the `quotes` table, and each status change seen by `/api/status` is added to `quote_status_events`. Writes happen after the response is sent, so the database never slows down or fails a request.

The schema lives in `migrations/` as plain SQL files, applied in name order:

```bash
neon env pull      # writes DATABASE_URL and DATABASE_URL_UNPOOLED to .env.local
npm run migrate    # applies any migrations that have not run yet
```

Run `npm run migrate` before deploying a change that adds a migration.

## Development

```bash
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/quote` | Get a cross-chain swap quote |
| `POST` | `/api/deposit` | Submit a deposit transaction hash |
| `GET` | `/api/status/:depositAddress` | Get swap execution status |

## Deployment (Railway)

1. Create a new Railway service from this repository.
2. Set the service root directory to `uniport-backend`.
3. Add the required environment variable `NEAR_API_KEY`, and `DATABASE_URL` to record quotes and payments.
4. Deploy. Railway will use `railway.json` for build, start, restart, and health check settings.
5. Verify `/health` on the public Railway domain.

After deployment, update the SDK default hosted backend URL in `uniport-sdk/src/core/config.ts` to the Railway service URL.

```bash
# Verify locally before deploying
npm run build
npm start
```
