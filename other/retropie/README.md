# RetroPie setup

The phone shows up on the Pi as two Linux input devices, created by `server/src/gamepad.js`
through `/dev/uinput` the moment a phone connects:

| Device | What it is | Identity |
|---|---|---|
| `MobileGamePad` | DualSense-shaped gamepad: 13 buttons, two sticks, two analog triggers, hat-switch D-pad | bus 3, vendor 5, product 5, **version 2** |
| `MobileGamePad Touchpad` | mouse fed by the on-screen touchpad (REL_X/REL_Y, left/right click) | bus 3, vendor 5, product 6, version 1 |

The version bump to 2 makes RetroPie treat this layout as a new controller, so any mapping made
for the old layout no longer applies. Install the two configs below instead of running the
EmulationStation "Configure Input" wizard.

## Install (on the Pi)

```bash
cd ~/mobile-gamepad
bash other/retropie/install.sh
```

The script:

1. copies [`MobileGamePad.cfg`](MobileGamePad.cfg) to `/opt/retropie/configs/all/retroarch-joypads/`
   (in-game buttons and hotkeys for every RetroArch core);
2. inserts [`es_input-MobileGamePad.xml`](es_input-MobileGamePad.xml) into `~/.emulationstation/es_input.cfg`,
   replacing any older `MobileGamePad` block and leaving keyboard and other pads alone;
3. restarts EmulationStation without a reboot (it reads `es_input.cfg` only at start-up).

Everything it overwrites gets a `.bak-<timestamp>` copy next to the original. Re-running it is safe.

Do not run EmulationStation's **Configure Input** wizard for this pad: the wizard regenerates
`retroarch-joypads/MobileGamePad.cfg` from whatever you pressed and breaks the in-game layout.
If you did, just run `install.sh` again.

## What the buttons do

EmulationStation menus:

| Pad | EmulationStation |
|---|---|
| D-pad | move |
| Circle | confirm / launch (`a`) |
| Cross | back (`b`) |
| Triangle, Square | `x`, `y` |
| L1 / R1 | previous / next system, page in lists |
| Create | options popup (`select`) |
| Options | main menu (`start`) |

RetroArch, from `MobileGamePad.cfg` (Create is the hotkey):

| Combo | Action |
|---|---|
| Create + Options | exit the emulator |
| Create + Triangle | RetroArch menu |
| Create + L1 / R1 | load / save state |
| Create + left stick left / right | state slot down / up |
| Create + Cross | reset |

Circle is A and Cross is B in both, matching RetroArch's own defaults, so menus feel the same in
and out of games. To swap them, exchange the `id` of `a` and `b` in `es_input-MobileGamePad.xml`
and `input_a_btn` / `input_b_btn` in `MobileGamePad.cfg`, then re-run `install.sh`.

## Kodi

Install Kodi from **RetroPie Setup > Manage packages > Optional packages > kodi**. It appears under
the **Ports** system: D-pad to Ports, Circle, Circle on Kodi. Leave it with Kodi's power icon > Exit,
which drops you back into EmulationStation.

Inside Kodi the pad does nothing until Kodi has its own map for it: Settings > System > Input >
**Configure attached controllers**, then press each button once (use a keyboard or the Kore app the
first time). Map Cross to A and Circle to B for the same feel as the menus.

If Kodi shows a black border while EmulationStation fills the TV: with `dtoverlay=vc4-fkms-v3d`
the firmware's default HDMI overscan (48 px per edge) is passed to the kernel as display margins,
and the fkms driver shrinks every DRM plane by them. Kodi draws through DRM, EmulationStation
through dispmanx, so only Kodi shrinks. Add `disable_overscan=1` to `/boot/config.txt` and reboot.
If EmulationStation then bleeds past the edges, set the TV's picture size to *Screen Fit* /
*Just Scan* for that HDMI input.

## Checking that RetroPie sees the pad

```bash
# device present while a phone is connected (Handlers should list an eventN and a jsN)
awk 'BEGIN{RS=""} /MobileGamePad/' /proc/bus/input/devices

# EmulationStation recognised it with a mapping ("known"), not as a new controller ("unconfigured")
grep -i joystick ~/.emulationstation/es_log.txt | tail -3

# restart EmulationStation by hand (its process name is truncated, so match the path)
touch /tmp/es-restart && kill "$(ps -eo pid,args | awk '$2 ~ /emulationstation\/emulationstation$/ {print $1}')"
```

## How the ids are derived

SDL2 numbers a joystick's buttons by ascending evdev key code and its axes by ascending ABS code,
with `ABS_HAT0X/Y` becoming hat 0. RetroArch's udev driver numbers them the same way, which is why
both files agree:

| evdev | Control | SDL / RetroArch |
|---|---|---|
| `0x130` BTN_SOUTH | Cross | button 0 |
| `0x131` BTN_EAST | Circle | button 1 |
| `0x133` BTN_NORTH | Triangle | button 2 |
| `0x134` BTN_WEST | Square | button 3 |
| `0x136` / `0x137` | L1 / R1 | buttons 4 / 5 |
| `0x138` / `0x139` | L2 / R2 (digital) | buttons 6 / 7 |
| `0x13a` BTN_SELECT | Create | button 8 |
| `0x13b` BTN_START | Options | button 9 |
| `0x13c` BTN_MODE | PS | button 10 |
| `0x13d` / `0x13e` | L3 / R3 | buttons 11 / 12 |
| `ABS_X` / `ABS_Y` | left stick | axes 0 / 1 |
| `ABS_Z` / `ABS_RZ` | right stick | axes 2 / 5 |
| `ABS_RX` / `ABS_RY` | L2 / R2 pull | axes 3 / 4 |
| `ABS_HAT0X` / `ABS_HAT0Y` | D-pad | hat 0 |
