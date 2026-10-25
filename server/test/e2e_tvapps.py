"""Browser test: the TV app's app picker, and rejoining the room after Android restarts the page.
Run the dev server first, then:  python3 test/e2e_tvapps.py <screenshot-dir>
"""
import os, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait, tap

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
FAKE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_native.js")).read()
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA Build/RS8101; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BoxxieShareTV/1"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []
    def page(name, vp, ua=None, native=False):
        kw = dict(viewport=vp, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw["user_agent"] = ua
        pg = b.new_context(**kw).new_page()
        if native: pg.add_init_script(FAKE)
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg
    viewing = "(() => { const v = document.getElementById('film'); return !!v.srcObject && v.videoWidth > 0 && v.currentTime > 0.3; })()"

    tv = page("tv", {"width": 960, "height": 540}, TV_UA, native=True)
    sign_in(tv, BASE, "Ricky", BASE)
    tv.click("[data-source='screen']"); tv.click("#host-start")
    tv.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code = "".join(tv.locator("#code-tiles .tile").all_inner_texts())
    friend = page("sarah", {"width": 1280, "height": 720})
    sign_in(friend, BASE + "#join=" + code, "Sarah", BASE); friend.click("#join-start")
    tv.wait_for_selector("#request-list .allow"); tv.click("#request-list .allow")
    check(wait(lambda: friend.evaluate(viewing), 20), "Sarah sees the TV screen")

    tap(tv, "#ctl-reshare")
    check(wait(lambda: tv.is_visible("#apps-panel"), 5), "'Open another app' shows the TV's apps")
    check("Home Videos" in tv.inner_text("#apps-grid") and "TV home screen" in tv.inner_text("#apps-grid"), "with each app and the TV home screen")
    tv.screenshot(path=f"{OUT}/tvapps-1-picker.png")
    # Lots of apps: the remote's arrows reach the last one, and Back closes the list
    tv.click("#apps-close")
    tv.evaluate("window.__manyApps = true")
    tv.reload()
    tv.wait_for_selector("#ctl-stopshare", timeout=15000)
    tv.evaluate("window.__manyApps = true")
    tap(tv, "#ctl-reshare")
    tv.wait_for_selector("#apps-panel:not([hidden])", timeout=5000)
    for _ in range(12): tv.keyboard.press("ArrowDown")
    focused = tv.evaluate("document.activeElement && document.activeElement.textContent")
    check("The Stream Team" in (focused or ""), f"the remote reaches the last app in a long list (focused: {focused})")
    check(tv.evaluate("(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"), "and scrolls it into view")
    tv.screenshot(path=f"{OUT}/tvapps-1b-long.png")
    check(tv.evaluate("window.boxxieBack()") and tv.is_hidden("#apps-panel") and tv.is_visible("#screen-room"), "Back closes the list and stays in the room")
    tap(tv, "#ctl-reshare")
    tv.wait_for_selector("#apps-panel:not([hidden])", timeout=5000)
    tv.locator(".app-tile", has_text="Home Videos").click()
    check(wait(lambda: "launch:com.example.player" in tv.evaluate("window.__nativeCalls"), 3), "choosing one opens that app")
    check(wait(lambda: friend.evaluate(viewing), 25), "friends keep watching")

    # Android restarts Boxxie's page (low memory); sharing carries on in the background
    tv.reload()
    check(wait(lambda: tv.is_visible("#screen-room") and tv.is_visible("#ctl-stopshare"), 15), "after a restart the TV goes straight back into the room")
    check("Still sharing" in tv.inner_text("body") or wait(lambda: "Sharing this screen" in tv.inner_text("#screen-status"), 5), "and says it's still sharing")
    check(wait(lambda: friend.evaluate(viewing), 25), "Sarah's picture comes back")
    check(friend.is_visible("#screen-room"), "Sarah never left the room")
    tv.screenshot(path=f"{OUT}/tvapps-2-resumed.png")

    tap(tv, "#leave")
    check(wait(lambda: tv.is_visible("#screen-home"), 8), "leaving goes home")
    tv.reload()
    tv.wait_for_timeout(2500)
    check(tv.is_visible("#screen-home") and tv.is_hidden("#screen-room"), "and a restart after leaving stays on home")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
