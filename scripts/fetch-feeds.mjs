// Collects every feed in feeds.config.json and builds the site into _site/
// with a fresh data/feeds.json snapshot. Runs in GitHub Actions on Node 20+.
// No dependencies: feeds are fetched server-side, so no CORS proxy is needed.

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const KEEP_HOURS = 72;      // how long a story stays in the snapshot
const MAX_ITEMS = 1500;     // hard cap on snapshot size
const TIMEOUT_MS = 20000;
const SITE_URL = process.env.SITE_URL || "";

const feeds = JSON.parse(await readFile("feeds.config.json", "utf8"));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const unCdata = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
// Decode first so escaped HTML (&lt;p&gt;) becomes tags, then strip the tags.
const clean = s => decode(decode(unCdata(s || ""))).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function pick(block, ...tags) {
  for (const t of tags) {
    const m = block.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return "";
}

export function parseFeed(xml, feedId) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    let link = clean(pick(b, "link"));
    if (!link) {
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? decode(alt[1]) : clean(pick(b, "guid"));
    }
    const title = clean(pick(b, "title"));
    let summary = clean(pick(b, "description", "summary", "content:encoded", "content"));
    if (summary.toLowerCase().startsWith(title.toLowerCase())) summary = summary.slice(title.length).trim();
    if (summary.length > 240) summary = summary.slice(0, 237).replace(/\s+\S*$/, "") + "…";
    const t = Date.parse(clean(pick(b, "pubDate", "dc:date", "published", "updated", "date")));
    return { feed: feedId, title, link, summary, ts: Number.isFinite(t) ? Math.min(t, Date.now()) : 0 };
  }).filter(i => i.title && /^https?:\/\//.test(i.link));
}

async function fetchFeed(f) {
  const start = Date.now();
  try {
    const res = await fetch(f.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GlobalAffairsWire/1.0; +https://github.com/)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text(), f.id);
    if (!items.length) throw new Error("No stories found in feed");
    const ms = Date.now() - start;
    return { meta: { ...f, status: ms > 10000 ? "slow" : "ok", ms, count: items.length }, items };
  } catch (e) {
    return { meta: { ...f, status: "fail", ms: Date.now() - start, count: 0, err: String(e.message || e) }, items: [] };
  }
}

async function previousItems() {
  if (!SITE_URL) return [];
  try {
    const res = await fetch(new URL("data/feeds.json", SITE_URL), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

const [results, previous] = await Promise.all([Promise.all(feeds.map(fetchFeed)), previousItems()]);

// Fresh items win; older stories from the last snapshot are kept so a feed
// that fails temporarily doesn't empty the page.
const cutoff = Date.now() - KEEP_HOURS * 3600e3;
const byLink = new Map();
for (const i of results.flatMap(r => r.items)) if (!byLink.has(i.link)) byLink.set(i.link, i);
for (const i of previous) if (i.link && !byLink.has(i.link) && feeds.some(f => f.id === i.feed)) byLink.set(i.link, i);
const items = [...byLink.values()]
  .filter(i => !i.ts || i.ts >= cutoff)
  .sort((a, b) => b.ts - a.ts)
  .slice(0, MAX_ITEMS);

const snapshot = { generated: new Date().toISOString(), feeds: results.map(r => r.meta), items };

await mkdir("_site/data", { recursive: true });
await writeFile("_site/data/feeds.json", JSON.stringify(snapshot));
for (const f of ["index.html", "README.md"]) await copyFile(f, `_site/${f}`).catch(() => {});
await writeFile("_site/.nojekyll", "");

const live = results.filter(r => r.meta.status !== "fail").length;
console.log(`Snapshot: ${items.length} stories, ${live}/${feeds.length} feeds live (${previous.length} carried from previous snapshot)`);
for (const r of results) console.log(`  ${r.meta.status.padEnd(4)} ${r.meta.name.padEnd(18)} ${String(r.meta.count).padStart(3)} items  ${r.meta.ms} ms${r.meta.err ? "  " + r.meta.err : ""}`);
