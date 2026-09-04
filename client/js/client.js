/* RetroPie Pad client — DualSense layout.

   Wire protocol is the original one: on connect the client emits 'hello', the
   server answers 'hello' {inputId}, and every input is
     socket.emit('event', {type, code, value})
   with Linux input codes, written straight to the uinput device on the Pi.

     face / bumpers / Create / Options / PS / L3 / R3   EV_KEY  code, 1|0
     left stick  ABS_X  0x00 / ABS_Y  0x01               EV_ABS  0..255, centre 128
     right stick ABS_Z  0x02 / ABS_RZ 0x05               EV_ABS  0..255, centre 128
     L2 / R2     ABS_RX 0x03 / ABS_RY 0x04 (analog)      EV_ABS  0..255
                 + BTN_TL2 / BTN_TR2 (digital) once the pull passes half
     D-pad       ABS_HAT0X 0x10 / ABS_HAT0Y 0x11          EV_ABS  -1 | 0 | 1
     touchpad    REL_X / REL_Y                            EV_REL  pointer deltas
                 BTN_LEFT 0x110 / BTN_RIGHT 0x111         EV_KEY  tap / two-finger tap
   The server routes the touchpad events to a second, mouse-class uinput device.

   Input model: every pointer is tracked individually, so several fingers act
   at once, a thumb can roll from one face button to the next, a finger that
   starts on a stick, trigger, touchpad or the D-pad keeps steering it until
   it lifts, and nothing a finger is holding can get stuck. */

