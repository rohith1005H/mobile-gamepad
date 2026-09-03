/* RetroPie Pad client.
   Talks the same protocol as the original client:
     socket.emit('hello')                      -> server replies 'hello' {inputId}
     socket.emit('event', {type, code, value}) -> written to the uinput device
   type 0x01 = EV_KEY (buttons), type 0x03 = EV_ABS (D-pad as ABS_X / ABS_Y, 0..255).

   Input model: every pointer is tracked individually so several fingers can
   act at once, a thumb can roll from one face button onto the next, and a
   finger that started on the D-pad keeps steering it until it lifts. */

(function () {
  'use strict';

  var EV_KEY = 0x01;
  var EV_ABS = 0x03;
  var ABS_X = 0x00;
  var ABS_Y = 0x01;
  var MID = 127, LO = 0, HI = 255;

  var pad = document.getElementById('pad');
  var dpad = document.getElementById('dpad');
  var status = document.getElementById('status');
  var statusText = document.getElementById('statusText');

  // ---------- transport ----------

  var socket = null;
  var ready = false;

  function setStatus(state, text) {
    status.dataset.state = state;
    statusText.textContent = text;
  }

  function send(type, code, value) {
    if (!ready) return;
    socket.emit('event', { type: type, code: code, value: value });
  }

  if (typeof io === 'function') {
    socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });

    socket.on('connect', function () {
      setStatus('connecting', 'Joining');
      socket.emit('hello', 'add new input');
    });

    socket.on('hello', function (data) {
      ready = true;
      setStatus('ready', 'Player ' + (data.inputId + 1));
      buzz(20);
    });

    socket.on('disconnect', function () {
      ready = false;
      releaseAll();
      setStatus('lost', 'Reconnecting');
    });

    socket.on('connect_error', function () {
      ready = false;
      setStatus('lost', 'Pi not found');
    });
  } else {
    setStatus('lost', 'No server');
  }

  // ---------- haptics ----------

  var canBuzz = 'vibrate' in navigator;
  function buzz(ms) {
    if (canBuzz) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
  }

  // ---------- buttons ----------

  var held = {};          // code -> count of pointers holding it

  function pressKey(el) {
    var code = parseInt(el.dataset.code, 16);
    held[code] = (held[code] || 0) + 1;
    if (held[code] === 1) {
      el.classList.add('is-pressed');
      send(EV_KEY, code, 1);
      buzz(10);
    }
  }

  function releaseKey(el) {
    var code = parseInt(el.dataset.code, 16);
    if (!held[code]) return;
    held[code] -= 1;
    if (held[code] === 0) {
      el.classList.remove('is-pressed');
      send(EV_KEY, code, 0);
    }
  }

  // ---------- D-pad ----------

  var dpadPointers = 0;
  var dpadDir = null;   // 'up' | 'right:up' | ... | null
  var arms = {};
  Array.prototype.forEach.call(dpad.querySelectorAll('.dpad__arm'), function (a) {
    arms[a.dataset.dir] = a;
  });

  // Cardinal sectors are wider (50°) than diagonals (40°) so a slightly
  // off-axis thumb still reads as a clean direction.
  var SECTORS = [
    ['up',         0,  25],
    ['right:up',  25,  65],
    ['right',     65, 115],
    ['right:down',115, 155],
    ['down',     155, 205],
    ['left:down',205, 245],
    ['left',     245, 295],
    ['left:up',  295, 335],
    ['up',       335, 360]
  ];

  var ARC = {   // centre angle and span of the ring highlight, degrees from up
    'up': [0, 50], 'right:up': [45, 40], 'right': [90, 50], 'right:down': [135, 40],
    'down': [180, 50], 'left:down': [225, 40], 'left': [270, 50], 'left:up': [315, 40]
  };

  var AXES = {
    'up':         [MID, LO], 'right:up':   [HI, LO], 'right': [HI, MID], 'right:down': [HI, HI],
    'down':       [MID, HI], 'left:down':  [LO, HI], 'left':  [LO, MID], 'left:up':    [LO, LO]
  };

  function dirFromPoint(x, y) {
    var r = dpad.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = x - cx, dy = y - cy;
    var dist = Math.hypot(dx, dy);
    if (dist < r.width * 0.09) return null;                 // resting on the hub
    var deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360; // 0 = up, clockwise
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

    var axes = dir ? AXES[dir] : [MID, MID];
    send(EV_ABS, ABS_X, axes[0]);
    send(EV_ABS, ABS_Y, axes[1]);
  }

  // ---------- pointer routing ----------

  var pointers = {};   // pointerId -> { kind: 'dpad' } | { kind: 'key', el }

  function keyAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return el ? el.closest('.key') : null;
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    unlockScreen();

    if (dpad.contains(e.target)) {
      pointers[e.pointerId] = { kind: 'dpad' };
      dpadPointers += 1;
      setDir(dirFromPoint(e.clientX, e.clientY));
      return;
    }

    var key = keyAt(e.clientX, e.clientY);
    pointers[e.pointerId] = { kind: 'key', el: key };
    if (key) pressKey(key);
  }

  function onMove(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    e.preventDefault();

    if (p.kind === 'dpad') {
      setDir(dirFromPoint(e.clientX, e.clientY));
      return;
    }

    var key = keyAt(e.clientX, e.clientY);
    if (key !== p.el) {
      if (p.el) releaseKey(p.el);
      if (key) pressKey(key);
      p.el = key;
    }
  }

  function onUp(e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    delete pointers[e.pointerId];

    if (p.kind === 'dpad') {
      dpadPointers = Math.max(0, dpadPointers - 1);
      if (dpadPointers === 0) setDir(null);
      return;
    }
    if (p.el) releaseKey(p.el);
  }

  function releaseAll() {
    Object.keys(pointers).forEach(function (id) {
      var p = pointers[id];
      if (p.kind === 'key' && p.el) releaseKey(p.el);
    });
    pointers = {};
    dpadPointers = 0;
    setDir(null);
  }

  pad.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });

  // Block the browser gestures that fight a gamepad: long-press menu,
  // double-tap zoom, pinch, pull-to-refresh.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  // ---------- screen: fullscreen, landscape lock, stay awake ----------

  var unlocked = false;
  var wakeLock = null;

  function unlockScreen() {
    if (unlocked) return;
    unlocked = true;
    var root = document.documentElement;
    try {
      if (root.requestFullscreen && !document.fullscreenElement) {
        root.requestFullscreen({ navigationUI: 'hide' }).catch(function () {});
      }
    } catch (e) { /* not supported */ }
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(function () {});
      }
    } catch (e) { /* not supported */ }
    requestWakeLock();
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && unlocked && !wakeLock) requestWakeLock();
    if (document.hidden) wakeLock = null;
  });
})();
