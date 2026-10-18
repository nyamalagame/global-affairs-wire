// Fetches prices for widely traded commodities (front-month futures) and
// derives India gold and silver prices. Writes _site/data/markets.json.
// Primary source: Yahoo Finance chart API. Fallback: Stooq CSV quotes.
// Runs in GitHub Actions after fetch-feeds.mjs. Never fails the build.

import { writeFile, mkdir } from "node:fs/promises";

// India landed cost of bullion. Since the May 2026 hike: 10% basic customs
// duty + 5% AIDC = 15% duty, then 3% GST on the duty-inclusive value.
// Update these if the government changes the rates.
const INDIA_DUTY = 0.15;
const INDIA_GST = 0.03;
const TROY_OZ_G = 31.1034768;

const SITE_URL = process.env.SITE_URL || "";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// group: shown as a label in the strip. yahoo / stooq: symbols for each source.
const INSTRUMENTS = [
  { id: "gold",   name: "Gold",        unit: "USD/oz",    yahoo: "GC=F", stooq: "gc.f", group: "Metals" },
  { id: "silver", name: "Silver",      unit: "USD/oz",    yahoo: "SI=F", stooq: "si.f", group: "Metals" },
  { id: "plat",   name: "Platinum",    unit: "USD/oz",    yahoo: "PL=F", stooq: "pl.f", group: "Metals" },
  { id: "copper", name: "Copper",      unit: "USD/lb",    yahoo: "HG=F", stooq: "hg.f", group: "Metals" },
  { id: "brent",  name: "Brent crude", unit: "USD/bbl",   yahoo: "BZ=F", stooq: "cb.f", group: "Energy" },
  { id: "wti",    name: "WTI crude",   unit: "USD/bbl",   yahoo: "CL=F", stooq: "cl.f", group: "Energy" },
  { id: "natgas", name: "Natural gas", unit: "USD/MMBtu", yahoo: "NG=F", stooq: "ng.f", group: "Energy" },
  { id: "wheat",  name: "Wheat",       unit: "USc/bu",    yahoo: "ZW=F", stooq: "zw.f", group: "Agri" },
  { id: "corn",   name: "Corn",        unit: "USc/bu",    yahoo: "ZC=F", stooq: "zc.f", group: "Agri" },
  { id: "soy",    name: "Soybeans",    unit: "USc/bu",    yahoo: "ZS=F", stooq: "zs.f", group: "Agri" },
  { id: "coffee", name: "Coffee",      unit: "USc/lb",    yahoo: "KC=F", stooq: "kc.f", group: "Agri" },
  { id: "usdinr", name: "USD/INR",     unit: "INR",       yahoo: "INR=X", stooq: "usdinr", group: "FX" }
];

async function get(url, ms = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
  const j = await (await get(url)).json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error("No data");
  const closes = (r.indicators?.quote?.[0]?.close || []).map((c, i) => [r.timestamp[i] * 1000, c]).filter(([, c]) => c != null);
  const price = r.meta.regularMarketPrice ?? closes.at(-1)?.[1];
  if (price == null) throw new Error("No price");
  // Previous session close: the last daily close before the latest session.
  const lastT = (r.meta.regularMarketTime || 0) * 1000;
  const prior = closes.filter(([t]) => t < lastT - 6 * 3600e3);
  const prev = prior.at(-1)?.[1] ?? r.meta.chartPreviousClose;
  return { price, prev, asOf: lastT || Date.now(), spark: closes.slice(-22).map(([, c]) => +c.toFixed(4)), source: "Yahoo Finance" };
}

