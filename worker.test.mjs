#!/usr/bin/env node
// Unit tests for _worker.js (the Pages façade in front of the Deno relay). Fake fetch, no
// network, no Cloudflare. Run:  node worker.test.mjs   (exit code is the verdict)
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ff-worker-'));
copyFileSync(join(here, '_worker.js'), join(dir, 'worker.mjs'));
const W = await import(pathToFileURL(join(dir, 'worker.mjs')).href);

function fakeFetch(spec) {   // one rule for the relay; records the call
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (spec.throw) { const e = new Error(spec.throw); e.name = spec.throw; throw e; }
    const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return new Response(body, { status: spec.status ?? 200, headers: { 'content-type': spec.type ?? 'application/json' } });
  };
  f.calls = calls;
  return f;
}
function fakeEnv() {
  const asked = [];
  return { asked, ASSETS: { fetch: async (req) => { asked.push(new URL(req.url).pathname); return new Response('<html>static</html>', { headers: { 'content-type': 'text/html' } }); } } };
}
const FRAME = { now: 1, source: 'adsb.fi', stale: false, cols: ['hex', 'lat', 'lon'], rows: [['a1', 42.1, -83.2]], fav: null, favSource: 'none' };
const req = (path, init) => new Request('https://flightframe.pages.dev' + path, init);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
console.log('_worker.js unit tests');

await test('/api/frame: forwards reg (encoded) to the relay and returns its JSON verbatim', async () => {
  const f = fakeFetch({ body: FRAME });
  const res = await W.handle(req('/api/frame?reg=n/1'), fakeEnv(), f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://flightframe.polishcow31.deno.net/frame?reg=n%2F1');
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-ff-worker'), '1');
  assert.equal(res.headers.get('x-ff-relay'), '200');
  assert.deepEqual(await res.json(), FRAME);
});

await test('/api/frame without reg: relay asked with an empty reg', async () => {
  const f = fakeFetch({ body: FRAME });
  await W.handle(req('/api/frame'), fakeEnv(), f);
  assert.equal(f.calls[0].url, 'https://flightframe.polishcow31.deno.net/frame?reg=');
});

await test("relay's own 502 JSON (both feeds down) passes through as 502 JSON", async () => {
  const f = fakeFetch({ status: 502, body: { error: 'all live sources failed: adsb.fi 403; adsb.lol 429', cols: [], rows: [], fav: null } });
  const res = await W.handle(req('/api/frame?reg=N527DN'), fakeEnv(), f);
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.match(j.error, /all live sources failed/);
  assert.deepEqual(j.rows, []);
});

await test('edge error page / filter interstitial (HTML) -> 502 envelope, never "data"', async () => {
  for (const spec of [{ status: 200, body: '<html>warn</html>', type: 'text/html' }, { status: 503, body: 'upstream error', type: 'text/plain' }, { status: 200, body: { ok: true } }]) {
    const res = await W.handle(req('/api/frame?reg=N527DN'), fakeEnv(), fakeFetch(spec));
    assert.equal(res.status, 502, JSON.stringify(spec));
    const j = await res.json();
    assert.match(j.error, /relay \d+ non-json/);
    assert.deepEqual(j.rows, []);
  }
});

await test('relay unreachable (timeout / network) -> 502 envelope with the reason', async () => {
  const res = await W.handle(req('/api/frame?reg=N527DN'), fakeEnv(), fakeFetch({ throw: 'TimeoutError' }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /relay unreachable: TimeoutError/);
});

await test('unknown /api/* -> 404 JSON (never the SPA page); POST -> 405', async () => {
  const env = fakeEnv();
  const res = await W.handle(req('/api/planes'), env, fakeFetch({ body: FRAME }));
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(env.asked.length, 0);
  const p = await W.handle(req('/api/frame', { method: 'POST' }), env, fakeFetch({ body: FRAME }));
  assert.equal(p.status, 405);
});

await test('non-API paths fall through to static assets with the passthrough stamp', async () => {
  const env = fakeEnv();
  for (const p of ['/', '/index.html', '/leaflet.js', '/apiary']) {
    const res = await W.handle(req(p), env, fakeFetch({ body: FRAME }));
    assert.equal(await res.text(), '<html>static</html>', p);
    assert.equal(res.headers.get('x-ff-worker'), 'passthrough', p);
  }
  assert.deepEqual(env.asked, ['/', '/index.html', '/leaflet.js', '/apiary']);
});

await test('default export wires handle()', async () => {
  assert.equal(typeof W.default.fetch, 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
