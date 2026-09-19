// Unit tests for relay/main.ts — fake fetch, no network. Run: deno test relay/
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { COLS, compact, getLive, handle, resetCache, upstream } from "./main.ts";

type Spec = { status?: number; body?: unknown; type?: string; throw?: string };
function fakeFetch(table: [string, Spec][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const [needle, spec] of table) {
      if (!url.includes(needle)) continue;
      if (spec.throw) throw new Error(spec.throw);
      const body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
      return new Response(body, { status: spec.status ?? 200, headers: { "content-type": spec.type ?? "application/json" } });
    }
    throw new Error("fakeFetch: no rule for " + url);
  };
  f.calls = calls;
  return f;
}
const A1 = { hex: "a1", flight: "DAL1 ", r: "N1", t: "A321", lat: 42.1, lon: -83.2, alt_baro: 30000, gs: 450, track: 90, seen_pos: 0.2, category: "A3", baro_rate: 0, desc: "AIRBUS A-321", ownOp: "DELTA", messages: 999, rssi: -9 };
const A2 = { hex: "b2", flight: "SKW2 ", r: "N2", t: "CRJ7", lat: 42.2, lon: -83.3, alt_baro: "ground", gs: 0, track: 10, seen_pos: 1 };
const FI = { ac: [A1, A2], now: 1, total: 2 };
const LOL = { ac: [A2], now: 2, total: 1 };

