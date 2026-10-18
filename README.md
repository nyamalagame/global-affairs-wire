# Global Affairs Wire

Live world geopolitics headlines from 52 international outlets, tagged by region and topic.

Live site: https://nyamalagame.github.io/global-affairs-wire/

## How it updates

A GitHub Actions workflow (`.github/workflows/feeds.yml`) runs every 15 minutes. It fetches every feed in `feeds.config.json`, keeps the last 72 hours of stories, writes `data/feeds.json`, and redeploys the site. The page reads that snapshot; if it's missing, the page falls back to fetching the feeds through free CORS proxies.

- **Add or remove an outlet:** edit `feeds.config.json`.
- **Refresh now:** Actions → "Refresh feeds and deploy" → Run workflow.
