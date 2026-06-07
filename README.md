# Car Comp Finder

Small Express app for finding nearby comparable vehicle listings with MarketCheck.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Set `MARKETCHECK_API_KEY` to your MarketCheck API key.
3. Run:

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Coolify Environment

Set these environment variables on the Coolify service:

```bash
MARKETCHECK_API_KEY=your_marketcheck_api_key_here
PORT=3000
```

After changing `MARKETCHECK_API_KEY`, redeploy or restart the service so Node receives the new value.

You can verify whether the deployed app sees the key by opening:

```text
/api/health
```

The response should include:

```json
{
  "ok": true,
  "marketcheckApiKeyConfigured": true
}
```

The health endpoint never returns the key itself.
