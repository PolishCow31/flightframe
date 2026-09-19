// relay/main.ts — FlightFrame's live-data relay, hosted on Deno Deploy (free tier).
//
// Why it exists (Sep 18 2026): no free ADS-B feed will answer a browser (no CORS), the
// same feeds block Cloudflare Workers egress (adsb.fi/adsb.one: WAF 403; adsb.lol: 429),
// and Chrome's Local Network Access gate stops the hosted page from reaching a proxy on
// the frame's own Pi. They DO answer ordinary cloud egress (verified via fetch services
// on other clouds), so this small relay on Deno Deploy fetches the planes and hands them
// to https://flightframe.pages.dev with a CORS header. The frame keeps loading the same
// URL; nobody touches the Pi.
//
// Contract:  GET /frame?reg=N527DN
//   -> { now, source, stale, cols: [...], rows: [[...], ...], fav: {readsb aircraft}|null }
//   rows are positional (cols gives the order) to keep egress inside Deno's free 20 GiB/mo:
//   ~300 aircraft × 4 s polling ≈ 650k requests/mo, so bytes per response matter.
// Sources: adsb.fi v3 (primary; free, no key, 1 req/s, attribution required — the page's
//          map footer carries it) → adsb.lol (fallback, same readsb shape).
// Cache:   3.5 s per key (below the page's 4 s poll), concurrent callers collapse onto one
//          upstream fetch, stale-if-error keeps the last good answer when both feeds fail.

const MI = { lat: 42.36837, lon: -83.35271, radius: 155 }; // Livonia, 155 nm — keep in step with index.html / server.py
const TTL_MS = 3500;
const TIMEOUT_MS = 8000;
const UA = "FlightFrame/1.2 relay (personal radar picture frame; +https://flightframe.pages.dev; contact: polishcow31 on GitHub)";

// the fields index.html actually reads from an aircraft (see render/detailHTML); order = wire order
export const COLS = [
  "hex", "flight", "r", "t", "lat", "lon", "alt_baro", "gs", "track",
  "seen_pos", "category", "baro_rate", "desc", "ownOp",
] as const;

type Ac = Record<string, unknown>;
type Kind = "planes" | "fav";
export type Live = { ac: Ac[] | null; source: string; stale?: boolean; error?: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const enc = encodeURIComponent;
const LIVE: Record<Kind, { name: string; url: (key: string) => string }[]> = {
  planes: [
    { name: "adsb.fi", url: () => `https://opendata.adsb.fi/api/v3/lat/${MI.lat}/lon/${MI.lon}/dist/${MI.radius}` },
    { name: "adsb.lol", url: () => `https://api.adsb.lol/v2/point/${MI.lat}/${MI.lon}/${MI.radius}` },
  ],
  fav: [
    { name: "adsb.fi", url: (reg) => `https://opendata.adsb.fi/api/v2/registration/${enc(reg)}` },
    { name: "adsb.lol", url: (reg) => `https://api.adsb.lol/v2/reg/${enc(reg)}` },
  ],
};

// One upstream answer: first source that returns a real {"ac":[...]} wins.
export async function upstream(kind: Kind, arg: string, fetchImpl: FetchLike = fetch): Promise<Live> {
  const key = (arg ?? "").trim().toUpperCase();
  if (kind === "fav" && !key) return { ac: [], source: "none" };
  const errors: string[] = [];
  for (const s of LIVE[kind]) {
    try {
      const r = await fetchImpl(s.url(key), {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await r.text();
      if (!r.ok) { errors.push(`${s.name} ${r.status}`); continue; }
      let j: { ac?: unknown };
      try { j = JSON.parse(text); } catch { errors.push(`${s.name} non-json`); continue; }
      if (!j || !Array.isArray(j.ac)) { errors.push(`${s.name} no ac[]`); continue; } // 200-status error envelopes
      return { ac: j.ac as Ac[], source: s.name };
    } catch (e) {
      errors.push(`${s.name} ${(e as Error)?.name ?? String(e)}`);
    }
  }
  return { ac: null, source: "none", error: errors.join("; ") };
}

export function compact(ac: Ac[]): unknown[][] {
  return ac.map((a) => COLS.map((c) => (a[c] === undefined ? null : a[c])));
}

// ---- cache: per key, TTL from request START, collapsed concurrency, stale-if-error ----
type Entry = { at: number; last?: Live; inflight?: Promise<Live> };
const entries = new Map<string, Entry>();
export function resetCache() { entries.clear(); }

export async function getLive(kind: Kind, arg: string, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<Live> {
  const key = (arg ?? "").trim().toUpperCase();
  const k = `${kind}:${key}`;
  let e = entries.get(k);
  if (!e) { e = { at: 0 }; entries.set(k, e); }
  if (e.last && now - e.at < TTL_MS) return { ...e.last, stale: false };
  if (!e.inflight) {
    const started = now;
    const entry = e;
    e.inflight = upstream(kind, key, fetchImpl)
      .then((r) => { if (r.ac) { entry.last = r; entry.at = started; } return r; })
      .finally(() => { entry.inflight = undefined; });
  }
  const r = await e.inflight;
  if (r.ac) return { ...r, stale: false };
  if (e.last) return { ...e.last, stale: true, error: r.error }; // yesterday's answer beats a blank frame
  return r;
}

const cors = (h: Record<string, string> = {}): Record<string, string> => ({
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  ...h,
});
// gzip ourselves when the caller accepts it: ~31 KB -> ~11 KB per answer, which is the
// difference between brushing Deno's free 20 GiB/mo egress cap and using a third of it.
function json(body: unknown, status = 200, req?: Request): Response {
  const text = JSON.stringify(body);
  const headers = cors({ "content-type": "application/json; charset=utf-8", "vary": "accept-encoding" });
  if (req?.headers.get("accept-encoding")?.includes("gzip")) {
    headers["content-encoding"] = "gzip";
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream, { status, headers });
  }
  return new Response(text, { status, headers });
}

export async function handle(req: Request, fetchImpl: FetchLike = fetch): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors({ "access-control-allow-methods": "GET", "access-control-allow-headers": "*", "access-control-max-age": "86400" }),
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, req);
  if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "flightframe-relay", cols: COLS }, 200, req);
  if (url.pathname === "/frame") {
    const reg = url.searchParams.get("reg") ?? "";
    const [p, f] = await Promise.all([
      getLive("planes", "", fetchImpl),
      reg ? getLive("fav", reg, fetchImpl) : Promise.resolve<Live>({ ac: [], source: "none" }),
    ]);
    if (!p.ac) return json({ error: "all live sources failed: " + p.error, cols: COLS, rows: [], fav: null }, 502, req);
    return json({
      now: Date.now(),
      source: p.source,
      stale: !!p.stale,
      cols: COLS,
      rows: compact(p.ac),
      fav: f.ac && f.ac[0] ? f.ac[0] : null,
      favSource: f.source,
    }, 200, req);
  }
  return json({ error: "no such route" }, 404, req);
}

if (import.meta.main) {
  Deno.serve((req) => handle(req));
}
