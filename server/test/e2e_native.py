"""Browser test: the Android app's whole-screen sharing (with a stand-in for the app's engine),
and letting people in from the host's paired phone while the TV shows another app.
Run the dev server first, then:  python3 test/e2e_native.py <screenshot-dir>
"""
import os, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait, tap, open_side

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
FAKE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_native.js")).read()
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA Build/RS8101) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BoxxieShareTV/1"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []
    def page(name, vp, ua=None, native=False, mobile=False):
        kw = dict(viewport=vp, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw["user_agent"] = ua
        if mobile: kw.update(is_mobile=True, has_touch=True)
        pg = b.new_context(**kw).new_page()
        if native: pg.add_init_script(FAKE)
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg
    viewing = "(() => { const v = document.getElementById('film'); return !!v.srcObject && v.videoWidth > 0 && v.currentTime > 0.3; })()"

    tv = page("tv", {"width": 1920, "height": 1080}, TV_UA, native=True)
    sign_in(tv, BASE, "Ricky", BASE)
    check(tv.is_visible("[data-source='screen']") and "TV screen" in tv.inner_text("[data-source='screen']"), "the TV app offers 'TV screen' sharing")
    tv.click("[data-source='screen']")
    check(tv.is_hidden("#surface-choice") and "press Home" in tv.inner_text("#surface-note"), "it explains: start sharing, press Home, open any app")
    tv.screenshot(path=f"{OUT}/native-1-choose.png")

    tv.evaluate("window.__denyNext = true")
    tv.click("#host-start")
    check(wait(lambda: "wasn't allowed" in tv.inner_text("#host-error"), 5), "saying no to the TV's permission pop-up is explained")
    tv.click("#host-start")
    tv.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code = "".join(tv.locator("#code-tiles .tile").all_inner_texts())
    check("Sharing this screen and its sound" in tv.inner_text("#screen-status"), "the TV shares its whole screen and sound")
    tv.screenshot(path=f"{OUT}/native-2-sharing.png")

    friend = page("sarah", {"width": 1280, "height": 720})
    sign_in(friend, BASE + "#join=" + code, "Sarah", BASE)
    friend.click("#join-start")
    tv.wait_for_selector("#request-list .allow"); tv.click("#request-list .allow")
    check(wait(lambda: friend.evaluate(viewing), 20), "Sarah sees the TV's screen live")
    check(friend.evaluate("document.getElementById('film').srcObject.getAudioTracks().length") == 1, "and hears it")
    check(any(c.startswith("add:") for c in tv.evaluate("window.__nativeCalls")), "each friend is handed to the app's engine")
    check(wait(lambda: "Sarah" in tv.inner_text("#viewer-health") and "getting the picture" in tv.inner_text("#viewer-health"), 10), "the TV shows that Sarah is getting the picture")
    check(friend.is_hidden("#screen-diag"), "Sarah sees no 'waiting' message once the picture arrives")
    tv.screenshot(path=f"{OUT}/native-2b-health.png")
    check(tv.is_hidden("#vpn-note"), "no VPN warning when there's no VPN")

    # Open another app: Home
    tap(tv, "#ctl-reshare")
    tv.wait_for_selector("#apps-panel:not([hidden])", timeout=5000)
    tv.locator(".app-tile", has_text="TV home screen").click()
    check("home" in tv.evaluate("window.__nativeCalls"), "'Open another app' lists the TV's apps; TV home screen goes home while sharing continues")

    # Ricky's phone lets people in while the TV shows another app
    tap(tv, "#pair-phone"); tv.wait_for_selector("#pair-panel:not([hidden])")
    pc = tv.inner_text("#pair-code")
    phone = page("ricky-phone", {"width": 390, "height": 844}, mobile=True)
    sign_in(phone, BASE, "Ricky", BASE)
    phone.fill("#join-code", pc.replace("-", "").lower()); phone.click("#join-start")
    check(wait(lambda: phone.evaluate("document.getElementById('screen-room').classList.contains('call-mode')")), "Ricky pairs his phone")
    dev = page("dev", {"width": 1280, "height": 720})
    sign_in(dev, BASE + "#join=" + code, "Dev", BASE)
    dev.click("#join-start")
    check(wait(lambda: phone.is_visible("#request-list .allow") and "Dev" in phone.inner_text("#request-list")), "Dev's request shows on Ricky's phone")
    phone.screenshot(path=f"{OUT}/native-3-phone-let-in.png")
    phone.click("#request-list .allow")
    check(wait(lambda: dev.evaluate(viewing), 20), "Ricky lets Dev in from his phone, and Dev sees the TV screen")
    check(wait(lambda: phone.is_hidden("#requests"), 5), "the request clears on the phone")

    # Stop and share again
    tap(tv, "#ctl-stopshare")
    check(wait(lambda: friend.is_visible("#stage-empty") and "paused sharing" in friend.inner_text("#stage-empty-text"), 10), "stopping tells friends the host paused")
    tap(tv, "#ctl-reshare")
    check(wait(lambda: friend.evaluate(viewing) and dev.evaluate(viewing), 20), "sharing again reaches everyone (a fresh session)")

    # Kick removes the viewer from the engine
    open_side(tv)
    tv.locator("#people-list button.chip", has_text="Dev").click()
    tv.click("#person-remove")
    check(wait(lambda: any(c.startswith("remove:") for c in tv.evaluate("window.__nativeCalls")), 8), "removing someone takes them off the engine too")

    tap(tv, "#leave")
    check(wait(lambda: "stop" in tv.evaluate("window.__nativeCalls"), 8), "leaving the room stops screen sharing")
    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
