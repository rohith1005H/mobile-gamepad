"""End-to-end protocol test: drives the real client in headless Chrome against
test/mock-server.py and checks exactly which uinput events reach the "Pi".

    python test/mock-server.py --repo . --port 8901 --quiet &
    python test/e2e.py --base http://127.0.0.1:8901

Touches are synthesised as Pointer Events on the live page (the same events a
finger produces), so the whole client input model runs for real: multitouch,
button rolling, stick/trigger/touchpad steering, keyboard, blur release.
"""
import argparse, asyncio, json, os, sys, tempfile, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome

HELPERS = r"""
window.__h = (() => {
  const RAW = 'onpointerrawupdate' in window;
  function centre(sel){ const b=document.querySelector(sel).getBoundingClientRect();
    return {x:b.x+b.width/2, y:b.y+b.height/2, w:b.width, h:b.height, l:b.x, r:b.right, t:b.y, b:b.bottom}; }
  function ev(type,id,x,y){ return new PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y,bubbles:true,cancelable:true,isPrimary:id===1}); }
  function down(sel,id,dx=0,dy=0){ const c=centre(sel); const x=c.x+dx, y=c.y+dy;
    const el=document.elementFromPoint(x,y)||document.querySelector(sel); el.dispatchEvent(ev('pointerdown',id,x,y)); return c; }
  function move(id,x,y){ if(RAW) window.dispatchEvent(ev('pointerrawupdate',id,x,y)); window.dispatchEvent(ev('pointermove',id,x,y)); }
  function up(id,x=0,y=0){ window.dispatchEvent(ev('pointerup',id,x,y)); }
  function key(type,code,repeat){ document.dispatchEvent(new KeyboardEvent(type,{code:code,key:code,repeat:!!repeat,bubbles:true,cancelable:true})); }
  function pressed(){ return document.querySelectorAll('.is-pressed').length; }
  return {centre,down,move,up,key,pressed,RAW};
})(); 'ok'
"""

