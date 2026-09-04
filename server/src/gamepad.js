var uinput = require('uinput2');
var fs = require('fs');
var ioctl = require('ioctl');
var Struct = require('struct');

/* One phone = two uinput devices:
     "MobileGamePad"           a DualSense-shaped gamepad: 13 buttons, two sticks,
                               two analog triggers and a hat-switch D-pad
     "MobileGamePad Touchpad"  a mouse (REL_X/REL_Y + left/right button) fed by
                               the phone's on-screen touchpad
   The client sends plain Linux input events ({type, code, value}); sendEvent()
   routes relative-motion and mouse-button events to the touchpad device and
   everything else to the gamepad. Codes are written numerically below so we do
   not depend on which constants a given uinput2 build exports. */

var EV_SYN = 0x00, EV_KEY = 0x01, EV_REL = 0x02, EV_ABS = 0x03;

var GAMEPAD_KEYS = [
  0x130, // BTN_SOUTH  Cross
  0x131, // BTN_EAST   Circle
  0x133, // BTN_NORTH  Triangle
  0x134, // BTN_WEST   Square
  0x136, // BTN_TL     L1
  0x137, // BTN_TR     R1
  0x138, // BTN_TL2    L2 (digital half of the analog trigger)
  0x139, // BTN_TR2    R2
  0x13a, // BTN_SELECT Create
  0x13b, // BTN_START  Options
  0x13c, // BTN_MODE   PS
  0x13d, // BTN_THUMBL L3
  0x13e  // BTN_THUMBR R3
];

// [code, min, max, flat]
var GAMEPAD_AXES = [
  [0x00, 0, 255, 15],   // ABS_X     left stick X
  [0x01, 0, 255, 15],   // ABS_Y     left stick Y
  [0x02, 0, 255, 15],   // ABS_Z     right stick X
  [0x05, 0, 255, 15],   // ABS_RZ    right stick Y
  [0x03, 0, 255, 0],    // ABS_RX    L2 pull
  [0x04, 0, 255, 0],    // ABS_RY    R2 pull
  [0x10, -1, 1, 0],     // ABS_HAT0X D-pad left/right
  [0x11, -1, 1, 0]      // ABS_HAT0Y D-pad up/down
];

var MOUSE_KEYS = [0x110, 0x111];   // BTN_LEFT, BTN_RIGHT
var MOUSE_RELS = [0x00, 0x01];     // REL_X, REL_Y

// ioctl request numbers, in case the uinput2 build lacks the names.
var UI_SET_EVBIT  = uinput.UI_SET_EVBIT  || 0x40045564;
var UI_SET_KEYBIT = uinput.UI_SET_KEYBIT || 0x40045565;
var UI_SET_RELBIT = uinput.UI_SET_RELBIT || 0x40045566;
var UI_SET_ABSBIT = uinput.UI_SET_ABSBIT || 0x40045567;
var UI_DEV_CREATE  = uinput.UI_DEV_CREATE  || 0x5501;
var UI_DEV_DESTROY = uinput.UI_DEV_DESTROY || 0x5502;
var BUS_USB = uinput.BUS_USB || 0x03;
var UINPUT_MAX_NAME_SIZE = uinput.UINPUT_MAX_NAME_SIZE || 80;
var ABS_CNT = uinput.ABS_CNT || 0x40;

function userDevBuffer(name, product, version, axes) {
  var input_id = Struct()
    .word16Ule('bustype')
    .word16Ule('vendor')
    .word16Ule('product')
    .word16Ule('version');

  var uinput_user_dev = Struct()
    .chars('name', UINPUT_MAX_NAME_SIZE)
    .struct('id', input_id)
    .word32Ule('ff_effects_max')
    .array('absmax', ABS_CNT, 'word32Sle')
    .array('absmin', ABS_CNT, 'word32Sle')
    .array('absfuzz', ABS_CNT, 'word32Sle')
    .array('absflat', ABS_CNT, 'word32Sle');

  uinput_user_dev.allocate();
  var buffer = uinput_user_dev.buffer();
  var uidev = uinput_user_dev.fields;
  buffer.fill(0);

  uidev.name = name;
  uidev.id.bustype = BUS_USB;
  uidev.id.vendor = 0x5;
  uidev.id.product = product;
  uidev.id.version = version;
  axes.forEach(function (a) {
    uidev.absmin[a[0]] = a[1];
    uidev.absmax[a[0]] = a[2];
    uidev.absfuzz[a[0]] = 0;
    uidev.absflat[a[0]] = a[3];
  });
  return buffer;
}

