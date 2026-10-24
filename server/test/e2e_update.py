"""Browser test: the TV app's Update button (with a stand-in for the app's updater).
Run the dev server first, then:  python3 test/e2e_update.py <screenshot-dir>
"""
import os, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
FAKE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_native.js")).read()
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA Build/RS8101; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BoxxieShareTV/1"
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    def page(native=True, ua=TV_UA, vp=(960, 540)):
        kw = dict(viewport={"width": vp[0], "height": vp[1]}, device_scale_factor=2, extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw["user_agent"] = ua
        pg = b.new_context(**kw).new_page()
        if native: pg.add_init_script(FAKE)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        return pg

    tv = page()
    sign_in(tv, BASE, "Ricky", BASE)
    check(wait(lambda: tv.is_visible("#update-btn"), 5), "the TV app shows an Update button when a new version is out")
    check("1.0.6" in tv.inner_text("#update-btn"), "it says which version")
    check(tv.evaluate("document.documentElement.scrollHeight") <= 540, "the home page still fits the screen")
    tv.screenshot(path=f"{OUT}/update-1-button.png")
    tv.click("#update-btn")
    check(wait(lambda: "install-update" in tv.evaluate("window.__nativeCalls"), 3), "pressing it asks the app to install the update")
    check(wait(lambda: "Installing" in tv.inner_text("#update-btn"), 3), "it shows download progress, then Installing")
    tv.screenshot(path=f"{OUT}/update-2-installing.png")

    tv2 = page()
    tv2.add_init_script("window.__updateNone = true")
    sign_in(tv2, BASE, "Maya", BASE)
    tv2.wait_for_timeout(500)
    check(tv2.is_hidden("#update-btn"), "no button when the app is up to date")
    tv2.click("#go-friends")
    check(tv2.is_visible("#app-version") and "up to date" in tv2.inner_text("#app-version"), "Friends shows the version and 'up to date'")
    tv2.click("#update-check")
    check(wait(lambda: "latest version" in tv2.inner_text("#toast"), 3), "Check for updates says you have the latest version")

    web = page(native=False, ua=None, vp=(1280, 720))
    sign_in(web, BASE, "Sam", BASE)
    web.wait_for_timeout(300)
    check(web.is_hidden("#update-btn"), "websites never show the Update button")
    web.click("#go-friends")
    check(web.is_hidden("#app-version"), "or the version row")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
