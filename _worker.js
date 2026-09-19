// _worker.js — FlightFrame's edge proxy (Cloudflare Pages "advanced mode").
//
// This file sits next to index.html in the deploy dir and answers every /api/* request;
// _routes.json keeps every other path (index.html, leaflet.*) on the free static path.
// It is server.py's /api/* contract, verbatim, at the edge — the page speaks ONE
// contract whether it runs on localhost (server.py) or on pages.dev (this).
//
// Why it exists (Sep 18 2026): airplanes.live took its free API down in mid-Aug 2026
// (403 "contact us" on every v2 endpoint; access is feeder-IP only now), and none of
// the free readsb aggregators (adsb.fi, adsb.lol, adsb.one) send CORS headers, so a
// browser can't call ANY live feed directly any more. Same-origin proxy = no CORS.
//
// Sources: adsb.fi  — primary. Free, no key, 1 req/s, personal use, attribution
//                     required (index.html's map attribution carries it).
//          adsb.lol — fallback. Same readsb JSON shape; lacks desc/ownOp.
// Budget:  Workers free plan = 100k requests/day, reset 00:00 UTC; past that the
//          Worker errors until reset. One wall at 2 polls per 4s = ~43k/day. Static
//          asset hits are free and unlimited (that's what _routes.json buys).
//
// VERDICT (Sep 18 2026, measured from the live edge on the `preview`/`diag` branches):
// NOT DEPLOYED. From Cloudflare Workers egress, adsb.fi and adsb.one answer a WAF
// block page (403, ~4ms, every header variant), adsb.lol answers 429 on the very
// first request (the shared egress IP is saturated by other people's Workers), and
// OpenSky times out. Only adsbdb and the adsb.lol CDN work. So the proxy runs on the
// frame's Pi instead (server.py + flightframe.service) and the page calls it at
// http://localhost:8001. This file is kept, tested (worker.test.mjs, 19 cases), and
// NOT in the deploy set. It also wouldn't be enough on its own any more: the frame now
// serves the page from its Pi (same origin as server.py) because Chrome's Local Network
// Access gate blocks an https page from reaching localhost. Keep for the record.

const MI = { lat: 42.36837, lon: -83.35271, radius: 155 };   // Livonia, 155nm — keep in step with index.html + server.py
const TIMEOUT_MS = 8000;                                      // same bound as the page's own fetches
const UA = 'FlightFrame/1.1 (personal radar picture frame; +https://flightframe.pages.dev)';

const enc = (s) => encodeURIComponent(s);

// live feeds: tried in order, first one that returns a real {"ac":[...]} wins
const LIVE = {
  planes: [
    { name: 'adsb.fi',  url: () => `https://opendata.adsb.fi/api/v3/lat/${MI.lat}/lon/${MI.lon}/dist/${MI.radius}` },
    { name: 'adsb.lol', url: () => `https://api.adsb.lol/v2/point/${MI.lat}/${MI.lon}/${MI.radius}` },
  ],
  fav: [
    { name: 'adsb.fi',  url: (reg) => `https://opendata.adsb.fi/api/v2/registration/${enc(reg)}` },
    { name: 'adsb.lol', url: (reg) => `https://api.adsb.lol/v2/reg/${enc(reg)}` },
  ],
};

// lookups: plain pass-throughs; a miss answers the same stub server.py answers, so the
// page never retries the origin itself
const LOOKUPS = {
  route:    { name: 'adsbdb',   url: (cs)  => `https://api.adsbdb.com/v0/callsign/${enc(cs)}`,  miss: '{"response":null}' },
  ac:       { name: 'adsbdb',   url: (reg) => `https://api.adsbdb.com/v0/aircraft/${enc(reg)}`, miss: '{"response":null}' },
  lolroute: { name: 'adsb.lol', url: (cs)  => `https://vrs-standing-data.adsb.lol/routes/${enc(cs.slice(0, 2))}/${enc(cs)}.json`, miss: '{"_airports":[]}' },
};

const reqInit = () => ({
  headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  signal: AbortSignal.timeout(TIMEOUT_MS),   // a hung upstream socket must not hang the wall
});

// Fetch one /api/<kind> answer. Returns {status, body, source}; body is the upstream
// text verbatim (no re-serialising), validated to be the JSON shape the page expects.
export async function upstream(kind, arg, fetchImpl = fetch) {
  const key = String(arg || '').trim().toUpperCase();

  if (kind in LIVE) {
    if (kind === 'fav' && !key) return { status: 200, body: '{"ac":[]}', source: 'none' };
    const errors = [];
    for (const s of LIVE[kind]) {
      try {
        const r = await fetchImpl(s.url(key), reqInit());
        const text = await r.text();
        if (!r.ok) { errors.push(`${s.name} ${r.status}`); continue; }
        let j;
        try { j = JSON.parse(text); } catch { errors.push(`${s.name} non-json`); continue; }
        if (!j || !Array.isArray(j.ac)) { errors.push(`${s.name} no ac[]`); continue; }   // 200-status error envelopes
        return { status: 200, body: text, source: s.name };
      } catch (e) { errors.push(`${s.name} ${(e && e.name) || e}`); }
    }
    // Both down: a 502 makes the page's tryProxy() return null -> _cycle keeps its last
    // frame and counts a miss; three misses dim the sky and say "signal lost".
    return { status: 502, body: JSON.stringify({ error: 'all live sources failed: ' + errors.join('; '), ac: [] }), source: 'none' };
  }

  const L = LOOKUPS[kind];
  if (!L) return { status: 404, body: '{"error":"no such route"}', source: 'none' };
  if (!key) return { status: 200, body: L.miss, source: 'none' };
  try {
    const r = await fetchImpl(L.url(key), reqInit());
    const text = await r.text();
    if (!r.ok) return { status: 200, body: L.miss, source: 'miss' };   // unknown callsign/reg -> 404 upstream
    JSON.parse(text);   // must be JSON — a block page must never reach the page as "data"
    return { status: 200, body: text, source: L.name };
  } catch {
    return { status: 200, body: L.miss, source: 'miss' };
  }
}

function json(body, status = 200, source) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-ff-worker': '1',            // diagnostic: present iff this Worker produced the response
  };
  if (source) headers['x-ff-source'] = source;
  return new Response(body, { status, headers });
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    // Static site, untouched — except a diagnostic stamp. In production _routes.json
    // should keep the Worker out of static paths entirely (free, unlimited): if a
    // static response ever carries this header, the Worker IS being invoked for it
    // and every tile of index.html/leaflet.js is eating the 100k/day budget.
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('x-ff-worker', 'passthrough');
    return out;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json('{"error":"method not allowed"}', 405);
  const kind = url.pathname.slice('/api/'.length);           // planes | fav | route | ac | lolroute
  if (!(kind in LIVE) && !(kind in LOOKUPS)) return json('{"error":"no such route"}', 404);   // never the SPA page
  const arg = url.searchParams.get('reg') ?? url.searchParams.get('cs') ?? '';
  const r = await upstream(kind, arg, fetchImpl);
  return json(r.body, r.status, r.source);
}

export default {
  fetch: (request, env) => handle(request, env),
};
