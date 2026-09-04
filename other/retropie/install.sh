#!/usr/bin/env bash
# Installs the RetroPie side of MobileGamePad and restarts EmulationStation:
#   - RetroArch autoconfig  -> /opt/retropie/configs/all/retroarch-joypads/MobileGamePad.cfg   (in-game buttons, hotkeys)
#   - EmulationStation map  -> ~/.emulationstation/es_input.cfg                                 (menus)
# Run on the Pi as the user that runs EmulationStation (normally pi):
#   bash other/retropie/install.sh
# Safe to re-run. Everything it overwrites is backed up next to the original with a .bak-<timestamp> suffix.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ES_CFG="${ES_CFG:-$HOME/.emulationstation/es_input.cfg}"
RA_DIR="${RA_DIR:-/opt/retropie/configs/all/retroarch-joypads}"
TS="$(date +%Y%m%d-%H%M%S)"

# 1. RetroArch autoconfig
mkdir -p "$RA_DIR"
[ -f "$RA_DIR/MobileGamePad.cfg" ] && cp -a "$RA_DIR/MobileGamePad.cfg" "$RA_DIR/MobileGamePad.cfg.bak-$TS"
cp "$HERE/MobileGamePad.cfg" "$RA_DIR/MobileGamePad.cfg"
echo "RetroArch autoconfig      -> $RA_DIR/MobileGamePad.cfg"

# 2. EmulationStation mapping: replace any existing MobileGamePad block, keep everything else
mkdir -p "$(dirname "$ES_CFG")"
if [ -f "$ES_CFG" ]; then
  cp -a "$ES_CFG" "$ES_CFG.bak-$TS"
else
  printf '<?xml version="1.0"?>\n<inputList>\n</inputList>\n' > "$ES_CFG"
fi
python3 - "$ES_CFG" "$HERE/es_input-MobileGamePad.xml" <<'PY'
import re, sys
import xml.etree.ElementTree as ET
cfg, src = sys.argv[1], sys.argv[2]
block = re.search(r'<inputConfig.*?</inputConfig>', open(src).read(), re.S).group(0)
s = open(cfg).read()
old = re.compile(r'[ \t]*<inputConfig type="joystick" deviceName="MobileGamePad"[^>]*>.*?</inputConfig>[ \t]*\n?', re.S)
n = len(old.findall(s))
s = old.sub('', s)
if '</inputList>' not in s:
    sys.exit('%s has no <inputList> root, not touching it' % cfg)
s = s.replace('</inputList>', '  ' + block.replace('\n', '\n  ') + '\n</inputList>')
open(cfg, 'w').write(s)
ET.parse(cfg)  # fail loudly if the result is not well-formed XML
print('EmulationStation mapping  -> %s (replaced %d old MobileGamePad block%s)' % (cfg, n, '' if n == 1 else 's'))
PY

# 3. Restart EmulationStation so it reads the new mapping (it only reads es_input.cfg at start-up).
#    Its process name is truncated to "emulationstatio", so match on the full path instead of pgrep -x.
ES_PID="$(ps -eo pid,args | awk '$2 ~ /emulationstation\/emulationstation$/ {print $1}' || true)"
if [ -z "$ES_PID" ]; then
  echo "EmulationStation is not running; the mapping is picked up on its next start"
elif pgrep -f 'runcommand\.sh' >/dev/null 2>&1; then
  echo "An emulator or port is running; quit it, then restart EmulationStation (Start > Quit > Restart EmulationStation)"
else
  touch /tmp/es-restart          # the emulationstation.sh wrapper relaunches ES instead of dropping to a shell
  kill "$ES_PID"
  echo "EmulationStation restarting (was pid $ES_PID)"
fi
