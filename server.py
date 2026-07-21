#!/usr/bin/env python3
"""
FlightFrame — a wall-mounted Michigan flight-radar frame that spotlights one plane.

Stdlib only (no pip installs). It does two jobs:
  1. Serves index.html (the frame UI).
  2. Proxies the free airplanes.live ADS-B API, so the browser never talks to
     the API directly. That kills CORS headaches AND lets us cache responses
     server-side to stay under airplanes.live's 1-request/second limit, no
     matter how many times the frame refreshes.

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
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8001"))

# --- The "frame": Livonia (home) + a 250nm radius ---
# 250nm is the API maximum for a single point query. Centred on home it covers
# all of lower Michigan + eastern UP, Ohio, Lake Erie and southern Ontario
# (incl. Toronto); the far western UP falls outside — near-zero traffic there.
MI_LAT, MI_LON, MI_RADIUS = 42.36837, -83.35271, 250
UPSTREAM = "https://api.airplanes.live/v2"
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


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 = keep-alive: the page polls /api/planes every 4s and /api/version
    # every 2s; reusing one TCP connection beats a fresh handshake per poll.
    # (Requires an accurate Content-Length on every response — see _json.)
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def _json(self, raw, code=200):
        body = raw if isinstance(raw, bytes) else raw.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/planes":
                # everything currently flying over Michigan
                return self._json(fetch(f"{UPSTREAM}/point/{MI_LAT}/{MI_LON}/{MI_RADIUS}"))
            if u.path == "/api/fav":
                # status of one specific plane by registration — works anywhere,
                # even if it's parked in California. Empty reg -> empty result.
                reg = (parse_qs(u.query).get("reg", [""])[0]).strip().upper()
                if not reg:
                    return self._json(b'{"ac":[]}')
                return self._json(fetch(f"{UPSTREAM}/reg/{quote(reg, safe='')}"))
            if u.path == "/api/version":
                # live-reload: the page polls this and reloads when a file changes
                try:
                    m = max(os.path.getmtime(os.path.join(HERE, "index.html")),
                            os.path.getmtime(os.path.abspath(__file__)))
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
        # anything else: serve static files (index.html, etc.)
        return super().do_GET()

    def log_message(self, *a):  # keep the terminal quiet
        pass


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True   # stuck clients can't block shutdown
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"FlightFrame running  ->  http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
