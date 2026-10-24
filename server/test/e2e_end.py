"""Browser test: the room closes itself when the film ends (with a countdown the host can cancel),
sharing that stops closes the room later, and the host's paired phone can remove people.
Run the dev server first, then:  python3 test/e2e_end.py <short-film.mp4> <screenshot-dir>
"""
import os, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait, tap, open_side

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
FAKE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_native.js")).read()
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA Build/RS8101) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BoxxieShareTV/1"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
SHORT = "window.__boxxieAutoEnd = { finished: 15000, idle: 15000 };"
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
        pg.add_init_script(SHORT)
        if native: pg.add_init_script(FAKE)
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg
    def join(pg, code):
        pg.click("#join-start")
    card = lambda pg: pg.is_visible("#end-card")

    # ---- 1. A film: the host's phone removes someone, then the film ends ----
    host = page("host", {"width": 1280, "height": 720})
    sign_in(host, BASE, "Ricky", BASE)
    host.set_input_files("#film-file", FILM)
    host.click("#host-start")
    host.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code = "".join(host.locator("#code-tiles .tile").all_inner_texts())

    sarah = page("sarah", {"width": 1280, "height": 720})
    sign_in(sarah, BASE + "#join=" + code, "Sarah", BASE); sarah.click("#join-start")
    host.wait_for_selector("#request-list .allow"); host.click("#request-list .allow")
    dev = page("dev", {"width": 1280, "height": 720})
    sign_in(dev, BASE + "#join=" + code, "Dev", BASE); dev.click("#join-start")
    host.wait_for_selector("#request-list .allow"); host.click("#request-list .allow")
    check(wait(lambda: "Dev" in host.inner_text("#people-list") and "Sarah" in host.inner_text("#people-list")), "Sarah and Dev are in")

    tap(host, "#pair-phone"); host.wait_for_selector("#pair-panel:not([hidden])")
    pc = host.inner_text("#pair-code")
    phone = page("ricky-phone", {"width": 390, "height": 844}, mobile=True)
    sign_in(phone, BASE, "Ricky", BASE)
    phone.fill("#join-code", pc.replace("-", "").lower()); phone.click("#join-start")
    check(wait(lambda: phone.evaluate("document.getElementById('screen-room').classList.contains('call-mode')")), "Ricky pairs his phone")
    host.keyboard.press("Escape")
    wait(lambda: "Dev" in phone.inner_text("#people-list"), 10)
    phone.locator("#people-list button.chip", has_text="Dev").click()
    check(phone.is_visible("#person-remove"), "the host's phone can remove people")
    phone.click("#person-remove")
    check(wait(lambda: "removed" in dev.inner_text("body").lower() or dev.is_visible("#screen-waiting"), 10), "Dev is removed from the phone")
    check(wait(lambda: "Dev" not in host.inner_text("#people-list"), 10), "and is gone from the host's list")

    host.click("#ctl-play")
    check(wait(lambda: card(sarah) and card(host), 20), "when the film ends, everyone sees the end card")
    check("Leave now" in sarah.inner_text("#end-card") and sarah.is_hidden("#end-keep"), "friends can leave now")
    check(host.is_visible("#end-keep") and host.is_visible("#end-now"), "the host can keep the room open or close it")
    check(wait(lambda: card(phone) and phone.is_visible("#end-keep"), 10), "the host's phone gets the same choice")
    host.screenshot(path=f"{OUT}/end-1-host.png"); sarah.screenshot(path=f"{OUT}/end-2-friend.png"); phone.screenshot(path=f"{OUT}/end-3-phone.png")

    host.click("#end-keep")
    check(wait(lambda: not card(sarah) and not card(phone), 10), "Keep the room open cancels it for everyone")
    host.evaluate("const v = document.getElementById('film'); v.currentTime = Math.max(0, v.duration - 1); v.play()")
    check(wait(lambda: card(sarah), 15), "the film ends again: countdown again")
    check(wait(lambda: sarah.is_visible("#screen-waiting") and "Thanks for watching" in sarah.inner_text("#screen-waiting"), 30), "after the countdown, friends are sent out with a thank-you")
    check(wait(lambda: host.is_visible("#screen-home"), 10), "and the host is back home")
    sarah.screenshot(path=f"{OUT}/end-4-closed.png")

    # ---- 2. TV screen sharing that stops ----
    tv = page("tv", {"width": 1920, "height": 1080}, TV_UA, native=True)
    sign_in(tv, BASE, "Maya", BASE)
    tv.click("[data-source='screen']"); tv.click("#host-start")
    tv.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code2 = "".join(tv.locator("#code-tiles .tile").all_inner_texts())
    sam = page("sam", {"width": 1280, "height": 720})
    sign_in(sam, BASE + "#join=" + code2, "Sam", BASE); sam.click("#join-start")
    tv.wait_for_selector("#request-list .allow"); tv.click("#request-list .allow")
    check(wait(lambda: sam.evaluate("(() => { const v = document.getElementById('film'); return !!v.srcObject && v.videoWidth > 0; })()"), 20), "Sam sees the TV screen")
    tap(tv, "#ctl-stopshare")
    check(wait(lambda: card(sam) and "Sharing has stopped" in sam.inner_text("#end-card"), 10), "stopping sharing starts the countdown")
    tap(tv, "#ctl-reshare")
    check(wait(lambda: not card(sam), 10), "sharing again cancels it")
    tap(tv, "#ctl-stopshare")
    check(wait(lambda: sam.is_visible("#screen-waiting") and "stopped sharing" in sam.inner_text("#screen-waiting"), 30), "if sharing doesn't come back, the room closes")

    # ---- 3. Close now ----
    host2 = page("host2", {"width": 1280, "height": 720})
    sign_in(host2, BASE, "Lena", BASE)
    host2.set_input_files("#film-file", FILM); host2.click("#host-start")
    host2.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code3 = "".join(host2.locator("#code-tiles .tile").all_inner_texts())
    tom = page("tom", {"width": 1280, "height": 720})
    sign_in(tom, BASE + "#join=" + code3, "Tom", BASE); tom.click("#join-start")
    host2.wait_for_selector("#request-list .allow"); host2.click("#request-list .allow")
    host2.click("#ctl-play")
    wait(lambda: card(host2), 20)
    host2.click("#end-now")
    check(wait(lambda: tom.is_visible("#screen-waiting"), 10), "Close the room now sends everyone out straight away")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
