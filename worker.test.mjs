#!/usr/bin/env node
// Unit tests for _worker.js (the Pages edge proxy). Pure-function tests with a fake
// fetch: no network, no Cloudflare. Run:  node worker.test.mjs   (exit code is the verdict)
//
// _worker.js is a Cloudflare module worker (ESM). Node treats a bare .js as CommonJS,
// so we import it through a .mjs copy in a temp dir.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ff-worker-'));
copyFileSync(join(here, '_worker.js'), join(dir, 'worker.mjs'));
const W = await import(pathToFileURL(join(dir, 'worker.mjs')).href);

// ---- fake fetch: a table of url-substring -> response spec, plus a call log ----
function fakeFetch(table) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    for (const [needle, spec] of table) {
      if (!url.includes(needle)) continue;
      if (spec.throw) throw new Error(spec.throw);
      const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
      return new Response(body, {
        status: spec.status ?? 200,
        headers: { 'content-type': spec.type ?? 'application/json' },
      });
    }
    throw new Error('fakeFetch: no rule for ' + url);
  };
  f.calls = calls;
  return f;
}
const PLANES_FI  = { ac: [{ hex: 'a1', lat: 42.1, lon: -83.2, flight: 'DAL1 ' }], now: 1, total: 1 };
const PLANES_LOL = { ac: [{ hex: 'b2', lat: 42.2, lon: -83.3, flight: 'SKW2 ' }], now: 2, total: 1 };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

console.log('_worker.js unit tests');

