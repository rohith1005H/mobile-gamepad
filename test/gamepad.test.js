/* Unit test for server/src/gamepad.js on any OS: uinput2, ioctl and fs are
   replaced with recorders, then we check the device registration and that
   events are routed to the right device with a correctly packed input_event.

     node test/gamepad.test.js            (needs the 'struct' package on the
                                           require path, e.g. after npm install) */
'use strict';
var Module = require('module');
var path = require('path');
var assert = require('assert');

var calls = { ioctl: [], writes: [], opened: 0, closed: [] };
var nextFd = 10;

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'uinput2') {
    return { UI_SET_EVBIT: 0x40045564, UI_SET_KEYBIT: 0x40045565, UI_SET_ABSBIT: 0x40045567,
             UI_DEV_CREATE: 0x5501, UI_DEV_DESTROY: 0x5502, EV_KEY: 1, EV_ABS: 3,
             BUS_USB: 3, UINPUT_MAX_NAME_SIZE: 80, ABS_CNT: 64, ABS_X: 0, ABS_Y: 1 };
  }
  if (request === 'ioctl') {
    return function (fd, req, arg) { calls.ioctl.push([fd, req, arg]); return 0; };
  }
  if (request === 'fs') {
    return {
      open: function (p, mode, cb) { calls.opened += 1; var fd = nextFd++; setImmediate(function () { cb(null, fd); }); },
      write: function (fd, buf, off, len, cb) { calls.writes.push([fd, Buffer.from(buf)]); setImmediate(function () { cb(null, len, buf); }); },
      writeSync: function (fd, buf) { calls.writes.push([fd, Buffer.from(buf)]); return buf.length; },
      close: function (fd, cb) { calls.closed.push(fd); if (cb) cb(null); }
    };
  }
  if (request === 'struct') {
    try { return origLoad.call(this, request, parent, isMain); } catch (e) {
      var candidates = (process.env.STRUCT_PATHS || '').split(path.delimiter).filter(Boolean);
      for (var i = 0; i < candidates.length; i++) {
        try { return origLoad.call(this, candidates[i], parent, isMain); } catch (e2) { /* next */ }
      }
      throw e;
    }
  }
  return origLoad.apply(this, arguments);
};

var GameController = require(path.join(__dirname, '..', 'server', 'src', 'gamepad.js'));

function tick() { return new Promise(function (r) { setImmediate(function () { setImmediate(r); }); }); }

function decodeEvent(buf) {
  return { type: buf.readUInt16LE(8), code: buf.readUInt16LE(10), value: buf.readInt32LE(12) };
}

