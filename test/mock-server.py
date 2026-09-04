"""Stand-in for the Pi: speaks the exact wire protocol of server/server.js
(hello -> {inputId}; event -> written to uinput) but records events instead
of touching /dev/uinput, decodes them by name and flags anything the real
device would reject. Serves the same static tree Grunt builds (public/** with
client/** on top). Runs on any OS.

    python test/mock-server.py --repo . --port 8888 [--full]

    GET /events.json   everything received since the last reset
    GET /reset         clear the log
    --full             never answer 'hello' (simulates every pad slot taken)
"""
import argparse, json, os, time
import socketio
from aiohttp import web

KEYS = {
    0x130: 'CROSS', 0x131: 'CIRCLE', 0x133: 'TRIANGLE', 0x134: 'SQUARE',
    0x136: 'L1', 0x137: 'R1', 0x138: 'L2', 0x139: 'R2',
    0x13a: 'CREATE', 0x13b: 'OPTIONS', 0x13c: 'PS', 0x13d: 'L3', 0x13e: 'R3',
    0x110: 'MOUSE_LEFT', 0x111: 'MOUSE_RIGHT',
}
ABS = {   # code -> (name, min, max)
    0x00: ('LX', 0, 255), 0x01: ('LY', 0, 255), 0x02: ('RSX', 0, 255), 0x05: ('RSY', 0, 255),
    0x03: ('L2_AXIS', 0, 255), 0x04: ('R2_AXIS', 0, 255), 0x10: ('HAT_X', -1, 1), 0x11: ('HAT_Y', -1, 1),
}
REL = {0x00: 'MOUSE_DX', 0x01: 'MOUSE_DY'}

def decode(ev):
    """Return (name, problems) for one {type, code, value}."""
    problems = []
    if not isinstance(ev, dict):
        return '?', ['payload is not an object']
    t, c, v = ev.get('type'), ev.get('code'), ev.get('value')
    if not all(isinstance(x, int) for x in (t, c, v)):
        return '?', ['type/code/value must be integers']
    if t == 0x01:
        name = KEYS.get(c)
        if name is None: problems.append('unknown button code 0x%x' % c)
        if v not in (0, 1): problems.append('button value %r is not 0/1' % v)
        return name or ('KEY_0x%x' % c), problems
    if t == 0x03:
        spec = ABS.get(c)
        if spec is None: return 'ABS_0x%x' % c, ['unknown axis code 0x%x' % c]
        name, lo, hi = spec
        if not lo <= v <= hi: problems.append('%s value %r outside %d..%d' % (name, v, lo, hi))
        return name, problems
    if t == 0x02:
        name = REL.get(c)
        if name is None: problems.append('unknown rel code 0x%x' % c)
        if v == 0: problems.append('zero relative move is pointless')
        return name or ('REL_0x%x' % c), problems
    return 'TYPE_%r' % t, ['unknown event type %r' % t]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--port', type=int, default=8888)
    ap.add_argument('--pad-limit', type=int, default=4)
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    roots = [os.path.normpath(os.path.join(a.repo, 'public')), os.path.normpath(os.path.join(a.repo, 'client'))]
    sio = socketio.AsyncServer(cors_allowed_origins='*', async_mode='aiohttp')
    app = web.Application()
    sio.attach(app)
    events, slots = [], {}          # slots: inputId -> sid
    t0 = time.perf_counter()
    ms = lambda: round((time.perf_counter() - t0) * 1000, 1)
    say = (lambda *x: None) if a.quiet else (lambda *x: print(*x, flush=True))

    def resolve(path):
        rel = path.lstrip('/') or 'index.html'
        for root in reversed(roots):               # client/ overlays public/
            p = os.path.normpath(os.path.join(root, rel))
            if p.startswith(root) and os.path.isfile(p):
                return p
        return None

    async def static(request):
        p = resolve(request.path)
        if not p:
            return web.Response(status=404, text='not found: ' + request.path)
        return web.FileResponse(p)

    @sio.event
    async def connect(sid, environ):
        say('[conn] %s connected' % sid)

    @sio.event
    async def disconnect(sid):
        for k, v in list(slots.items()):
            if v == sid:
                del slots[k]
                say('[conn] goodbye input %d' % k)
        events.append({'t': ms(), 'kind': 'disconnect', 'sid': sid})

    @sio.on('hello')
    async def hello(sid, *args):
        if a.full:
            say('[hello] dropped (pad full)'); return
        for i in range(1, a.pad_limit + 1):
            if i not in slots:
                slots[i] = sid
                events.append({'t': ms(), 'kind': 'hello', 'inputId': i})
                say('[hello] -> inputId %d' % i)
                await sio.emit('hello', {'inputId': i}, to=sid)
                return
        say('[hello] dropped (pad full)')

    @sio.on('event')
    async def event(sid, data):
        name, problems = decode(data)
        rec = {'t': ms(), 'kind': 'event', 'name': name, 'type': data.get('type') if isinstance(data, dict) else None,
               'code': data.get('code') if isinstance(data, dict) else None,
               'value': data.get('value') if isinstance(data, dict) else None}
        if sid not in slots.values():
            problems.append('event before hello (server would drop it)')
        if problems:
            rec['problems'] = problems
        events.append(rec)
        tag = 'DOWN' if rec['type'] == 1 and rec['value'] else ('up' if rec['type'] == 1 else '= %s' % rec['value'])
        say('[ev] %-9s %s%s' % (name, tag, ('   !! ' + '; '.join(problems)) if problems else ''))

    async def get_events(request): return web.json_response(events)
    async def reset(request):
        del events[:]
        return web.json_response({'ok': True})

    app.router.add_get('/events.json', get_events)
    app.router.add_get('/reset', reset)
    app.router.add_route('*', '/{tail:.*}', static)
    say('mock Pi on http://127.0.0.1:%d  (static: %s)' % (a.port, ', '.join(roots)))
    web.run_app(app, host='127.0.0.1', port=a.port, print=None)

if __name__ == '__main__':
    main()
