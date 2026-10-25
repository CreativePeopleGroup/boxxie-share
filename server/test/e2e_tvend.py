"""Browser test: while the TV shares its screen, the host can remove people from the TV, and when
nothing has played for a while (the film's over) everyone is counted down and sent out.
Run the dev server first, then:  python3 test/e2e_tvend.py <screenshot-dir>
"""
import os, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait

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
        pg.add_init_script("window.__boxxieQuietMs = 4000; window.__boxxieAutoEnd = { quiet: 15000 };")
        if native: pg.add_init_script(FAKE)
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    tv = page("tv", {"width": 960, "height": 540}, TV_UA, native=True)
    sign_in(tv, BASE, "Ricky", BASE)
    tv.click("[data-source='screen']"); tv.click("#host-start")
    tv.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code = "".join(tv.locator("#code-tiles .tile").all_inner_texts())
    friends = {}
    for n in ["Sarah", "Dev"]:
        f = page(n, {"width": 1280, "height": 720})
        sign_in(f, BASE + "#join=" + code, n, BASE); f.click("#join-start")
        tv.wait_for_selector("#request-list .allow"); tv.click("#request-list .allow")
        friends[n] = f
    check(wait(lambda: "Sarah" in tv.inner_text("#viewer-health") and "Dev" in tv.inner_text("#viewer-health"), 10), "the TV lists everyone watching")
    check(tv.locator("#viewer-health button", has_text="Remove").count() == 2, "each with a Remove button")
    check(tv.is_visible("#people-open"), "and there's a People button")
    tv.screenshot(path=f"{OUT}/tvend-1-list.png")
    tv.locator("#viewer-health li", has_text="Dev").locator("button").focus(); tv.keyboard.press("Enter")
    tv.click("#person-remove")
    check(wait(lambda: friends["Dev"].is_visible("#screen-waiting"), 10), "Remove takes Dev out of the room")
    check(wait(lambda: "Dev" not in tv.inner_text("#viewer-health"), 8), "and off the TV's list")

    sarah = friends["Sarah"]
    tv.evaluate("window.__fakePlaying = false")
    check(wait(lambda: sarah.is_visible("#end-card") and "Nothing's playing" in sarah.inner_text("#end-card"), 15), "when nothing plays for a while, everyone gets the countdown")
    tv.evaluate("window.__fakePlaying = true")
    check(wait(lambda: sarah.is_hidden("#end-card"), 8), "playing again cancels it")
    tv.evaluate("window.__fakePlaying = false")
    check(wait(lambda: sarah.is_visible("#end-card"), 15), "silence again: countdown again")
    check(wait(lambda: sarah.is_visible("#screen-waiting") and "Thanks for watching" in sarah.inner_text("#screen-waiting"), 30), "and then everyone is sent out")
    check(wait(lambda: tv.is_visible("#screen-home"), 10), "the TV goes home and stops sharing")
    check("stop" in tv.evaluate("window.__nativeCalls"), "screen sharing is stopped")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
