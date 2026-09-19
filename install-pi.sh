#!/usr/bin/env bash
# FlightFrame — one-shot setup of the live-data proxy on the frame's Raspberry Pi.
#
# Why: since mid-Aug 2026 no free ADS-B feed can be called from a browser (airplanes.live
# went feeder-only; adsb.fi/adsb.lol send no CORS headers), the same feeds block
# Cloudflare Workers, and Chrome won't let an https page talk to localhost. So the Pi
# now runs the whole thing itself: server.py mirrors the page from
# https://flightframe.pages.dev, serves it at http://localhost:8001/, and proxies the
# live feed (adsb.fi) from the Pi's own connection. Deploys to pages.dev still reach
# the frame (the page reloads itself when the mirror changes). This installs server.py
# as a systemd service (starts at boot, restarts if it dies) and points the Chromium
# kiosk line in ~/.config/labwc/autostart at http://localhost:8001/ — then reboot.
#
# Run ON the Pi (needs sudo once, for the service file):
#   curl -fsSLO https://flightframe.pages.dev/install-pi.sh && bash install-pi.sh
# Re-run any time to pull a fresh server.py.
set -euo pipefail

SITE="https://flightframe.pages.dev"
DIR="$HOME/flightframe"
PORT=8001

command -v python3 >/dev/null || { echo "python3 is missing: sudo apt install -y python3   then re-run"; exit 1; }
mkdir -p "$DIR" && cd "$DIR"
echo "-> fetching server.py from $SITE"
curl -fsSL "$SITE/server.py" -o server.py.new && mv server.py.new server.py

PY="$(command -v python3)"
UNIT=/etc/systemd/system/flightframe.service
echo "-> writing $UNIT (runs as $USER, from $DIR)"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=FlightFrame live-data proxy (adsb.fi -> http://localhost:$PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$PY $DIR/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now flightframe
sudo systemctl restart flightframe    # picks up a freshly downloaded server.py on re-runs

echo "-> waiting for the proxy + the mirrored page"
ok=0
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/planes" -o /tmp/ff_planes.json 2>/dev/null \
     && curl -fsS "http://localhost:$PORT/" 2>/dev/null | grep -q "<title>FlightFrame"; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "not up after 30s — check:  systemctl status flightframe   and   journalctl -u flightframe -n 30"; exit 1
fi
n=$("$PY" -c "import json;print(len(json.load(open('/tmp/ff_planes.json'))['ac']))" 2>/dev/null || echo '?')
echo "OK: page mirrored and proxy up, $n aircraft in the disc."

# point the kiosk at the local copy (labwc autostart on Raspberry Pi OS Bookworm)
AUTO="$HOME/.config/labwc/autostart"
if [ -f "$AUTO" ] && grep -q "flightframe.pages.dev" "$AUTO"; then
  cp "$AUTO" "$AUTO.bak.$(date +%Y%m%d%H%M%S)"
  sed -i 's#https://flightframe\.pages\.dev#http://localhost:'"$PORT"'#g' "$AUTO"
  echo "-> kiosk URL switched to http://localhost:$PORT in $AUTO (backup kept). Reboot to apply:  sudo reboot"
else
  echo "-> could not find the kiosk line in $AUTO — edit the chromium --kiosk URL yourself to http://localhost:$PORT/ and reboot"
fi
echo "    status any time:  systemctl status flightframe    logs:  journalctl -u flightframe -n 30"
