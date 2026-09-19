// _worker.js — FlightFrame's same-origin façade for the live-data relay (Cloudflare Pages
// "advanced mode"; sits next to index.html in the deploy dir; _routes.json keeps every
// non-/api/ path on the free static tier).
//
// The page asks its OWN origin for /api/frame?reg=; this fetches it from the relay — server.py
// as a Render free web service (no card; Deno's free tier wanted one) — and hands it back verbatim. Why a façade instead of the
// page calling deno.net directly (Sep 18 2026):
//   1. Home-network "safe browsing" filters block brand-new hostnames. Christian's
//      Xfinity line intercepted flightframe.polishcow31.deno.net on port 443 with a
//      plaintext redirect to safebrowse.io after the first request; the brother's line
//      may do the same. flightframe.pages.dev has been on the wall for months and passes.
//   2. Same origin = no CORS, no preflight.
// Cloudflare egress -> Render is fine. It's Cloudflare egress -> the ADS-B feeds that the
// feeds block (adsb.fi/adsb.one WAF 403, adsb.lol 429; measured), which is the whole
// reason the relay lives off Cloudflare. (relay/main.ts is the same contract for Deno.) Budget: Workers free plan = 100k requests/day; one
// wall at one /api/frame per 4 s ≈ 21.6k/day. Static asset hits are free and unlimited.

const RELAY = 'https://flightframe-relay.onrender.com';
const TIMEOUT_MS = 12000;
const UA = 'FlightFrame/1.2 facade (personal radar picture frame; +https://flightframe.pages.dev)';

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-ff-worker': '1', ...extra },
});

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    // Static site, untouched, plus a diagnostic stamp: if a static response ever carries
    // it, _routes.json stopped keeping the Worker out of static paths (quota leak).
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('x-ff-worker', 'passthrough');
    return out;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  if (url.pathname !== '/api/frame') return json({ error: 'no such route' }, 404);   // never the SPA page

  const reg = url.searchParams.get('reg') ?? '';
  try {
    const r = await fetchImpl(`${RELAY}/frame?reg=${encodeURIComponent(reg)}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    // The relay answers JSON for 200 and for its own 502 alike; anything else (an edge
    // error page, a filter interstitial) must not reach the page as "data".
    let shaped = false;
    try { const j = JSON.parse(text); shaped = !!j && (Array.isArray(j.rows) || typeof j.error === 'string'); } catch { /* not json */ }
    if (!shaped) return json({ error: `relay ${r.status} non-json`, cols: [], rows: [], fav: null }, 502, { 'x-ff-relay': String(r.status) });
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-ff-worker': '1', 'x-ff-relay': String(r.status) },
    });
  } catch (e) {
    return json({ error: 'relay unreachable: ' + ((e && e.name) || e), cols: [], rows: [], fav: null }, 502);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};
