# Global Affairs Wire

World, India and Indian-markets news in one compact live feed, in three tabs:

- **World:** 52 international outlets, think tanks and defence sites, tagged by region and topic.
- **India:** 13 Indian national outlets, plus world-outlet stories about India.
- **Dalal Street:** 44 Indian financial news feeds from 17 outlets, plus 13 official NSE and BSE filing feeds, with Stock picks and Exchange filings views.

Live site: https://nyamalagame.github.io/global-affairs-wire/ (Dalal Street: https://nyamalagame.github.io/global-affairs-wire/dalal-street/)

## Layout

All three tabs share one stylesheet (`assets/wire.css`) and one look: a slim header with the World · India · Dalal Street tabs, a single toolbar row, and a compact headline list (time and short outlet name beside each headline). The lines button switches to a detailed view with summaries and tags; it is remembered per browser. Outlets, feed health and fetch details are in the **Sources** panel. The light/dark choice in Sources is shared by all tabs.

## Commodity prices

The strip under the toolbar on World and India shows front-month futures for gold, silver, platinum, copper, Brent and WTI crude, natural gas, wheat, corn, soybeans and coffee, plus USD/INR (CNBC quotes, with Yahoo Finance as fallback; sparklines show the last 24 hours). India gold (24K, per 10 g) and silver (per kg) are derived from the international price × USD/INR + India's import duty (15% since May 2026), shown ex-GST. Update `INDIA_DUTY` in `scripts/fetch-markets.mjs` if the rate changes.

## How it updates

A GitHub Actions workflow (`.github/workflows/feeds.yml`) runs every 15 minutes, on pushes to `main`, and on demand. It builds the site in `_site/` and publishes it straight to GitHub Pages; nothing is committed back to the repository.

1. `scripts/fetch-feeds.mjs` fetches every feed in `feeds.config.json`, keeps the last 72 hours of stories, and writes `data/feeds.json` for World and India.
2. `scripts/fetch-markets.mjs` writes `data/markets.json` for the commodity strip.
3. `scripts/fetch_dalal.py` fetches the Dalal Street feeds listed in the `FEEDS` array of `dalal-street/index.html` and writes `dalal-street/data/feeds.json`. This step can fail without stopping World and India from publishing.

Each page reads its own snapshot from the site. If a snapshot is missing, the page falls back to fetching feeds through free CORS proxies.

- **Add or remove a World or India outlet:** edit `feeds.config.json`. Set `"edition": "india"` to put an outlet under the India tab.
- **Add or remove a Dalal Street feed:** edit the `FEEDS` list in `dalal-street/index.html`.
- **Refresh now:** Actions → "Refresh feeds and deploy" → Run workflow.

## Dalal Street notes

- The **Stock picks** view collects brokerage and analyst calls reported in the news, with the rating, target and brokerage read automatically from each headline. Nothing here is investment advice; check the article before acting.
- NSE and BSE filing feeds only carry the current day's filings, so they are empty at weekends and overnight.
- Moneycontrol, Financial Express and Trading Economics sometimes refuse requests from GitHub's servers.

Headlines, summaries and links belong to their publishers.