await test('planes: primary (adsb.fi v3) answers -> its body verbatim, source adsb.fi', async () => {
  const f = fakeFetch([['opendata.adsb.fi/api/v3/lat/42.36837/lon/-83.35271/dist/155', { body: PLANES_FI }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.status, 200);
  assert.equal(r.source, 'adsb.fi');
  assert.deepEqual(JSON.parse(r.body), PLANES_FI);
  assert.equal(f.calls.length, 1, 'no fallback call when primary is healthy');
});

await test('planes: primary 429 -> adsb.lol fallback body', async () => {
  const f = fakeFetch([
    ['adsb.fi', { status: 429, body: { detail: 'rate limited' } }],
    ['api.adsb.lol/v2/point/42.36837/-83.35271/155', { body: PLANES_LOL }],
  ]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.status, 200);
  assert.equal(r.source, 'adsb.lol');
  assert.deepEqual(JSON.parse(r.body), PLANES_LOL);
  assert.equal(f.calls.length, 2);
});

await test('planes: primary throws (timeout) -> fallback', async () => {
  const f = fakeFetch([['adsb.fi', { throw: 'TimeoutError' }], ['adsb.lol', { body: PLANES_LOL }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.source, 'adsb.lol');
});

await test('planes: primary 200 but no ac array (error envelope) -> fallback', async () => {
  const f = fakeFetch([['adsb.fi', { body: { error: 'nope' } }], ['adsb.lol', { body: PLANES_LOL }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.source, 'adsb.lol');
});

await test('planes: primary 200 but HTML (a block page) -> fallback', async () => {
  const f = fakeFetch([['adsb.fi', { body: '<html>Attention Required</html>', type: 'text/html' }], ['adsb.lol', { body: PLANES_LOL }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.source, 'adsb.lol');
});

await test('planes: primary non-OK even WITH an ac:[] body (503 overloaded) -> fallback', async () => {
  const f = fakeFetch([['adsb.fi', { status: 503, body: { ac: [], msg: 'overloaded' } }], ['adsb.lol', { body: PLANES_LOL }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.source, 'adsb.lol');
});

await test('planes: both sources fail -> 502 with an ac:[] envelope (page keeps its last frame)', async () => {
  const f = fakeFetch([['adsb.fi', { status: 503, body: 'down', type: 'text/plain' }], ['adsb.lol', { throw: 'ECONNRESET' }]]);
  const r = await W.upstream('planes', '', f);
  assert.equal(r.status, 502);
  const j = JSON.parse(r.body);
  assert.deepEqual(j.ac, []);
  assert.ok(typeof j.error === 'string' && j.error.length);
});

await test('every upstream fetch carries an AbortSignal (bounded, no hung sockets) and a UA', async () => {
  const f = fakeFetch([['adsb.fi', { body: PLANES_FI }]]);
  await W.upstream('planes', '', f);
  const { init } = f.calls[0];
  assert.ok(init && init.signal instanceof AbortSignal, 'signal missing');
  assert.match(init.headers['User-Agent'], /FlightFrame/);
});

await test('fav: registration is upper-cased and URL-encoded into both sources', async () => {
  const f = fakeFetch([
    ['opendata.adsb.fi/api/v2/registration/N527DN', { status: 500, body: 'x', type: 'text/plain' }],
    ['api.adsb.lol/v2/reg/N527DN', { body: { ac: [{ hex: 'c3', lat: 1, lon: 2 }] } }],
  ]);
  const r = await W.upstream('fav', 'n527dn', f);
  assert.equal(r.source, 'adsb.lol');
  assert.equal(JSON.parse(r.body).ac[0].hex, 'c3');
  const f2 = fakeFetch([['registration/N%2F1', { body: { ac: [] } }]]);
  await W.upstream('fav', 'n/1', f2);
  assert.ok(f2.calls[0].url.endsWith('/registration/N%2F1'));
});

await test('fav: empty registration -> {ac:[]} with no upstream call', async () => {
  const f = fakeFetch([]);
  const r = await W.upstream('fav', '', f);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ac: [] });
  assert.equal(f.calls.length, 0);
});

await test('route: adsbdb pass-through; unknown callsign (404) -> {response:null}', async () => {
  const good = { response: { flightroute: { callsign: 'DAL2591' } } };
  const f = fakeFetch([['api.adsbdb.com/v0/callsign/DAL2591', { body: good }]]);
  const r = await W.upstream('route', 'dal2591', f);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), good);
  const f2 = fakeFetch([['adsbdb.com', { status: 404, body: { response: 'unknown callsign' } }]]);
  const r2 = await W.upstream('route', 'ZZZ9', f2);
  assert.equal(r2.status, 200);
  assert.deepEqual(JSON.parse(r2.body), { response: null });
});

await test('ac: adsbdb aircraft pass-through; failure -> {response:null}', async () => {
  const f = fakeFetch([['api.adsbdb.com/v0/aircraft/N527DN', { throw: 'boom' }]]);
  const r = await W.upstream('ac', 'N527DN', f);
  assert.deepEqual(JSON.parse(r.body), { response: null });
});

await test('lolroute: CDN path is /routes/<first2>/<callsign>.json; miss -> {_airports:[]}', async () => {
  const good = { _airports: [{ icao: 'KDTW' }, { icao: 'RKSI' }] };
  const f = fakeFetch([['vrs-standing-data.adsb.lol/routes/DA/DAL2591.json', { body: good }]]);
  const r = await W.upstream('lolroute', 'dal2591', f);
  assert.deepEqual(JSON.parse(r.body), good);
  const f2 = fakeFetch([['adsb.lol', { status: 404, body: 'nf', type: 'text/plain' }]]);
  const r2 = await W.upstream('lolroute', 'ZZZ9', f2);
  assert.deepEqual(JSON.parse(r2.body), { _airports: [] });
});

// ---- the HTTP handler: routing, headers, static fallthrough ----
function fakeEnv() {
  const asked = [];
  return { asked, ASSETS: { fetch: async (req) => { asked.push(new URL(req.url).pathname); return new Response('<html>static</html>', { headers: { 'content-type': 'text/html' } }); } } };
}
await test('handler: /api/planes -> JSON, no-store, x-ff-worker header, x-ff-source', async () => {
  const env = fakeEnv();
  const f = fakeFetch([['adsb.fi', { body: PLANES_FI }]]);
  const res = await W.handle(new Request('https://flightframe.pages.dev/api/planes'), env, f);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-ff-worker'), '1');
  assert.equal(res.headers.get('x-ff-source'), 'adsb.fi');
  assert.deepEqual(await res.json(), PLANES_FI);
  assert.equal(env.asked.length, 0);
});

await test('handler: /api/fav?reg= reads the query string', async () => {
  const env = fakeEnv();
  const f = fakeFetch([['registration/N527DN', { body: { ac: [{ hex: 'c3' }] } }]]);
  const res = await W.handle(new Request('https://flightframe.pages.dev/api/fav?reg=n527dn'), env, f);
  assert.equal((await res.json()).ac[0].hex, 'c3');
});

await test('handler: unknown /api/* -> 404 JSON (never the SPA page)', async () => {
  const env = fakeEnv();
  const res = await W.handle(new Request('https://flightframe.pages.dev/api/version'), env, fakeFetch([]));
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(env.asked.length, 0);
});

await test('handler: non-API paths fall through to static assets untouched', async () => {
  const env = fakeEnv();
  for (const p of ['/', '/index.html', '/leaflet.js', '/robots.txt', '/apiary']) {
    const res = await W.handle(new Request('https://flightframe.pages.dev' + p), env, fakeFetch([]));
    assert.equal(await res.text(), '<html>static</html>', p);
    assert.equal(res.headers.get('x-ff-worker'), 'passthrough', p + ' stamp');
  }
  assert.deepEqual(env.asked, ['/', '/index.html', '/leaflet.js', '/robots.txt', '/apiary']);
});

await test('handler: only GET/HEAD on /api/* (POST -> 405)', async () => {
  const env = fakeEnv();
  const res = await W.handle(new Request('https://flightframe.pages.dev/api/planes', { method: 'POST' }), env, fakeFetch([]));
  assert.equal(res.status, 405);
});

await test('default export wires handle() with the real fetch', async () => {
  assert.equal(typeof W.default.fetch, 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