def fetch(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return json.loads(r.read().decode())

def names(evs):
    out = []
    for e in evs:
        if e.get('kind') != 'event': continue
        if e['type'] == 1: out.append('%s %s' % (e['name'], 'DOWN' if e['value'] else 'up'))
        else: out.append('%s=%s' % (e['name'], e['value']))
    return out

class T:
    def __init__(self, c, base):
        self.c, self.base, self.results, self.all_events = c, base, [], []
    async def js(self, expr):
        return await self.c.js(expr)
    async def collect(self, wait=0.15):
        await asyncio.sleep(wait)
        evs = fetch(self.base, '/events.json')
        self.all_events.extend(evs)
        fetch(self.base, '/reset')
        return evs
    def check(self, name, got, want, exact=True):
        ok = (got == want) if exact else set(want) <= set(got)
        self.results.append((name, ok, got, want))
        print(('PASS ' if ok else 'FAIL ') + name)
        if not ok:
            print('   got : %s' % got)
            print('   want: %s' % want)

async def run(base, profile, shot):
    async with Chrome(profile, port=9345, width=844, height=390) as c:
        t = T(c, base)
        fetch(base, '/reset')
        await c.navigate(base + '/')
        await asyncio.sleep(1.6)

        # 1. handshake + state sync onto the fresh device
        st = await t.js("document.getElementById('statusText').textContent")
        state = await t.js("document.getElementById('status').dataset.state")
        t.check('hello: status shows Player 1 / ready', [st, state], ['Player 1', 'ready'])
        evs = await t.collect(0.1)
        t.check('hello: all axes centred/zeroed on the new device',
                sorted(names(evs)), sorted(['LX=128', 'LY=128', 'RSX=128', 'RSY=128', 'L2_AXIS=0', 'R2_AXIS=0', 'HAT_X=0', 'HAT_Y=0']))
        font = await t.js("document.fonts.check('600 16px \"Chakra Petch\"')")
        t.check('self-hosted Chakra Petch loaded', [font], [True])

        await t.js(HELPERS)

        # 2. every digital button, tap = DOWN then up
        for sel, name in [('.face__btn--tri', 'TRIANGLE'), ('.face__btn--sq', 'SQUARE'), ('.face__btn--circ', 'CIRCLE'),
                          ('.face__btn--cross', 'CROSS'), ('.shoulder--l1', 'L1'), ('.shoulder--r1', 'R1'),
                          ('[data-code="0x13a"]', 'CREATE'), ('[data-code="0x13b"]', 'OPTIONS'), ('.ps', 'PS')]:
            await t.js("__h.down('%s', 1)" % sel); await asyncio.sleep(0.05); await t.js("__h.up(1)")
            t.check('button %s' % name, names(await t.collect()), ['%s DOWN' % name, '%s up' % name])

        # 3. D-pad as hat switch: right, roll to up-right, release
        await t.js("window.__c = __h.down('#dpad', 9, 60, 0)"); await asyncio.sleep(0.05)
        await t.js("__h.move(9, __c.x + 45, __c.y - 45)"); await asyncio.sleep(0.05)
        await t.js("__h.up(9)")
        t.check('dpad right -> up-right -> release', names(await t.collect()), ['HAT_X=1', 'HAT_Y=-1', 'HAT_X=0', 'HAT_Y=0'])

        # 4. left stick: full right, then full down, then release recentres
        await t.js("window.__c = __h.down('#lstick', 3)"); await asyncio.sleep(0.05)
        await t.js("__h.move(3, __c.x + 200, __c.y)"); await asyncio.sleep(0.05)
        await t.js("__h.move(3, __c.x, __c.y + 200)"); await asyncio.sleep(0.05)
        await t.js("__h.up(3)")
        t.check('left stick full right, full down, recentre', names(await t.collect()), ['LX=255', 'LX=128', 'LY=255', 'LY=128'])

        # 5. right stick tap = R3 click, no axis noise
        await t.js("__h.down('#rstick', 4)"); await asyncio.sleep(0.05); await t.js("__h.up(4)")
        t.check('right stick tap = R3 click', names(await t.collect(0.25)), ['R3 DOWN', 'R3 up'])

        # 6. triggers: touch = full pull (+digital), slide to feather, release
        await t.js("window.__c = __h.down('#l2', 5)"); await asyncio.sleep(0.05)
        await t.js("__h.move(5, __c.l + __c.w * 0.25, __c.y)"); await asyncio.sleep(0.05)
        await t.js("__h.up(5)")
        t.check('L2 pull, feather to 25%, release', names(await t.collect()), ['L2_AXIS=255', 'L2 DOWN', 'L2_AXIS=64', 'L2 up', 'L2_AXIS=0'])
        await t.js("__h.down('#r2', 6)"); await asyncio.sleep(0.05); await t.js("__h.up(6)")
        t.check('R2 tap', names(await t.collect()), ['R2_AXIS=255', 'R2 DOWN', 'R2_AXIS=0', 'R2 up'])

        # 7. touchpad: drag moves the pointer, quick tap clicks
        await t.js("window.__c = __h.down('#touchpad', 7, -30, -10)"); await asyncio.sleep(0.05)
        await t.js("__h.move(7, __c.x, __c.y)"); await asyncio.sleep(0.3)
        await t.js("__h.up(7)")
        t.check('touchpad drag = relative mouse motion, no click', names(await t.collect()), ['MOUSE_DX=48', 'MOUSE_DY=16'])
        await t.js("__h.down('#touchpad', 8)"); await asyncio.sleep(0.05); await t.js("__h.up(8)")
        t.check('touchpad tap = left click', names(await t.collect(0.25)), ['MOUSE_LEFT DOWN', 'MOUSE_LEFT up'])

        # 8. multitouch + rolling
        await t.js("__h.down('.face__btn--cross', 1); __h.down('.face__btn--circ', 2)"); await asyncio.sleep(0.05)
        await t.js("__h.up(1)"); await asyncio.sleep(0.03); await t.js("__h.up(2)")
        t.check('two fingers: cross + circle overlap', names(await t.collect()), ['CROSS DOWN', 'CIRCLE DOWN', 'CROSS up', 'CIRCLE up'])
        await t.js("__h.down('.face__btn--sq', 1); window.__c = __h.centre('.face__btn--tri')"); await asyncio.sleep(0.05)
        await t.js("__h.move(1, __c.x, __c.y)"); await asyncio.sleep(0.05); await t.js("__h.up(1)")
        t.check('thumb rolls square -> triangle', names(await t.collect()), ['SQUARE DOWN', 'SQUARE up', 'TRIANGLE DOWN', 'TRIANGLE up'])

        # 9. keyboard, with OS auto-repeat ignored
        await t.js("__h.key('keydown','ArrowRight'); __h.key('keydown','ArrowRight',true); __h.key('keyup','ArrowRight'); __h.key('keydown','KeyZ'); __h.key('keyup','KeyZ')")
        t.check('keyboard: arrow (repeat ignored) + Z', names(await t.collect()), ['HAT_X=1', 'HAT_X=0', 'CROSS DOWN', 'CROSS up'])

        # 10. losing focus releases everything exactly once
        await t.js("__h.down('.shoulder--l1', 1)"); await asyncio.sleep(0.05)
        await t.js("window.dispatchEvent(new Event('blur'))"); await asyncio.sleep(0.05)
        await t.js("__h.up(1)")
        t.check('blur releases held L1 once', names(await t.collect()), ['L1 DOWN', 'L1 up'])

        # 11. nothing left pressed, nothing the device would reject
        t.check('no stuck pressed styling', [await t.js("__h.pressed()")], [0])
        bad = [e for e in t.all_events if e.get('problems')]
        t.check('no event the uinput device would reject', bad, [])

        if shot:
            await t.js("__h.down('#dpad', 9, 60, 0); __h.down('.face__btn--cross', 1); __h.down('#l2', 5); window.__c=__h.centre('#rstick'); __h.down('#rstick', 4); __h.move(4, __c.x+30, __c.y-20)")
            await asyncio.sleep(0.3)
            n = await c.shot(shot)
            print('screenshot %s (%d bytes)' % (shot, n))

        failed = [r for r in t.results if not r[1]]
        print('\n%d/%d checks passed' % (len(t.results) - len(failed), len(t.results)))
        return 0 if not failed else 1

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:8901')
    ap.add_argument('--profile', default=os.path.join(tempfile.gettempdir(), 'retropie-pad-e2e-profile'))
    ap.add_argument('--shot', default='')
    a = ap.parse_args()
    sys.exit(asyncio.run(run(a.base, a.profile, a.shot)))