function eventBuffer(type, code, value) {
  var input_event = Struct()
    .struct('time', Struct()
      .word32Sle('tv_sec')
      .word32Sle('tv_usec')
    )
    .word16Ule('type')
    .word16Ule('code')
    .word32Sle('value');

  input_event.allocate();
  var buffer = input_event.buffer();
  var ev = input_event.fields;
  var ms = Date.now();
  ev.type = type;
  ev.code = code;
  ev.value = value;
  ev.time.tv_sec = Math.round(ms / 1000);
  ev.time.tv_usec = Math.round(ms % 1000 * 1000);
  return buffer;
}

module.exports = class GameController {

  constructor (inputId) {
    this.inputId = inputId;
    this.fd = undefined;        // gamepad device
    this.mouseFd = undefined;   // touchpad (mouse) device
    this.closed = false;
  }

  connect () {
    console.log('connect gamepad ' + this.inputId);
    var self = this;

    this.openDevice({
      name: 'MobileGamePad',
      product: 0x5,
      version: 2,             // new layout -> new controller identity, so RetroPie asks to map it afresh
      bits: [[UI_SET_EVBIT, EV_KEY], [UI_SET_EVBIT, EV_ABS]]
        .concat(GAMEPAD_KEYS.map(function (k) { return [UI_SET_KEYBIT, k]; }))
        .concat(GAMEPAD_AXES.map(function (a) { return [UI_SET_ABSBIT, a[0]]; })),
      axes: GAMEPAD_AXES
    }, function (fd) { self.fd = fd; });

    this.openDevice({
      name: 'MobileGamePad Touchpad',
      product: 0x6,
      version: 1,
      bits: [[UI_SET_EVBIT, EV_KEY], [UI_SET_EVBIT, EV_REL]]
        .concat(MOUSE_KEYS.map(function (k) { return [UI_SET_KEYBIT, k]; }))
        .concat(MOUSE_RELS.map(function (r) { return [UI_SET_RELBIT, r]; })),
      axes: []
    }, function (fd) { self.mouseFd = fd; });
  }

  openDevice (spec, onReady) {
    var self = this;
    fs.open('/dev/uinput', 'w+', function (err, fd) {
      if (err) {
        console.log(err);
        throw (err);
      }
      spec.bits.forEach(function (b) { ioctl(fd, b[0], b[1]); });

      var buffer = userDevBuffer(spec.name, spec.product, spec.version, spec.axes);
      fs.write(fd, buffer, 0, buffer.length, function (err2) {
        if (err2) {
          console.log(err2);
          throw (err2);
        }
        ioctl(fd, UI_DEV_CREATE);
        if (self.closed) {                       // the phone left before we finished
          GameController.destroy(fd);
          return;
        }
        onReady(fd);
      });
    });
  }

  static destroy (fd) {
    ioctl(fd, UI_DEV_DESTROY);
    fs.close(fd, function (err) {
      if (err) {
        console.error('error closing uinput device', err);
      }
    });
  }

  disconnect () {
    this.closed = true;
    if (this.fd) { GameController.destroy(this.fd); this.fd = undefined; }
    if (this.mouseFd) { GameController.destroy(this.mouseFd); this.mouseFd = undefined; }
    return null;
  }

  static isMouseEvent (event) {
    return event.type === EV_REL || (event.type === EV_KEY && MOUSE_KEYS.indexOf(event.code) !== -1);
  }

  sendEvent (event) {
    var fd = GameController.isMouseEvent(event) ? this.mouseFd : this.fd;
    if (!fd) return null;
    fs.writeSync(fd, eventBuffer(event.type, event.code, event.value));
    fs.writeSync(fd, eventBuffer(EV_SYN, 0, 0));
    return null;
  }

};
