"""Browser test: block and report (Google Play's rules for apps with chat and video).
Run the dev server first, then:  python3 test/e2e_safety.py <path-to-test-video> <screenshot-dir>
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait, open_side, tap

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []
    def page(name, vp):
        pg = b.new_context(viewport=vp, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()}).new_page()
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    host = page("host", {"width": 1280, "height": 720})
    sign_in(host, BASE, "Ricky", BASE)
    host.set_input_files("#film-file", FILM); host.click("#host-start")
    host.wait_for_selector("#code-tiles .tile", state="attached")
    code = "".join(host.locator("#code-tiles .tile").all_inner_texts())
    host.click("#ctl-play")

    troll = page("troll", {"width": 1280, "height": 720})
    sign_in(troll, BASE + "#join=" + code, "Troll", BASE); troll.click("#join-start")
    host.wait_for_selector("#request-list .allow"); host.click("#request-list .allow")
    check(wait(lambda: not troll.evaluate("document.getElementById('screen-room').hidden")), "a viewer joins")
    open_side(troll)
    troll.fill("#chat-input", "you are all idiots"); troll.click("#chat-form button")
    open_side(host)
    check(wait(lambda: "idiots" in host.inner_text("#chat-log")), "host sees the nasty message")

    host.locator("#people-list button.chip", has_text="Troll").click()
    check(host.is_visible("#person-panel") and host.is_visible("#person-block") and host.is_visible("#person-report") and host.is_visible("#person-remove"),
          "tapping a person offers remove, block and report")
    host.click("#person-report")
    check(host.is_visible("#report-panel") and "Report Troll" in host.inner_text("#report-title"), "report form opens for that person")
    host.check("#report-panel input[value='harassment']")
    host.fill("#report-details", "insulting everyone")
    host.screenshot(path=f"{OUT}/safety-report.png")
    host.click("#report-send")
    check(wait(lambda: "removed you" in troll.inner_text("#waiting-text")), "reporting with 'also block' removes them from the room")
    mail = json.loads(urllib.request.urlopen(BASE + "dev/mail?to=owner%40example.com").read())
    check("harassment" in mail.get("subject", "") and "idiots" in mail.get("text", ""), "the report reaches the app owner with their messages")

    # Blocked: they can't come back
    troll.goto("about:blank"); troll.goto(BASE + "#join=" + code)
    troll.wait_for_selector("#screen-home:not([hidden])")
    troll.click("#join-start")
    check(wait(lambda: "can't join this room" in troll.inner_text("#join-error")), "a blocked person can't rejoin")

    # The blocked list, with unblock
    tap(host, "#leave")
    host.wait_for_selector("#screen-home:not([hidden])")
    host.click("#go-friends")
    check(wait(lambda: "Troll" in host.inner_text("#blocked-list")), "Friends shows who you've blocked")
    host.screenshot(path=f"{OUT}/safety-blocked.png")
    host.locator("#blocked-list li", has_text="Troll").locator("button", has_text="Unblock").click()
    check(wait(lambda: host.is_hidden("#blocked-wrap")), "you can unblock them")
    host.click("#report-problem")
    check(host.is_visible("#report-panel") and host.is_hidden("#report-block-row"), "you can report a general problem too")
    host.click("#report-cancel")
    check(host.evaluate("[...document.querySelectorAll('a')].some(a => a.getAttribute('href') === 'terms.html')"), "terms of use are linked")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
