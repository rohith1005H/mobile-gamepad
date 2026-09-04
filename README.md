# Mobile Gamepad

Mobile Universal Gamepad for RetroPie (http://mobilegamepad.net/)

Turns a phone's browser into a DualSense-style controller for a RetroPie box: face buttons,
bumpers, analog triggers, two sticks, hat-switch D-pad, Create / Options / PS, and a touchpad that
drives a mouse pointer. The Pi sees a real Linux gamepad (plus a mouse) through `uinput`, so
EmulationStation, RetroArch and Kodi treat it like any USB pad.

![MobileGamePad client](/other/resources/pad-ps5.png)

# Quick installation and start

* Run below installation script

```bash
# Install nodejs (tested with nodejs v12.17.0)
sudo apt-get update && sudo apt-get upgrade
curl -sL https://deb.nodesource.com/setup_12.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Grunt Command Line Interface
sudo npm install -g grunt-cli

# Clone project MobileGamePad and install dependencies
git clone -b feat/ps5-pad https://github.com/rohith1005H/mobile-gamepad.git
cd mobile-gamepad
npm install

# Run MobileGamepad
sudo grunt start
```

* Open in mobile browser the below URL (Mobile phone and Raspberry Pi have to be on the same network)

```
http://[ip_address_raspberry_pi]:8888
```

* Run gamepad in background and enable on startup

```bash
# Enable Mobile gamepad on startup
sudo npm install pm2 -g
sudo pm2 start app.sh
sudo pm2 startup
sudo pm2 save
```

# RetroPie configuration

One script installs the RetroArch autoconfig and the EmulationStation mapping, then restarts
EmulationStation. Run it on the Pi as the user that runs EmulationStation:

```bash
bash other/retropie/install.sh
```

In the menus the D-pad moves, **Circle** confirms, **Cross** goes back, **Create** opens the
options popup and **Options** opens the main menu. In games Create is the hotkey: Create + Options
exits, Create + Triangle opens the RetroArch menu, Create + L1 / R1 loads / saves state.

Do not map this pad with EmulationStation's "Configure Input" wizard; it overwrites the RetroArch
file with the wrong layout. Details, the Kodi notes and the full button table are in
[other/retropie/README.md](other/retropie/README.md).

# Install application on mobile phone

* Open chrome browser with url `http://[ip_address_raspberry_pi]:8888`
* Open chrome menu (right top corner)
* Select option `Add to home screen`
* Add application title `MobileGamepad`
* The shortcut should be added to home screen

![Standalone installation step 1](/other/resources/screenshot_add_home_screen.png)
![Standalone installation step 2](/other/resources/screenshot_add_title.png)
![Standalone installation step 3](/other/resources/screenshot_add_icon.png)

# Tests

Everything runs off the Pi: a unit test for the uinput server logic and a headless-Chrome
end-to-end test that drives the real client against a mock Pi. See [test/README.md](test/README.md).

# Additional tools

The below tool allows check gamepad connection and sending events

```bash
sudo apt-get install input-utils
```

* Dump out all the input devices and the associated details about the device.

```bash
sudo lsinput
```

* Display input events

```bash
sudo input-events [number]
```

* Display keyboard mapping of a particular event device

```bash
sudo input-kbd [number]
```

---

# TODO

- Add simple KODI or other installation package
- Integrate gamepad with LaunchBox

# Problem solved

- No more problems with battery in gamepad
- No more problems with multi-players
- One gamepad uses everywhere
