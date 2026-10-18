// Fetches prices for widely traded commodities (front-month futures) and
// derives India gold and silver prices. Writes _site/data/markets.json.
// Primary source: CNBC's public quote service (one request for everything).
// Fallback: Yahoo Finance chart API with its cookie/crumb handshake.
// Sparklines come from our own history: one point per run, last 24 hours.
// Runs in GitHub Actions after fetch-feeds.mjs. Never fails the build.

import { writeFile, mkdir } from "node:fs/promises";

// India landed cost of bullion. Since the May 2026 hike: 10% basic customs
// duty + 5% AIDC = 15% duty, then 3% GST on the duty-inclusive value.
// Update these if the government changes the rates.
const INDIA_DUTY = 0.15;
const INDIA_GST = 0.03;
const TROY_OZ_G = 31.1034768;
const HISTORY_HOURS = 24;

const SITE_URL = process.env.SITE_URL || "";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const INSTRUMENTS = [
  { id: "gold",   name: "Gold",        unit: "USD/oz",    cnbc: "@GC.1",  yahoo: "GC=F",  group: "Metals" },
  { id: "silver", name: "Silver",      unit: "USD/oz",    cnbc: "@SI.1",  yahoo: "SI=F",  group: "Metals" },
  { id: "plat",   name: "Platinum",    unit: "USD/oz",    cnbc: "@PL.1",  yahoo: "PL=F",  group: "Metals" },
  { id: "copper", name: "Copper",      unit: "USD/lb",    cnbc: "@HG.1",  yahoo: "HG=F",  group: "Metals" },
  { id: "brent",  name: "Brent crude", unit: "USD/bbl",   cnbc: "@LCO.1", yahoo: "BZ=F",  group: "Energy" },
  { id: "wti",    name: "WTI crude",   unit: "USD/bbl",   cnbc: "@CL.1",  yahoo: "CL=F",  group: "Energy" },
  { id: "natgas", name: "Natural gas", unit: "USD/MMBtu", cnbc: "@NG.1",  yahoo: "NG=F",  group: "Energy" },
  { id: "wheat",  name: "Wheat",       unit: "USc/bu",    cnbc: "@W.1",   yahoo: "ZW=F",  group: "Agri" },
  { id: "corn",   name: "Corn",        unit: "USc/bu",    cnbc: "@C.1",   yahoo: "ZC=F",  group: "Agri" },
  { id: "soy",    name: "Soybeans",    unit: "USc/bu",    cnbc: "@S.1",   yahoo: "ZS=F",  group: "Agri" },
  { id: "coffee", name: "Coffee",      unit: "USc/lb",    cnbc: "@KC.1",  yahoo: "KC=F",  group: "Agri" },
  { id: "usdinr", name: "USD/INR",     unit: "INR",       cnbc: "INR=",   yahoo: "INR=X", group: "FX" }
];

async function get(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts, headers: { "User-Agent": UA, "Accept": "*/*", ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    throw new Error(`HTTP ${res.status}${body ? " " + body : ""}`);
  }
  return res;
}
const num = v => { const n = parseFloat(String(v ?? "").replace(/[,%+]/g, "")); return Number.isFinite(n) ? n : null; };

/* ---- CNBC: all symbols in one call ---- */
async function cnbcAll() {
  const syms = INSTRUMENTS.map(i => i.cnbc).join("|");
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(syms)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
  const j = await (await get(url)).json();
  const rows = j?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(rows)) throw new Error("Unexpected response");
  const out = {};
  for (const r of rows) {
    const inst = INSTRUMENTS.find(i => i.cnbc.toUpperCase() === String(r.symbol).toUpperCase());
    const price = num(r.last);
    if (!inst || price == null) continue;
    let prev = num(r.previous_day_closing);
    if (prev == null && num(r.change) != null) prev = price - num(r.change);
    const asOf = Date.parse(r.last_time) || Date.now();
    out[inst.id] = { price, prev, asOf, source: "CNBC" };
  }
  return out;
}