(function () {
  'use strict';

  var EV_KEY = 0x01, EV_REL = 0x02, EV_ABS = 0x03;
  var ABS_HAT0X = 0x10, ABS_HAT0Y = 0x11;
  var REL_X = 0x00, REL_Y = 0x01;
  var BTN_LEFT = 0x110, BTN_RIGHT = 0x111;
  var CENTRE = 128;

  var pad = document.getElementById('pad');
  var dpad = document.getElementById('dpad');
  var touchpad = document.getElementById('touchpad');
  var status = document.getElementById('status');
  var statusText = document.getElementById('statusText');

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ---------- transport ----------

  var socket = null;
  var ready = false;
  var helloTimer = null;
  var retryTimer = null;

  function setStatus(state, text) {
    status.dataset.state = state;
    statusText.textContent = text;
  }

  function send(type, code, value) {
    if (!ready) return;
    socket.emit('event', { type: type, code: code, value: value });
  }

  // The Pi answers 'hello' only when a pad slot is free. If nothing comes back
  // we retry with a full reconnect: a second 'hello' on the same socket would
  // take another slot on the Pi and never give it back.
  function armHello() {
    clearTimeout(helloTimer);
    helloTimer = setTimeout(function () {
      if (ready || !socket.connected) return;
      setStatus('lost', 'Pi is full, retrying');
      retrySlot();
    }, 5000);
  }

  function retrySlot() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      if (ready) return;
      socket.disconnect();
      socket.connect();
    }, 3000);
  }

  if (typeof io === 'function') {
    socket = io({ reconnection: true, reconnectionDelay: 1500, reconnectionDelayMax: 5000, rememberUpgrade: true });

    socket.on('connect', function () {
      ready = false;
      setStatus('connecting', 'Joining');
      socket.emit('hello', 'add new input');
      armHello();
    });

    socket.on('hello', function (data) {
      clearTimeout(helloTimer);
      var id = data && data.inputId;
      if (typeof id !== 'number' || id < 1 || id >= 500) {
        ready = false;
        setStatus('lost', 'Pi error, retrying');
        retrySlot();
        return;
      }
      // Give the Pi a moment to finish creating the device, then push our real
      // state: a fresh uinput device sits at axis value 0 (up-left) until told.
      setTimeout(function () {
        if (!socket.connected) return;
        ready = true;
        setStatus('ready', 'Player ' + id);
        syncState();
        buzz(20);
      }, 150);
    });

    socket.on('disconnect', function () {
      ready = false;
      clearTimeout(helloTimer);
      setStatus('lost', 'Reconnecting');
    });

    socket.on('connect_error', function () {
      ready = false;
      setStatus('lost', 'Reconnecting');
    });
  } else {
    setStatus('lost', 'Reload page');
  }

  // Everything the pad is currently doing, replayed onto a fresh device.
  function syncState() {
    sticks.forEach(function (s) { send(EV_ABS, s.cx, s.vx); send(EV_ABS, s.cy, s.vy); });
    triggers.forEach(function (t) { send(EV_ABS, t.axis, t.value); });
    send(EV_ABS, ABS_HAT0X, hatX);
    send(EV_ABS, ABS_HAT0Y, hatY);
    Object.keys(held).forEach(function (c) { if (held[c] > 0) send(EV_KEY, parseInt(c, 10), 1); });
  }

  // ---------- haptics ----------

  var canBuzz = 'vibrate' in navigator;
  function buzz(ms) {
    if (canBuzz) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
  }

  // ---------- buttons ----------

  var held = {};          // code -> number of fingers/keys holding it

  function codeOf(el) { return parseInt(el.dataset.code, 16); }

  function pressCode(code) {
    held[code] = (held[code] || 0) + 1;
    if (held[code] !== 1) return false;
    send(EV_KEY, code, 1);
    return true;
  }

  function releaseCode(code) {
    if (!held[code]) return false;
    held[code] -= 1;
    if (held[code] !== 0) return false;
    send(EV_KEY, code, 0);
    return true;
  }

  function pressKey(el) {
    if (pressCode(codeOf(el))) { el.classList.add('is-pressed'); buzz(10); }
  }

  function releaseKey(el) {
    if (releaseCode(codeOf(el))) el.classList.remove('is-pressed');
  }

  function keyByCode(code) {
    return pad.querySelector('.key[data-code="0x' + code.toString(16) + '"]');
  }

  // ---------- D-pad (hat) ----------

  var dpadRect = null;
  var dpadPointers = 0;
  var dpadDir = null;      // 'up' | 'right:up' | ... | null
  var hatX = 0, hatY = 0;
  var arms = {};
  Array.prototype.forEach.call(dpad.querySelectorAll('.dpad__arm'), function (a) { arms[a.dataset.dir] = a; });

  // Cardinal sectors are wider (50°) than diagonals (40°) so a slightly
  // off-axis thumb still reads as a clean direction.
  var SECTORS = [
    ['up',          0,  25], ['right:up',  25,  65], ['right',     65, 115], ['right:down', 115, 155],
    ['down',      155, 205], ['left:down', 205, 245], ['left',     245, 295], ['left:up',    295, 335],
    ['up',        335, 360]
  ];
  var ARC = {   // centre angle and span of the ring highlight, degrees from up
    'up': [0, 50], 'right:up': [45, 40], 'right': [90, 50], 'right:down': [135, 40],
    'down': [180, 50], 'left:down': [225, 40], 'left': [270, 50], 'left:up': [315, 40]
  };
  var HAT = {
    'up': [0, -1], 'right:up': [1, -1], 'right': [1, 0], 'right:down': [1, 1],
    'down': [0, 1], 'left:down': [-1, 1], 'left': [-1, 0], 'left:up': [-1, -1]
  };
  var HYST_DEG = 4, DEAD_IN = 0.09, DEAD_OUT = 0.06;

  function inSector(dir, deg, grace) {
    for (var i = 0; i < SECTORS.length; i++) {
      var s = SECTORS[i];
      if (s[0] !== dir) continue;
      var a = s[1] - grace, b = s[2] + grace;
      if (deg >= a && deg < b) return true;
      if (a < 0 && deg >= a + 360) return true;
      if (b > 360 && deg < b - 360) return true;
    }
    return false;
  }

  function dirFromPoint(x, y) {
    var r = dpadRect || (dpadRect = dpad.getBoundingClientRect());
    var dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    var dist = Math.hypot(dx, dy);
    if (dist < r.width * (dpadDir ? DEAD_OUT : DEAD_IN)) return null;   // resting on the hub
    var deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;        // 0 = up, clockwise
    if (dpadDir && inSector(dpadDir, deg, HYST_DEG)) return dpadDir;    // a resting thumb does not chatter
    for (var i = 0; i < SECTORS.length; i++) {
      if (deg >= SECTORS[i][1] && deg < SECTORS[i][2]) return SECTORS[i][0];
    }
    return 'up';
  }

  function setDir(dir) {
    if (dir === dpadDir) return;
    dpadDir = dir;

    Object.keys(arms).forEach(function (k) { arms[k].classList.remove('is-pressed'); });
    if (dir) {
      dir.split(':').forEach(function (k) { arms[k].classList.add('is-pressed'); });
      dpad.style.setProperty('--a', ARC[dir][0] + 'deg');
      dpad.style.setProperty('--s', ARC[dir][1] + 'deg');
      dpad.classList.add('is-active');
      buzz(6);
    } else {
      dpad.classList.remove('is-active');
    }

    var h = dir ? HAT[dir] : [0, 0];
    if (h[0] !== hatX) { hatX = h[0]; send(EV_ABS, ABS_HAT0X, hatX); }
    if (h[1] !== hatY) { hatY = h[1]; send(EV_ABS, ABS_HAT0Y, hatY); }
  }

  // ---------- analog sticks ----------

  var sticks = Array.prototype.map.call(document.querySelectorAll('.stick'), function (el) {
    return {
      el: el, knob: el.querySelector('.stick__knob'),
      cx: parseInt(el.dataset.x, 16), cy: parseInt(el.dataset.y, 16), click: parseInt(el.dataset.click, 16),
      vx: CENTRE, vy: CENTRE, rect: null, pointers: 0
    };
  });

  function stickFor(target) {
    var el = target.closest ? target.closest('.stick') : null;
    for (var i = 0; el && i < sticks.length; i++) if (sticks[i].el === el) return sticks[i];
    return null;
  }

  function setAxis(o, key, code, v) {
    if (o[key] === v) return;
    o[key] = v;
    send(EV_ABS, code, v);
  }

  function stickStart(s, p, x, y) {
    s.pointers += 1;
    if (s.pointers === 1) s.rect = s.el.getBoundingClientRect();
    s.el.classList.add('is-active');
    stickMove(s, p, x, y);
  }

  function stickMove(s, p, x, y) {
    var r = s.rect, R = r.width * 0.3;                 // knob travel radius
    var dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    var d = Math.hypot(dx, dy);
    if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > 10) p.moved = true;
    if (d > R) { dx *= R / d; dy *= R / d; }
    if (!p.moved && d < R * 0.35) { dx = 0; dy = 0; }  // a tap near the centre is a click, not a nudge
    s.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    setAxis(s, 'vx', s.cx, clamp(Math.round(CENTRE + dx / R * 128), 0, 255));
    setAxis(s, 'vy', s.cy, clamp(Math.round(CENTRE + dy / R * 128), 0, 255));
  }

  function stickEnd(s, p) {
    s.pointers = Math.max(0, s.pointers - 1);
    if (s.pointers) return;
    s.el.classList.remove('is-active');
    s.knob.style.transform = '';
    setAxis(s, 'vx', s.cx, CENTRE);
    setAxis(s, 'vy', s.cy, CENTRE);
    if (!p.moved && now() - p.t0 < 250) clickStick(s);
  }

  function clickStick(s) {
    s.el.classList.add('is-clicked');
    pressCode(s.click);
    buzz(12);
    setTimeout(function () { releaseCode(s.click); s.el.classList.remove('is-clicked'); }, 70);
  }

  // ---------- analog triggers ----------
  // A touch is a full pull; slide along the bar to feather it (outer edge = 0,
  // inner edge = full). The digital bumper code fires past half pull.

  var triggers = Array.prototype.map.call(document.querySelectorAll('.trigger'), function (el) {
    return {
      el: el, id: el.id, axis: parseInt(el.dataset.axis, 16), code: parseInt(el.dataset.code, 16),
      outer: el.classList.contains('trigger--l2') ? 'left' : 'right',
      value: 0, on: false, rect: null, pointers: 0
    };
  });

  function triggerFor(target) {
    var el = target.closest ? target.closest('.trigger') : null;
    for (var i = 0; el && i < triggers.length; i++) if (triggers[i].el === el) return triggers[i];
    return null;
  }

  function triggerById(id) {
    for (var i = 0; i < triggers.length; i++) if (triggers[i].id === id) return triggers[i];
    return null;
  }

  function setTrigger(t, v) {
    if (v === t.value) return;
    t.value = v;
    t.el.style.setProperty('--v', (v / 255).toFixed(3));
    t.el.setAttribute('aria-valuenow', v);
    send(EV_ABS, t.axis, v);
    var on = v >= 128;
    if (on !== t.on) {
      t.on = on;
      t.el.classList.toggle('is-on', on);
      if (on) { pressCode(t.code); buzz(8); } else { releaseCode(t.code); }
    }
  }

  function trigStart(t) {
    t.pointers += 1;
    if (t.pointers === 1) t.rect = t.el.getBoundingClientRect();
    t.el.classList.add('is-active');
    setTrigger(t, 255);
  }

  function trigMove(t, p, x) {
    if (!p.moved && Math.abs(x - p.x0) > 8) p.moved = true;
    if (!p.moved) return;
    var r = t.rect;
    var f = t.outer === 'left' ? (x - r.left) / r.width : (r.right - x) / r.width;
    setTrigger(t, Math.round(clamp(f, 0, 1) * 255));
  }

  function trigEnd(t) {
    t.pointers = Math.max(0, t.pointers - 1);
    if (t.pointers) return;
    t.el.classList.remove('is-active');
    setTrigger(t, 0);
  }

  // ---------- touchpad ----------

  var padPointers = 0;
  var PAD_SCALE = 1.6;
  var lastRightClick = 0;

  function padStart(p) {
    padPointers += 1;
    touchpad.classList.add('is-active');
    if (padPointers > 1) {
      Object.keys(pointers).forEach(function (id) { if (pointers[id].kind === 'pad') pointers[id].two = true; });
    }
  }

  function padMove(p, x, y) {
    var dx = (x - p.x) * PAD_SCALE, dy = (y - p.y) * PAD_SCALE;
    p.x = x; p.y = y;
    if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > 8) p.moved = true;
    p.ax += dx; p.ay += dy;
    var ix = p.ax < 0 ? Math.ceil(p.ax) : Math.floor(p.ax);
    var iy = p.ay < 0 ? Math.ceil(p.ay) : Math.floor(p.ay);
    p.ax -= ix; p.ay -= iy;
    if (ix) send(EV_REL, REL_X, ix);
    if (iy) send(EV_REL, REL_Y, iy);
  }

  function padEnd(p) {
    padPointers = Math.max(0, padPointers - 1);
    if (!padPointers) touchpad.classList.remove('is-active');
    if (p.moved || now() - p.t0 > 250) return;
    if (p.two) {
      if (now() - lastRightClick < 400) return;       // one click per two-finger tap
      lastRightClick = now();
      clickPad(BTN_RIGHT);
    } else {
      clickPad(BTN_LEFT);
    }
  }

  function clickPad(btn) {
    touchpad.classList.add('is-click');
    pressCode(btn);
    buzz(10);
    setTimeout(function () { releaseCode(btn); touchpad.classList.remove('is-click'); }, 60);
  }

  // ---------- pointer routing ----------

  var pointers = {};   // pointerId -> { kind: 'key'|'dpad'|'stick'|'trigger'|'pad', ... }
  var RAW = 'onpointerrawupdate' in window;   // steer at input rate, not frame rate, where available

  function keyAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return el ? el.closest('.key') : null;
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers[e.pointerId]) onUp(e);               // close an orphaned sequence first
    e.preventDefault();
    if (e.pointerType === 'mouse') unlockScreen();

    var t = e.target, x = e.clientX, y = e.clientY;
    var p = { kind: 'key', el: null, t0: now(), x0: x, y0: y, x: x, y: y, ax: 0, ay: 0, moved: false, two: false };
    pointers[e.pointerId] = p;

    var s = stickFor(t);
    if (s) { p.kind = 'stick'; p.s = s; stickStart(s, p, x, y); return; }

    var tr = triggerFor(t);
    if (tr) { p.kind = 'trigger'; p.t = tr; trigStart(tr); return; }

    if (touchpad.contains(t)) { p.kind = 'pad'; padStart(p); return; }

    if (dpad.contains(t)) {
      p.kind = 'dpad';
      dpadPointers += 1;
      if (dpadPointers === 1) dpadRect = dpad.getBoundingClientRect();
      setDir(dirFromPoint(x, y));
      return;
    }

    p.el = keyAt(x, y);
    if (p.el) pressKey(p.el);
  }

  function onMove(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    var raw = e.type === 'pointerrawupdate';

    if (p.kind === 'key') {                            // button rolling: frame rate is plenty
      if (raw) return;
      var k = keyAt(e.clientX, e.clientY);
      if (k !== p.el) {
        if (p.el) releaseKey(p.el);
        if (k) pressKey(k);
        p.el = k;
      }
      return;
    }

    if (RAW && !raw) return;                           // continuous controls already steered at raw rate
    switch (p.kind) {
      case 'stick':   stickMove(p.s, p, e.clientX, e.clientY); break;
      case 'trigger': trigMove(p.t, p, e.clientX); break;
      case 'pad':     padMove(p, e.clientX, e.clientY); break;
      case 'dpad':    setDir(dirFromPoint(e.clientX, e.clientY)); break;
    }
  }

  function onUp(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    delete pointers[e.pointerId];

    switch (p.kind) {
      case 'stick':   stickEnd(p.s, p); break;
      case 'trigger': trigEnd(p.t); break;
      case 'pad':     padEnd(p); break;
      case 'dpad':
        dpadPointers = Math.max(0, dpadPointers - 1);
        if (!dpadPointers) setDir(kbDir());
        break;
      default:
        if (p.el) releaseKey(p.el);
    }

    // A touch pointerup carries user activation; pointerdown does not.
    if (e.type === 'pointerup' && e.pointerType !== 'mouse') unlockScreen();
  }

  function releaseAll() {
    Object.keys(pointers).forEach(function (id) {
      pointers[id].moved = true;                       // never turn a cancelled touch into a click
      onUp({ pointerId: id, type: 'pointercancel', pointerType: 'touch' });
    });
    pointers = {};
    kbDown = {};
    kbDirs = {};
    dpadPointers = 0;
    padPointers = 0;
    touchpad.classList.remove('is-active');
    sticks.forEach(function (s) { s.pointers = 0; stickEnd(s, { moved: true, t0: 0 }); });
    triggers.forEach(function (t) { t.pointers = 0; trigEnd(t); });
    setDir(null);
    Object.keys(held).forEach(function (c) {          // belt and braces: nothing stays down
      if (held[c]) { held[c] = 0; send(EV_KEY, parseInt(c, 10), 0); }
    });
    Array.prototype.forEach.call(pad.querySelectorAll('.key.is-pressed'), function (el) { el.classList.remove('is-pressed'); });
  }

  function invalidateRects() {
    dpadRect = dpadPointers ? dpad.getBoundingClientRect() : null;
    sticks.forEach(function (s) { if (s.pointers) s.rect = s.el.getBoundingClientRect(); });
    triggers.forEach(function (t) { if (t.pointers) t.rect = t.el.getBoundingClientRect(); });
  }

  pad.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  if (RAW) window.addEventListener('pointerrawupdate', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', releaseAll);
  window.addEventListener('resize', invalidateRects);
  window.addEventListener('orientationchange', invalidateRects);
  document.addEventListener('fullscreenchange', invalidateRects);

  var portrait = window.matchMedia ? window.matchMedia('(orientation: portrait)') : null;
  if (portrait) {
    var onOrient = function (ev) { if (ev.matches) releaseAll(); invalidateRects(); };
    if (portrait.addEventListener) portrait.addEventListener('change', onOrient); else portrait.addListener(onOrient);
  }

  // Block the browser gestures that fight a gamepad: long-press menu,
  // double-tap zoom, pinch, pull-to-refresh (touch-action:none covers modern
  // browsers; the touchmove listener covers the rest).
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

  // ---------- keyboard (desktop testing, accessibility) ----------
  // Arrows = D-pad · Z ✕ · X ○ · A □ · S △ · Q L1 · R R1 · W L2 · E R2
  // Enter Options · Backspace / right Shift Create · P PS · C L3 · V R3

  var KEYMAP = { KeyZ: 0x130, KeyX: 0x131, KeyS: 0x133, KeyA: 0x134, KeyQ: 0x136, KeyR: 0x137,
                 Enter: 0x13b, Backspace: 0x13a, ShiftRight: 0x13a, KeyP: 0x13c, KeyC: 0x13d, KeyV: 0x13e };
  var KEYDIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  var KEYTRIG = { KeyW: 'l2', KeyE: 'r2' };
  var kbDown = {};     // e.code -> element | true, so OS auto-repeat can never double-count
  var kbDirs = {};

  function kbDir() {
    var v = kbDirs.up ? 'up' : kbDirs.down ? 'down' : null;
    var h = kbDirs.left ? 'left' : kbDirs.right ? 'right' : null;
    return h && v ? h + ':' + v : (h || v);
  }

  document.addEventListener('keydown', function (e) {
    if (e.repeat || kbDown[e.code]) return;
    var code = e.code;
    if (KEYDIRS[code]) {
      kbDown[code] = true;
      kbDirs[KEYDIRS[code]] = true;
      if (!dpadPointers) setDir(kbDir());
    } else if (KEYTRIG[code]) {
      kbDown[code] = true;
      var t = triggerById(KEYTRIG[code]);
      if (t) setTrigger(t, 255);
    } else if (KEYMAP[code] !== undefined) {
      var el = keyByCode(KEYMAP[code]);
      kbDown[code] = el || true;
      if (el) pressKey(el); else pressCode(KEYMAP[code]);
    } else {
      return;
    }
    e.preventDefault();
    unlockScreen();
  });

  document.addEventListener('keyup', function (e) {
    var h = kbDown[e.code];
    if (!h) return;
    delete kbDown[e.code];
    if (KEYDIRS[e.code]) {
      delete kbDirs[KEYDIRS[e.code]];
      if (!dpadPointers) setDir(kbDir());
    } else if (KEYTRIG[e.code]) {
      var t = triggerById(KEYTRIG[e.code]);
      if (t && !t.pointers) setTrigger(t, 0);
    } else if (h === true) {
      releaseCode(KEYMAP[e.code]);
    } else {
      releaseKey(h);
    }
  });

  // ---------- screen: fullscreen, landscape lock, stay awake ----------

  var unlocked = false, unlocking = false, unlockTries = 0;

  function lockLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape').catch(function () {});
    } catch (e) { /* not supported */ }
    return Promise.resolve();
  }

  function unlockScreen() {
    startKeepAwake();
    if (unlocked || unlocking || unlockTries >= 3) return;
    var root = document.documentElement;
    var req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) { unlockTries = 3; lockLandscape(); return; }     // iPhone: no fullscreen API, add to Home Screen instead
    unlocking = true;
    unlockTries += 1;
    var p;
    try { p = req.call(root, { navigationUI: 'hide' }); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p)
      .then(function () { unlocked = true; return lockLandscape(); })
      .catch(function () {})
      .then(function () { unlocking = false; });
  }

  // Screen Wake Lock only exists on https; on the plain-http LAN address we
  // play a tiny muted looping video instead (the NoSleep.js technique).
  var wakeLock = null, noSleepVideo = null, keepAwake = false;

  function startKeepAwake() {
    keepAwake = true;
    if ('wakeLock' in navigator) { requestWakeLock(); return; }
    var media = window.NOSLEEP_MEDIA;
    if (!media) return;
    if (!noSleepVideo) {
      var v = document.createElement('video');
      v.setAttribute('muted', ''); v.muted = true;
      v.setAttribute('playsinline', ''); v.setAttribute('loop', '');
      v.setAttribute('aria-hidden', 'true'); v.setAttribute('title', 'keep awake');
      v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;pointer-events:none;';
      ['webm', 'mp4'].forEach(function (k) {
        if (!media[k]) return;
        var src = document.createElement('source'); src.src = media[k]; src.type = 'video/' + k; v.appendChild(src);
      });
      v.addEventListener('timeupdate', function () { if (v.currentTime > 0.5) v.currentTime = Math.random(); });
      document.body.appendChild(v);
      noSleepVideo = v;
    }
    var pr = noSleepVideo.play();
    if (pr && pr.catch) pr.catch(function () {});
  }

  function requestWakeLock() {
    if (wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      releaseAll();
      if (noSleepVideo) noSleepVideo.pause();
    } else if (keepAwake) {
      startKeepAwake();
    }
  });
})();
