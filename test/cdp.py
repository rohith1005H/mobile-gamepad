"""Minimal Chrome DevTools Protocol driver over aiohttp websocket.
Launches headless Chrome, navigates, evaluates JS, screenshots."""
import asyncio, json, os, subprocess, sys, urllib.request, time
import aiohttp

CHROME = os.environ.get("CHROME") or next((p for p in [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] if os.path.exists(p)), "chrome")

class Chrome:
    def __init__(self, profile, port=9333, width=844, height=390):
        self.profile, self.port, self.w, self.h = profile, port, width, height
        self.proc = self.ws = self.sess = None; self._id = 0
    async def __aenter__(self):
        self.proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu",
            "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
            "--disable-background-timer-throttling", "--force-device-scale-factor=2",
            f"--remote-debugging-port={self.port}", f"--user-data-dir={self.profile}",
            f"--window-size={self.w},{self.h}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = None
        for _ in range(50):
            try:
                d = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json"))
                for t in d:
                    if t.get("type") == "page": url = t["webSocketDebuggerUrl"]; break
                if url: break
            except Exception: pass
            time.sleep(0.2)
        if not url: raise RuntimeError("no devtools page target")
        self.sess = aiohttp.ClientSession()
        self.ws = await self.sess.ws_connect(url, max_msg_size=64*1024*1024)
        await self.cmd("Page.enable"); await self.cmd("Runtime.enable")
        return self
    async def __aexit__(self, *a):
        try: await self.ws.close()
        except Exception: pass
        try: await self.sess.close()
        except Exception: pass
        self.proc.terminate()
    async def cmd(self, method, **params):
        self._id += 1; mid = self._id
        await self.ws.send_str(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = await self.ws.receive()
            if msg.type != aiohttp.WSMsgType.TEXT: continue
            data = json.loads(msg.data)
            if data.get("id") == mid:
                if "error" in data: raise RuntimeError(method + ": " + json.dumps(data["error"]))
                return data.get("result")
    async def navigate(self, url):
        await self.cmd("Page.navigate", url=url)
        await asyncio.sleep(1.0)
    async def js(self, expr):
        r = await self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")
    async def shot(self, path):
        r = await self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        import base64
        open(path, "wb").write(base64.b64decode(r["data"]))
        return os.path.getsize(path)
