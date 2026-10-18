# Global Affairs Wire

Live world geopolitics headlines from 52 international outlets, tagged by region and topic.

Live site: https://nyamalagame.github.io/global-affairs-wire/

## Commodity prices

The strip under the topic filters shows front-month futures for gold, silver, platinum, copper, Brent and WTI crude, natural gas, wheat, corn, soybeans and coffee, plus USD/INR (Yahoo Finance, with Stooq as fallback). India gold (24K, per 10 g) and silver (per kg) are derived from the international price × USD/INR + India's import duty (15% since May 2026), shown ex-GST. Update `INDIA_DUTY` in `scripts/fetch-markets.mjs` if the rate changes.

## How it updates

A GitHub Actions workflow (`.github/workflows/feeds.yml`) runs every 15 minutes. It fetches every feed in `feeds.config.json`, keeps the last 72 hours of stories, writes `data/feeds.json`, and redeploys the site. The page reads that snapshot; if it's missing, the page falls back to fetching the feeds through free CORS proxies.

- **Add or remove an outlet:** edit `feeds.config.json`.
- **Refresh now:** Actions → "Refresh feeds and deploy" → Run workflow.
