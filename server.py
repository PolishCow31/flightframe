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
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8001"))

# --- The Michigan "frame": center of the lower peninsula + a 250nm radius ---
# 250nm is the API maximum for a single point query and comfortably blankets
# the whole state (both peninsulas) plus a little of the neighbors.
MI_LAT, MI_LON, MI_RADIUS = 44.6, -85.0, 250
UPSTREAM = "https://api.airplanes.live/v2"
ADSBDB = "https://api.adsbdb.com/v0"          # callsign -> route/airline, reg -> aircraft

# --- tiny server-side cache so rapid client refreshes don't hammer upstream ---
_cache = {}
_lock = threading.Lock()
TTL = 5.0  # seconds


def fetch(url, ttl=TTL):
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(
        url, headers={"User-Agent": "FlightFrame/1.0 (personal radar picture frame)"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read()
    with _lock:
        _cache[url] = (now, data)
    return data


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def _json(self, raw, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw if isinstance(raw, bytes) else raw.encode())

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
                return self._json(fetch(f"{UPSTREAM}/reg/{reg}"))
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
                    return self._json(fetch(f"{ADSBDB}/callsign/{cs}", ttl=3600))
                except Exception:
                    return self._json(b'{"response":null}')   # unknown callsign -> 404
            if u.path == "/api/ac":
                # registration -> aircraft type, owner, photo (adsbdb, cached 1h)
                reg = (parse_qs(u.query).get("reg", [""])[0]).strip().upper()
                if not reg:
                    return self._json(b'{"response":null}')
                try:
                    return self._json(fetch(f"{ADSBDB}/aircraft/{reg}", ttl=3600))
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
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"FlightFrame running  ->  http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
