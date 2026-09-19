#!/usr/bin/env python3
"""
FlightFrame — a wall-mounted Michigan flight-radar frame that spotlights one plane.

Stdlib only (no pip installs). It does two jobs:
  1. Serves index.html (the frame UI).
  2. Proxies the live ADS-B feed (adsb.fi, adsb.lol as fallback), so the browser
     never talks to a feed directly. That kills CORS headaches AND lets us cache
     responses server-side to stay under adsb.fi's 1-request/second limit, no
     matter how many times the frame refreshes.

ON THE FRAME (Sep 18 2026): this runs on the Pi itself and the kiosk points at
http://localhost:8001/ — page AND proxy on one origin. No free feed is callable from a
browser any more, the aggregators block Cloudflare Workers egress (see _worker.js),
and Chrome's Local Network Access gate stops an https page from reaching localhost.
  3. Mirrors the site (index.html, leaflet.*, robots.txt) from SITE_URL into ./site/
     at start and every UPDATE_EVERY seconds, atomically, keeping the last good copy.
     So "deploy to Pages" still updates the wall: the page's /api/version poll sees
     the new mtime and reloads itself within seconds. install-pi.sh sets this up.

Run:   python3 server.py        (defaults to http://localhost:8001)
       PORT=9000 python3 server.py
"""
import http.server
import socketserver
import urllib.request
import json
import time
import threading
import os
import gzip
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8001"))
# On the Pi and in dev we bind loopback only. On Render (RENDER=true in the env) the
# platform's router must reach us, so bind everywhere; PORT is set by Render too.
HOST = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1")

# ---- /frame: the relay contract the hosted page speaks (mirrors relay/main.ts) ----
# One answer per poll: the whole disc as positional rows (cols gives the order) plus her
# plane's status, gzipped when the caller accepts it. Positional rows + gzip keep the
# egress small (~11 KB per answer).
FRAME_COLS = ["hex", "flight", "r", "t", "lat", "lon", "alt_baro", "gs", "track",
              "seen_pos", "category", "baro_rate", "desc", "ownOp"]

# --- the page itself: mirrored from the hosted copy, served from ./site when present ---
SITE_URL = os.environ.get("SITE_URL", "https://flightframe.pages.dev")
SITE_DIR = os.path.join(HERE, "site")
SITE_FILES = ("index.html", "leaflet.js", "leaflet.css", "robots.txt")
UPDATE_EVERY = 6 * 3600          # seconds between mirror checks (plus one at start)
SITE_MIN_BYTES = {"index.html": 50_000, "leaflet.js": 100_000, "leaflet.css": 5_000, "robots.txt": 5}

# --- The "frame": Livonia (home) + a 155nm radius ---
# 155nm ~= mid-Lake Michigan: keeps southeast Michigan dense while excluding the
# ORD/MDW terminal swarm (~193nm) — the brother's call for the Pi frame, Jul 21.
# (250 was the API max and covered Chicago/Toronto/Mackinac — flip back anytime.)
MI_LAT, MI_LON, MI_RADIUS = 42.36837, -83.35271, 155
# Live feeds (Sep 18 2026): airplanes.live took its free API down in mid-Aug 2026
# (403 "contact us"; feeder-IP only). adsb.fi is primary (free, no key, 1 req/s,
# personal use, attribution required); adsb.lol is the fallback. Same readsb JSON
# shape ({"ac":[...]}), so the page needs nothing else.
LIVE = {
    "planes": [
        f"https://opendata.adsb.fi/api/v3/lat/{MI_LAT}/lon/{MI_LON}/dist/{MI_RADIUS}",
        f"https://api.adsb.lol/v2/point/{MI_LAT}/{MI_LON}/{MI_RADIUS}",
    ],
    "fav": [
        "https://opendata.adsb.fi/api/v2/registration/{reg}",
        "https://api.adsb.lol/v2/reg/{reg}",
    ],
}
ADSBDB = "https://api.adsbdb.com/v0"          # callsign -> route/airline, reg -> aircraft
LOL_ROUTES = "https://vrs-standing-data.adsb.lol/routes"   # community VRS route db (fallback source)

# --- tiny server-side cache so rapid client refreshes don't hammer upstream ---
_cache = {}                   # url -> (fetched_at, bytes)
_lock = threading.Lock()      # guards _cache
_inflight = {}                # url -> Lock, so identical concurrent requests collapse
_inflight_lock = threading.Lock()
TTL = 3.5                     # seconds — MUST stay below the page's 4s poll cadence,
                              # or every other poll would get a cached (stale) frame
CACHE_MAX = 600               # entries; past this, expired ones get swept


def _prune_locked(now):
    # caller holds _lock. Drop anything >2h old (covers the 1h adsbdb TTL too) —
    # without this the per-callsign route/aircraft entries accumulate forever
    # on a frame that runs for weeks.
    if len(_cache) <= CACHE_MAX:
        return
    cutoff = now - 7200
    for k in [k for k, (t, _) in _cache.items() if t < cutoff]:
        del _cache[k]


