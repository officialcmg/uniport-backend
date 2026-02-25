# uniport-backend

Backend API proxy for the Uniport SDK. Securely stores the NEAR Intents API key and proxies 1Click cross-chain swap requests.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your NEAR API key
```

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

## Deployment

Deploy to Railway or any Node.js hosting. Set the `NEAR_API_KEY` environment variable.

```bash
npm run build
npm start
```