async function fromStooq(sym) {
  const txt = await (await get(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcp&h&e=csv`)).text();
  const [head, row] = txt.trim().split(/\r?\n/);
  if (!row) throw new Error("No data");
  const h = head.toLowerCase().split(","), v = row.split(",");
  const val = k => parseFloat(v[h.indexOf(k)]);
  const price = val("close");
  if (!Number.isFinite(price)) throw new Error("No price");
  const prev = val("prev");
  const asOf = Date.parse(`${v[h.indexOf("date")]}T${v[h.indexOf("time")] || "00:00:00"}Z`) || Date.now();
  return { price, prev: Number.isFinite(prev) ? prev : null, asOf, spark: [], source: "Stooq" };
}

async function quote(inst) {
  for (const [fn, sym] of [[fromYahoo, inst.yahoo], [fromStooq, inst.stooq]]) {
    try { return { ...inst, ...(await fn(sym)), ok: true }; } catch (e) { inst.lastErr = String(e.message || e); }
  }
  return { ...inst, ok: false, err: inst.lastErr };
}

async function previousMarkets() {
  if (!SITE_URL) return {};
  try {
    const j = await (await get(new URL("data/markets.json", SITE_URL).href)).json();
    return Object.fromEntries((j.items || []).map(i => [i.id, i]));
  } catch { return {}; }
}

const [quotes, prev] = await Promise.all([Promise.all(INSTRUMENTS.map(quote)), previousMarkets()]);
const byId = Object.fromEntries(quotes.map(q => [q.id, q]));

// Keep the last good value for any instrument that failed this run.
const items = quotes.map(q => q.ok ? q : prev[q.id] ? { ...prev[q.id], stale: true } : null).filter(Boolean);

// India gold (24K, per 10 g) and silver (per kg), in rupees, ex-GST and incl. GST.
const fx = byId.usdinr?.ok ? byId.usdinr : prev.usdinr;
function india(id, name, base, grams, unit) {
  const b = byId[base]?.ok ? byId[base] : prev[base];
  if (!b || !fx) return null;
  const conv = (usdOz, rate) => usdOz / TROY_OZ_G * grams * rate * (1 + INDIA_DUTY);
  const price = conv(b.price, fx.price);
  const prevP = b.prev && fx.prev ? conv(b.prev, fx.prev) : null;
  return {
    id, name, unit, group: "India", currency: "INR",
    price: Math.round(price), prev: prevP ? Math.round(prevP) : null,
    withGst: Math.round(price * (1 + INDIA_GST)),
    asOf: Math.min(b.asOf, fx.asOf),
    spark: (b.spark || []).map(v => Math.round(conv(v, fx.price))), source: `Derived from ${b.name} × USD/INR + ${Math.round(INDIA_DUTY * 100)}% import duty`,
    ok: true
  };
}
const indiaItems = [india("in-gold", "India gold 24K", "gold", 10, "INR/10 g"), india("in-silver", "India silver", "silver", 1000, "INR/kg")].filter(Boolean);

const order = ["gold", "in-gold", "silver", "in-silver", "brent", "wti", "natgas", "copper", "plat", "wheat", "corn", "soy", "coffee", "usdinr"];
const all = [...items, ...indiaItems]
  .map(({ yahoo, stooq, lastErr, ok, err, ...keep }) => keep)
  .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

await mkdir("_site/data", { recursive: true });
await writeFile("_site/data/markets.json", JSON.stringify({ generated: new Date().toISOString(), indiaDuty: INDIA_DUTY, indiaGst: INDIA_GST, items: all }));

const failed = quotes.filter(q => !q.ok).map(q => `${q.name}: ${q.err}`);
const bySource = quotes.filter(q => q.ok).reduce((m, q) => (m[q.source] = (m[q.source] || 0) + 1, m), {});
const msg = `${quotes.length - failed.length}/${quotes.length} prices fetched (${Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(", ") || "none"})` + (failed.length ? `\nFailed:\n${failed.join("\n")}` : "");
console.log(msg);
for (const i of all) console.log(`  ${i.name.padEnd(16)} ${String(i.price).padStart(10)}  prev ${i.prev ?? "-"}${i.stale ? "  (stale)" : ""}`);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Markets::${msg.replace(/%/g, "%25").replace(/\n/g, "%0A")}`);