def fetch(url, ttl=TTL):
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    # one upstream call per URL at a time: a second thread asking for the same
    # thing waits here, then gets the fresh cache entry instead of double-hitting
    # the 1-req/s API.
    with _inflight_lock:
        gate = _inflight.setdefault(url, threading.Lock())
    with gate:
        now = time.time()
        with _lock:
            hit = _cache.get(url)
            if hit and now - hit[0] < ttl:
                return hit[1]
        req = urllib.request.Request(
            url, headers={"User-Agent": "FlightFrame/1.0 (personal radar picture frame)"}
        )
        # stamp the cache at REQUEST-START, not fetch-completion: a slow upstream
        # otherwise shifts the TTL window forward and the next 4s poll lands inside
        # it, serving a stale frame (which freezes the glide for that cycle).
        req_start = time.time()
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                data = r.read()
        except Exception:
            if hit:           # stale-if-error: yesterday's answer beats a blank frame
                return hit[1]
            raise
        with _lock:
            _cache[url] = (req_start, data)
            _prune_locked(time.time())
        return data


def serve_dir():
    # the mirrored site if we have one, else the folder this file lives in (dev checkout)
    return SITE_DIR if os.path.exists(os.path.join(SITE_DIR, "index.html")) else HERE


def site_update():
    # Pull every site file; swap each in only if it downloaded whole and changed. A
    # failed or partial download leaves the current copy untouched (the wall must never
    # boot into half a page). Returns the number of files that changed.
    changed = 0
    os.makedirs(SITE_DIR, exist_ok=True)
    for name in SITE_FILES:
        try:
            # Pages answers /index.html with a 308 to / (and not every urllib follows 308)
            src = f"{SITE_URL}/" if name == "index.html" else f"{SITE_URL}/{name}"
            req = urllib.request.Request(src, headers={
                "User-Agent": "FlightFrame/1.1 (site mirror)", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
            if len(data) < SITE_MIN_BYTES.get(name, 1):
                raise ValueError(f"{name}: only {len(data)} bytes")
            if name == "index.html" and b"<title>FlightFrame" not in data:
                raise ValueError("index.html: not the frame page")
            dst = os.path.join(SITE_DIR, name)
            if os.path.exists(dst) and open(dst, "rb").read() == data:
                continue
            tmp = dst + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dst)          # atomic on POSIX
            changed += 1
        except Exception as e:
            print(f"site mirror: {name} kept as-is ({e})", flush=True)
    if changed:
        print(f"site mirror: {changed} file(s) updated from {SITE_URL}", flush=True)
    return changed


def site_updater():
    # daemon loop: one pull at start (after the server is up), then every UPDATE_EVERY
    time.sleep(3)
    while True:
        try:
            site_update()
        except Exception as e:
            print(f"site mirror: {e}", flush=True)
        time.sleep(UPDATE_EVERY)


def fetch_live(urls):
    # first source that answers a real {"ac":[...]} wins; a 200-status error envelope
    # or a block page counts as a miss, same as relay/main.ts
    return fetch_live_ex(urls)[0]


def fetch_live_ex(urls):
    # -> (bytes, source_name, stale). stale = the cache handed back an older-than-TTL
    # answer because every fresh fetch failed (yesterday's answer beats a blank frame).
    errors = []
    for url in urls:
        try:
            data = fetch(url)
            j = json.loads(data)
            if isinstance(j, dict) and isinstance(j.get("ac"), list):
                with _lock:
                    at = _cache.get(url, (time.time(), b""))[0]
                source = "adsb.fi" if "adsb.fi" in url else ("adsb.lol" if "adsb.lol" in url else url)
                return data, source, (time.time() - at) > TTL
            errors.append(f"{url}: no ac[]")
        except Exception as e:
            errors.append(f"{url}: {e}")
    raise RuntimeError("all live sources failed: " + "; ".join(errors))


def frame_payload(reg):
    # the /frame answer, as a dict; raises when no live source answers
    data, source, stale = fetch_live_ex(LIVE["planes"])
    ac = json.loads(data)["ac"]
    rows = [[a.get(c) for c in FRAME_COLS] for a in ac]
    fav, fav_source = None, "none"
    if reg:
        try:
            fdata, fav_source, _ = fetch_live_ex([t.format(reg=quote(reg, safe='')) for t in LIVE["fav"]])
            fac = json.loads(fdata)["ac"]
            fav = fac[0] if fac else None
        except Exception:
            fav, fav_source = None, "miss"
    return {"now": int(time.time() * 1000), "source": source, "stale": stale,
            "cols": FRAME_COLS, "rows": rows, "fav": fav, "favSource": fav_source}


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 = keep-alive: the page polls /api/planes every 4s and /api/version
    # every 2s; reusing one TCP connection beats a fresh handshake per poll.
    # (Requires an accurate Content-Length on every response — see _json.)
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **k):
        super().__init__(*a, directory=serve_dir(), **k)

    def _json(self, raw, code=200):
        body = raw if isinstance(raw, bytes) else raw.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        # the hosted page (https://flightframe.pages.dev) fetches this cross-origin;
        # public read-only data, so a wildcard is fine and needs no preflight
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Vary", "Accept-Encoding")
        # gzip when asked: readsb JSON shrinks ~5x, /frame ~3x. On Render that is the
        # difference between blowing the free egress and using a fraction of it.
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, compresslevel=6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path in ("/health", "/api/health"):
                return self._json(json.dumps({"ok": True, "service": "flightframe-relay", "cols": FRAME_COLS}))
            if u.path in ("/frame", "/api/frame"):
                # the relay contract: whole disc + her plane, one answer per poll
                reg = (parse_qs(u.query).get("reg", [""])[0]).strip().upper()
                try:
                    return self._json(json.dumps(frame_payload(reg), separators=(",", ":")))
                except Exception as e:
                    return self._json(json.dumps({"error": str(e), "cols": FRAME_COLS, "rows": [], "fav": None}), code=502)
            if u.path == "/api/planes":
                # everything currently flying over Michigan
                return self._json(fetch_live(LIVE["planes"]))
            if u.path == "/api/fav":
                # status of one specific plane by registration — works anywhere,
                # even if it's parked in California. Empty reg -> empty result.
                reg = (parse_qs(u.query).get("reg", [""])[0]).strip().upper()
                if not reg:
                    return self._json(b'{"ac":[]}')
                return self._json(fetch_live([t.format(reg=quote(reg, safe='')) for t in LIVE["fav"]]))
            if u.path == "/api/version":
                # live-reload: the page polls this and reloads when a file changes —
                # on the frame that's how a fresh deploy (mirrored into ./site) lands
                try:
                    d = serve_dir()
                    m = max([os.path.getmtime(os.path.abspath(__file__))] +
                            [os.path.getmtime(os.path.join(d, n)) for n in SITE_FILES
                             if os.path.exists(os.path.join(d, n))])
                except Exception:
                    m = 0
                return self._json(json.dumps({"v": m}))
            if u.path == "/api/route":
                # callsign -> airline + origin/destination airports (adsbdb, cached 1h)
                cs = (parse_qs(u.query).get("cs", [""])[0]).strip().upper()
                if not cs:
                    return self._json(b'{"response":null}')
                try:
                    return self._json(fetch(f"{ADSBDB}/callsign/{quote(cs, safe='')}", ttl=3600))
                except Exception:
                    return self._json(b'{"response":null}')   # unknown callsign -> 404
            if u.path == "/api/lolroute":
                # callsign -> adsb.lol / VRS standing-data route (multi-leg; fallback
                # when adsbdb's route is missing or fails the client geo-gate). Static
                # CDN JSON, cached 1h. Misses return an empty-airports stub so the
                # client doesn't re-try the CDN directly.
                cs = (parse_qs(u.query).get("cs", [""])[0]).strip().upper()
                if not cs:
                    return self._json(b'{"_airports":[]}')
                try:
                    return self._json(fetch(
                        f"{LOL_ROUTES}/{quote(cs[:2], safe='')}/{quote(cs, safe='')}.json", ttl=3600))
                except Exception:
                    return self._json(b'{"_airports":[]}')
            if u.path == "/api/ac":
                # registration -> aircraft type, owner, photo (adsbdb, cached 1h)
                reg = (parse_qs(u.query).get("reg", [""])[0]).strip().upper()
                if not reg:
                    return self._json(b'{"response":null}')
                try:
                    return self._json(fetch(f"{ADSBDB}/aircraft/{quote(reg, safe='')}", ttl=3600))
                except Exception:
                    return self._json(b'{"response":null}')
        except Exception as e:
            return self._json(json.dumps({"error": str(e), "ac": []}), code=502)
        # First boot on a Pi before the mirror has landed: no page yet anywhere local.
        # Bounce to the hosted copy rather than show a bare directory listing.
        if u.path in ("/", "/index.html") and not os.path.exists(os.path.join(serve_dir(), "index.html")):
            self.send_response(302)
            self.send_header("Location", SITE_URL + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # anything else: serve static files (index.html, etc.)
        return super().do_GET()

    def do_HEAD(self):           # health probes sometimes HEAD; same routing, no body
        return self.do_GET()

    def log_message(self, *a):  # keep the terminal quiet
        pass


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True   # stuck clients can't block shutdown
    if not os.path.exists(os.path.join(HERE, "index.html")) and not os.environ.get("RENDER"):
        # installed copy (the Pi): keep the page mirrored from the hosted site.
        # A dev checkout has index.html next to this file and serves that instead;
        # the Render relay only answers /frame and never serves the page.
        threading.Thread(target=site_updater, daemon=True).start()
    with socketserver.ThreadingTCPServer((HOST, PORT), Handler) as httpd:
        print(f"FlightFrame running  ->  http://{HOST}:{PORT}  (serving {serve_dir()})", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