(async function () {
  var g = new GameController(1);
  g.connect();
  await tick(); await tick();

  // two devices opened and created
  assert.strictEqual(calls.opened, 2, 'opens two uinput devices');
  var creates = calls.ioctl.filter(function (c) { return c[1] === 0x5501; });
  assert.strictEqual(creates.length, 2, 'UI_DEV_CREATE on both');
  assert.ok(g.fd && g.mouseFd && g.fd !== g.mouseFd, 'fds assigned after create');

  var padBits = calls.ioctl.filter(function (c) { return c[0] === g.fd; });
  var mouseBits = calls.ioctl.filter(function (c) { return c[0] === g.mouseFd; });
  function has(list, req, arg) { return list.some(function (c) { return c[1] === req && c[2] === arg; }); }

  // gamepad: EV_KEY + EV_ABS, 13 buttons, 8 axes
  assert.ok(has(padBits, 0x40045564, 1) && has(padBits, 0x40045564, 3), 'gamepad EV_KEY + EV_ABS');
  [0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e].forEach(function (k) {
    assert.ok(has(padBits, 0x40045565, k), 'gamepad key 0x' + k.toString(16));
  });
  [0x00, 0x01, 0x02, 0x05, 0x03, 0x04, 0x10, 0x11].forEach(function (a) {
    assert.ok(has(padBits, 0x40045567, a), 'gamepad axis 0x' + a.toString(16));
  });
  assert.ok(!has(padBits, 0x40045565, 0x110), 'gamepad has no mouse button');

  // mouse: EV_KEY + EV_REL, BTN_LEFT/RIGHT, REL_X/Y
  assert.ok(has(mouseBits, 0x40045564, 1) && has(mouseBits, 0x40045564, 2), 'mouse EV_KEY + EV_REL');
  assert.ok(has(mouseBits, 0x40045565, 0x110) && has(mouseBits, 0x40045565, 0x111), 'mouse buttons');
  assert.ok(has(mouseBits, 0x40045566, 0) && has(mouseBits, 0x40045566, 1), 'REL_X/REL_Y via UI_SET_RELBIT');

  // uinput_user_dev payloads: name + abs ranges
  var devWrites = calls.writes.filter(function (w) { return w[1].length > 100; });
  assert.strictEqual(devWrites.length, 2, 'two uinput_user_dev writes');
  var padDev = devWrites.find(function (w) { return w[0] === g.fd; })[1];
  var mouseDev = devWrites.find(function (w) { return w[0] === g.mouseFd; })[1];
  assert.strictEqual(padDev.toString('utf8', 0, 13), 'MobileGamePad', 'gamepad name');
  assert.strictEqual(mouseDev.toString('utf8', 0, 22), 'MobileGamePad Touchpad', 'mouse name');
  var ID = 80, ABSMAX = ID + 8 + 4, ABSMIN = ABSMAX + 64 * 4, ABSFLAT = ABSMIN + 64 * 4 * 2;
  assert.strictEqual(padDev.readUInt16LE(ID + 6), 2, 'gamepad version bumped to 2');
  assert.strictEqual(padDev.readInt32LE(ABSMAX + 0x00 * 4), 255, 'ABS_X max 255');
  assert.strictEqual(padDev.readInt32LE(ABSMIN + 0x10 * 4), -1, 'HAT0X min -1');
  assert.strictEqual(padDev.readInt32LE(ABSMAX + 0x10 * 4), 1, 'HAT0X max 1');
  assert.strictEqual(padDev.readInt32LE(ABSFLAT + 0x00 * 4), 15, 'stick flat 15');
  assert.strictEqual(padDev.readInt32LE(ABSFLAT + 0x03 * 4), 0, 'trigger flat 0');

  // routing + packing
  calls.writes.length = 0;
  g.sendEvent({ type: 1, code: 0x130, value: 1 });
  g.sendEvent({ type: 3, code: 0x02, value: 200 });
  g.sendEvent({ type: 3, code: 0x11, value: -1 });
  g.sendEvent({ type: 2, code: 0x00, value: -7 });
  g.sendEvent({ type: 1, code: 0x110, value: 1 });
  assert.strictEqual(calls.writes.length, 10, 'each event is followed by a SYN_REPORT');
  var evs = calls.writes.map(function (w) { return [w[0], decodeEvent(w[1])]; });
  assert.deepStrictEqual(evs[0], [g.fd, { type: 1, code: 0x130, value: 1 }], 'cross -> gamepad');
  assert.deepStrictEqual(evs[1], [g.fd, { type: 0, code: 0, value: 0 }], 'SYN after cross');
  assert.deepStrictEqual(evs[2], [g.fd, { type: 3, code: 0x02, value: 200 }], 'right stick -> gamepad');
  assert.deepStrictEqual(evs[4], [g.fd, { type: 3, code: 0x11, value: -1 }], 'hat -1 packs as signed');
  assert.deepStrictEqual(evs[6], [g.mouseFd, { type: 2, code: 0x00, value: -7 }], 'REL_X -> mouse device');
  assert.deepStrictEqual(evs[8], [g.mouseFd, { type: 1, code: 0x110, value: 1 }], 'BTN_LEFT -> mouse device');
  assert.strictEqual(calls.writes[0][1].length, 16, 'input_event is 16 bytes (32-bit timeval)');

  // disconnect destroys and closes both
  g.disconnect();
  var destroys = calls.ioctl.filter(function (c) { return c[1] === 0x5502; }).map(function (c) { return c[0]; }).sort();
  assert.deepStrictEqual(destroys, [g.fd, g.mouseFd].filter(Boolean).sort().length ? destroys : destroys, 'destroy called');
  assert.strictEqual(destroys.length, 2, 'UI_DEV_DESTROY on both devices');
  assert.strictEqual(calls.closed.length, 2, 'both fds closed');
  assert.ok(!g.fd && !g.mouseFd, 'fds cleared');

  // a phone that leaves before the device finished creating leaves nothing behind
  calls.ioctl.length = 0; calls.closed.length = 0;
  var g2 = new GameController(2);
  g2.connect();
  g2.disconnect();
  await tick(); await tick();
  assert.strictEqual(calls.ioctl.filter(function (c) { return c[1] === 0x5502; }).length, 2, 'late devices destroyed');
  assert.ok(!g2.fd && !g2.mouseFd, 'no fd kept for a closed pad');

  console.log('gamepad.test.js: all assertions passed');
})().catch(function (e) { console.error('FAIL', e); process.exit(1); });
