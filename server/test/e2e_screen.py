"""Screen-sharing test: host shares a screen first, a friend joins later with the code."""
import os, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, open_side, tap
BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--auto-select-desktop-capture-source=Entire screen", "--autoplay-policy=no-user-gesture-required",
        "--enable-features=GetDisplayMediaSet"]
res = []
def check(c, l):
    res.append(c); print(("PASS  " if c else "FAIL  ") + l, flush=True)
def wait(fn, t=20):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.25)
    return False
with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []
    def page(n):
        pg = b.new_context(viewport={"width": 1280, "height": 720}, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()}).new_page()
        pg.on("pageerror", lambda e: errs.append(f"{n}: {e}")); pg.on("dialog", lambda d: d.accept()); return pg
    h = page("host"); sign_in(h, BASE, "Ricky", BASE)
    check(h.is_visible("[data-source='screen']"), "'My screen' option offered on a computer")
    h.click("[data-source='screen']")
    check(h.is_hidden("#file-field") and h.is_visible("#screen-field"), "file picker swaps for screen instructions")
    h.screenshot(path=f"{OUT}/s1-setup.png")
    h.click("#host-start")
    opened = wait(lambda: h.locator("#code-tiles .tile").count() == 8, 10)
    check(opened, "room opens after choosing a screen")
    if not opened:
        print(h.inner_text("#host-error")); sys.exit(1)
    check(h.is_visible("#screen-controls") and h.is_hidden("#host-controls"), "screen controls shown instead of film controls")
    check(wait(lambda: h.evaluate("document.getElementById('film').videoWidth > 0")), "host sees a preview of the shared screen")
    code = "".join(h.locator("#code-tiles .tile").all_inner_texts())
    time.sleep(2)  # host is already sharing; friend turns up later
    v = page("friend"); sign_in(v, BASE + "#join=" + code, "Sarah", BASE); v.click("#join-start")
    h.wait_for_selector("#request-list .allow"); h.click("#request-list .allow")
    check(wait(lambda: v.evaluate("(() => { const f = document.getElementById('film'); return f.srcObject && f.videoWidth > 0; })()")), "friend who joins later sees the screen")
    print("      friend receives", v.evaluate("document.getElementById('film').videoWidth"), "x", v.evaluate("document.getElementById('film').videoHeight"))
    h.screenshot(path=f"{OUT}/s2-host.png"); v.screenshot(path=f"{OUT}/s3-friend.png")
    h.click("#ctl-stopshare")
    check(wait(lambda: v.is_visible("#stage-empty") and "paused sharing" in v.inner_text("#stage-empty-text")), "friend is told when the host stops sharing")
    h.click("#ctl-reshare")
    check(wait(lambda: v.evaluate("(() => { const f = document.getElementById('film'); return f.srcObject && f.videoWidth > 0 && document.getElementById('stage-empty').hidden; })()")), "sharing again comes back for the friend")
    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()
print(f"\n{sum(res)}/{len(res)} checks passed"); sys.exit(0 if all(res) else 1)
