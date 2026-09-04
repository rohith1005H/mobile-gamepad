# Tests

Everything here runs on any OS, no Raspberry Pi and no `/dev/uinput` needed.

| File | What it proves |
|---|---|
| `mock-server.py` | Stand-in for the Pi. Same socket.io wire protocol as `server/server.js` (`hello` -> `{inputId}`, `event` -> device), same static tree Grunt builds, but it records every event, decodes it by name and flags anything the real uinput device would reject. |
| `e2e.py` | Drives the real client in headless Chrome against the mock server with synthesised touches and keys, then checks exactly which events arrived: every button, hat D-pad, both sticks, both analog triggers, touchpad motion and clicks, multitouch, thumb rolling, keyboard auto-repeat, focus loss. |
| `gamepad.test.js` | Unit test for `server/src/gamepad.js` with `uinput2`, `ioctl` and `fs` replaced by recorders: device registration (buttons, axes, ranges, both devices), event packing, routing of touchpad events to the mouse device, cleanup on disconnect. |
| `cdp.py` | Tiny Chrome DevTools Protocol driver used by `e2e.py`. |

## Run

```bash
pip install python-socketio aiohttp

# terminal 1: the fake Pi, serving public/ + client/ on :8901
python test/mock-server.py --repo . --port 8901

# terminal 2: the browser test (needs Chrome; set CHROME=<path> if not in the default location)
python test/e2e.py --base http://127.0.0.1:8901 --shot pad.png

# server unit test (needs the 'struct' package: npm install, or point STRUCT_PATHS at one)
node test/gamepad.test.js
```

`--shot` saves a screenshot with the D-pad, Cross, L2 and the right stick held, useful for eyeballing the pressed styling.

## Manual test on a phone

Open `http://<this-pc>:8901` from a phone on the same Wi-Fi with the mock server running. The terminal prints every event as you touch the pad, so you can feel the layout and see the exact codes without touching the Pi.