Deno.test("planes: primary adsb.fi v3 answers -> its aircraft, one call", async () => {
  const f = fakeFetch([["opendata.adsb.fi/api/v3/lat/42.36837/lon/-83.35271/dist/155", { body: FI }]]);
  const r = await upstream("planes", "", f);
  assertEquals(r.source, "adsb.fi"); assertEquals(r.ac?.length, 2); assertEquals(f.calls.length, 1);
});
Deno.test("planes: 429 / non-json / no ac[] / non-OK-with-ac:[] / throw -> adsb.lol fallback", async () => {
  for (const spec of [{ status: 429, body: { detail: "rate limited" } }, { body: "<html>block</html>", type: "text/html" }, { body: { error: "x" } }, { status: 503, body: { ac: [] } }, { throw: "TimeoutError" }] as Spec[]) {
    const f = fakeFetch([["adsb.fi", spec], ["api.adsb.lol/v2/point/42.36837/-83.35271/155", { body: LOL }]]);
    const r = await upstream("planes", "", f);
    assertEquals(r.source, "adsb.lol", JSON.stringify(spec)); assertEquals(r.ac?.length, 1);
  }
});
Deno.test("planes: both down -> ac null with an error string", async () => {
  const f = fakeFetch([["adsb.fi", { status: 503, body: "down", type: "text/plain" }], ["adsb.lol", { throw: "ECONNRESET" }]]);
  const r = await upstream("planes", "", f);
  assertEquals(r.ac, null); assertMatch(r.error ?? "", /adsb\.fi 503; adsb\.lol/);
});
Deno.test("every upstream call carries the UA and an AbortSignal", async () => {
  const f = fakeFetch([["adsb.fi", { body: FI }]]);
  await upstream("planes", "", f);
  const init = f.calls[0].init!;
  assertMatch((init.headers as Record<string, string>)["User-Agent"], /FlightFrame/);
  assert(init.signal instanceof AbortSignal);
});
Deno.test("fav: upper-cased + encoded reg; empty reg -> [] with no call", async () => {
  const f = fakeFetch([["registration/N527DN", { body: { ac: [A1] } }]]);
  const r = await upstream("fav", "n527dn", f);
  assertEquals(r.ac?.[0].hex, "a1"); assert(f.calls[0].url.endsWith("/registration/N527DN"));
  const f2 = fakeFetch([]);
  const r2 = await upstream("fav", "  ", f2);
  assertEquals(r2.ac, []); assertEquals(f2.calls.length, 0);
});
Deno.test("compact: positional rows in COLS order, missing -> null, extras dropped", () => {
  const rows = compact([A1, A2]);
  assertEquals(rows[0].length, COLS.length);
  assertEquals(rows[0][COLS.indexOf("hex")], "a1"); assertEquals(rows[0][COLS.indexOf("ownOp")], "DELTA");
  assertEquals(rows[1][COLS.indexOf("desc")], null); assertEquals(rows[1][COLS.indexOf("alt_baro")], "ground");
  assert(!rows[0].includes(999), "extra fields must not leak");
});
Deno.test("cache: second call inside 3.5s is served without an upstream hit; after TTL it refetches", async () => {
  resetCache();
  const f = fakeFetch([["adsb.fi", { body: FI }]]);
  await getLive("planes", "", f, 1000); await getLive("planes", "", f, 2000);
  assertEquals(f.calls.length, 1);
  await getLive("planes", "", f, 4600);
  assertEquals(f.calls.length, 2);
});
Deno.test("cache: concurrent callers collapse onto one upstream fetch", async () => {
  resetCache();
  const f = fakeFetch([["adsb.fi", { body: FI }]]);
  await Promise.all([getLive("planes", "", f, 10), getLive("planes", "", f, 10), getLive("planes", "", f, 10)]);
  assertEquals(f.calls.length, 1);
});
Deno.test("cache: stale-if-error keeps the last good answer and flags it", async () => {
  resetCache();
  const good = fakeFetch([["adsb.fi", { body: FI }]]);
  await getLive("planes", "", good, 0);
  const bad = fakeFetch([["adsb.fi", { status: 503, body: "x", type: "text/plain" }], ["adsb.lol", { throw: "boom" }]]);
  const r = await getLive("planes", "", bad, 10_000);
  assertEquals(r.stale, true); assertEquals(r.ac?.length, 2); assertMatch(r.error ?? "", /adsb\.lol boom|adsb\.lol Error/);
});
Deno.test("handler: /frame returns cols/rows/fav with CORS + no-store", async () => {
  resetCache();
  const f = fakeFetch([["dist/155", { body: FI }], ["registration/N527DN", { body: { ac: [A2] } }]]);
  const res = await handle(new Request("https://relay.example/frame?reg=n527dn"), f);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("cache-control"), "no-store");
  const j = await res.json();
  assertEquals(j.cols, [...COLS]); assertEquals(j.rows.length, 2); assertEquals(j.fav.hex, "b2"); assertEquals(j.source, "adsb.fi"); assertEquals(j.stale, false);
});
Deno.test("handler: /frame without reg -> fav null, no registration call", async () => {
  resetCache();
  const f = fakeFetch([["dist/155", { body: FI }]]);
  const j = await (await handle(new Request("https://relay.example/frame"), f)).json();
  assertEquals(j.fav, null); assertEquals(f.calls.length, 1);
});
Deno.test("handler: both feeds down -> 502 with rows [] (page keeps its last frame)", async () => {
  resetCache();
  const f = fakeFetch([["adsb.fi", { status: 503, body: "x", type: "text/plain" }], ["adsb.lol", { status: 429, body: "x", type: "text/html" }]]);
  const res = await handle(new Request("https://relay.example/frame?reg=N527DN"), f);
  assertEquals(res.status, 502); const j = await res.json(); assertEquals(j.rows, []); assertMatch(j.error, /adsb\.fi 503/);
});
Deno.test("handler: OPTIONS preflight 204 with CORS; unknown route 404; POST 405; /health ok", async () => {
  const f = fakeFetch([]);
  const o = await handle(new Request("https://relay.example/frame", { method: "OPTIONS" }), f);
  assertEquals(o.status, 204); assertEquals(o.headers.get("access-control-allow-origin"), "*");
  assertEquals((await handle(new Request("https://relay.example/nope"), f)).status, 404);
  assertEquals((await handle(new Request("https://relay.example/frame", { method: "POST" }), f)).status, 405);
  const h = await (await handle(new Request("https://relay.example/health"), f)).json();
  assertEquals(h.ok, true);
});

Deno.test("gzip: with accept-encoding gzip the body is gzipped and round-trips; without it, plain", async () => {
  resetCache();
  const f = fakeFetch([["dist/155", { body: FI }]]);
  const gz = await handle(new Request("https://relay.example/frame", { headers: { "accept-encoding": "gzip, br" } }), f);
  assertEquals(gz.headers.get("content-encoding"), "gzip");
  assertEquals(gz.headers.get("vary"), "accept-encoding");
  const raw = await new Response(gz.body!.pipeThrough(new DecompressionStream("gzip"))).text();
  const j = JSON.parse(raw); assertEquals(j.rows.length, 2); assertEquals(j.cols, [...COLS]);
  const plain = await handle(new Request("https://relay.example/frame"), f);
  assertEquals(plain.headers.get("content-encoding"), null);
  assertEquals((await plain.json()).rows.length, 2);
});