/* ---- Yahoo: cookie + crumb, then chart API per symbol ---- */
let yahooAuth;
async function yahooSession() {
  if (yahooAuth) return yahooAuth;
  const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15000) }).catch(() => null);
  const cookie = (r?.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("No Yahoo cookie");
  const crumb = await (await get("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { Cookie: cookie } })).text();
  return (yahooAuth = { cookie, crumb });
}
async function yahooOne(inst) {
  const { cookie, crumb } = await yahooSession();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?range=5d&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const j = await (await get(url, { headers: { Cookie: cookie } })).json();
  const r = j?.chart?.result?.[0];
  const price = r?.meta?.regularMarketPrice;
  if (price == null) throw new Error("No price");
  const lastT = (r.meta.regularMarketTime || 0) * 1000;
  const closes = (r.indicators?.quote?.[0]?.close || []).map((c, i) => [r.timestamp[i] * 1000, c]).filter(([t, c]) => c != null && t < lastT - 6 * 3600e3);
  return { price, prev: closes.at(-1)?.[1] ?? r.meta.chartPreviousClose ?? null, asOf: lastT || Date.now(), source: "Yahoo Finance" };
}

async function previousMarkets() {
  if (!SITE_URL) return {};
  try {
    const j = await (await get(new URL("data/markets.json", SITE_URL).href)).json();
    return Object.fromEntries((j.items || []).map(i => [i.id, i]));
  } catch { return {}; }
}

const errors = [];
const [cnbc, prev] = await Promise.all([cnbcAll().catch(e => { errors.push(`CNBC: ${e.message}`); return {}; }), previousMarkets()]);

const quotes = {};
for (const inst of INSTRUMENTS) {
  let q = cnbc[inst.id];
  if (!q) {
    try { q = await yahooOne(inst); } catch (e) { errors.push(`${inst.name} (Yahoo): ${e.message}`); }
  }
  quotes[inst.id] = q ? { ...inst, ...q } : prev[inst.id] ? { ...prev[inst.id], stale: true } : null;
}

// Append this run's price to each instrument's 24-hour history (the sparkline).
const now = Date.now();
function withHistory(item, prevItem) {
  const hist = (prevItem?.hist || []).filter(([t]) => t > now - HISTORY_HOURS * 3600e3);
  if (!item.stale) hist.push([now, item.price]);
  return { ...item, hist, spark: hist.map(([, v]) => v) };
}

const items = INSTRUMENTS.map(i => quotes[i.id] && withHistory(quotes[i.id], prev[i.id])).filter(Boolean);
const byId = Object.fromEntries(items.map(i => [i.id, i]));

// India gold (24K, per 10 g) and silver (per kg), in rupees, ex-GST; incl. GST in withGst.
function india(id, name, base, grams, unit) {
  const b = byId[base], fx = byId.usdinr;
  if (!b || !fx) return null;
  const conv = (usdOz, rate) => usdOz / TROY_OZ_G * grams * rate * (1 + INDIA_DUTY);
  const price = Math.round(conv(b.price, fx.price));
  const item = {
    id, name, unit, group: "India", currency: "INR", price,
    prev: b.prev && fx.prev ? Math.round(conv(b.prev, fx.prev)) : null,
    withGst: Math.round(price * (1 + INDIA_GST)),
    asOf: Math.min(b.asOf || now, fx.asOf || now),
    source: `Derived: ${b.name} × USD/INR + ${Math.round(INDIA_DUTY * 100)}% import duty`,
    stale: !!(b.stale || fx.stale)
  };
  return withHistory(item, prev[id]);
}
const all = [...items, india("in-gold", "India gold 24K", "gold", 10, "INR/10 g"), india("in-silver", "India silver", "silver", 1000, "INR/kg")]
  .filter(Boolean)
  .map(({ cnbc, yahoo, ...keep }) => keep);
const order = ["gold", "in-gold", "silver", "in-silver", "brent", "wti", "natgas", "copper", "plat", "wheat", "corn", "soy", "coffee", "usdinr"];
all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

await mkdir("_site/data", { recursive: true });
await writeFile("_site/data/markets.json", JSON.stringify({ generated: new Date().toISOString(), indiaDuty: INDIA_DUTY, indiaGst: INDIA_GST, items: all }));

const fresh = INSTRUMENTS.filter(i => quotes[i.id] && !quotes[i.id].stale);
const bySource = fresh.reduce((m, i) => (m[quotes[i.id].source] = (m[quotes[i.id].source] || 0) + 1, m), {});
const msg = `${fresh.length}/${INSTRUMENTS.length} prices fetched (${Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(", ") || "none"})`
  + (errors.length ? `\n${errors.slice(0, 8).join("\n")}` : "")
  + "\n" + all.map(i => `${i.name} ${i.price}${i.prev ? ` (prev ${i.prev})` : ""}${i.stale ? " stale" : ""}`).join(" | ");
console.log(msg);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Markets::${msg.replace(/%/g, "%25").replace(/\n/g, "%0A")}`);
