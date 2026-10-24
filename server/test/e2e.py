"""End-to-end test in real Chromium: host shares a film, two friends join, video call + chat.
Run the dev server first:  node --import ./test/register.mjs test/devserver.mjs 8788
Then:                      python3 test/e2e.py <path-to-test-video> <screenshot-dir>
"""
import os, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, open_side, tap

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
results = []

def check(cond, label):
    results.append(cond)
    print(("PASS  " if cond else "FAIL  ") + label, flush=True)

def wait_for(fn, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False

ARGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
]

with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    errors = []

    def new_page(name, viewport):
        ctx = browser.new_context(viewport=viewport, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    host = new_page("host", {"width": 1280, "height": 720})
    sign_in(host, BASE, "Ricky", BASE)
    host.screenshot(path=f"{OUT}/1-home.png")
    host.set_input_files("#film-file", FILM)
    host.screenshot(path=f"{OUT}/2-host-setup.png")
    host.click("#host-start")
    host.wait_for_selector("#code-tiles .tile", state="attached", timeout=10000)
    code = "".join(host.locator("#code-tiles .tile").all_inner_texts())
    check(len(code) == 8, f"host opened room with code {code}")
    host.click("#ctl-play")
    check(wait_for(lambda: host.evaluate("!document.getElementById('film').paused")), "film playing on host")

    # Viewer 1 joins via link
    v1 = new_page("sarah", {"width": 1280, "height": 720})
    sign_in(v1, BASE + "#join=" + code[:4] + "-" + code[4:], "Sarah", BASE)
    check(v1.input_value("#join-code") == code[:4] + "-" + code[4:], "join link pre-fills the code")
    v1.click("#join-start")
    v1.wait_for_selector("#screen-waiting:not([hidden])")
    v1.screenshot(path=f"{OUT}/3-viewer-waiting.png")
    host.wait_for_selector("#request-list .allow", timeout=10000)
    host.screenshot(path=f"{OUT}/4-host-request.png")
    check(host.inner_text("#request-list") .find("Sarah") >= 0, "host sees Sarah asking to join")
    host.click("#request-list .allow")

    film_ok = wait_for(lambda: v1.evaluate("(() => { const v = document.getElementById('film'); return v.srcObject && v.videoWidth > 0 && v.currentTime > 0.5; })()"), 20)
    check(film_ok, "Sarah receives the film (live video playing)")
    w = v1.evaluate("document.getElementById('film').videoWidth")
    h = v1.evaluate("document.getElementById('film').videoHeight")
    print(f"      received resolution {w}x{h}")
    audio = v1.evaluate("document.getElementById('film').srcObject.getAudioTracks().length")
    check(audio == 1, "Sarah receives the film's sound")

    # Viewer 2 joins by typing the code, on a phone-sized screen
    v2 = new_page("dev", {"width": 390, "height": 844})
    sign_in(v2, BASE, "Dev", BASE)
    v2.fill("#join-code", code.lower())
    v2.click("#join-start")
    host.wait_for_selector("#request-list .allow", timeout=10000)
    host.click("#request-list .allow")
    check(wait_for(lambda: v2.evaluate("(() => { const v = document.getElementById('film'); return v.srcObject && v.videoWidth > 0 && v.currentTime > 0.5; })()"), 20), "Dev receives the film on a phone layout")

    # Video call: Sarah and host join the call
    tap(v1, "#call-toggle")
    tap(host, "#call-toggle")
    check(wait_for(lambda: host.locator(".cam:not(.me) video").count() >= 1 and host.evaluate("[...document.querySelectorAll('.cam:not(.me) video')].some(v => v.videoWidth > 0)"), 20), "host sees Sarah on camera")
    check(wait_for(lambda: v2.evaluate("document.querySelectorAll('.cam video').length >= 2 && [...document.querySelectorAll('.cam video')].every(v => v.videoWidth > 0)"), 20), "Dev (not on camera) sees both Sarah and the host")
    check(wait_for(lambda: v1.evaluate("[...document.querySelectorAll('.cam:not(.me) video')].some(v => v.videoWidth > 0)"), 20), "Sarah sees the host on camera")
    # Film still flowing to Sarah after renegotiation
    t0 = v1.evaluate("document.getElementById('film').currentTime")
    time.sleep(2)
    t1 = v1.evaluate("document.getElementById('film').currentTime")
    check(t1 > t0 + 1, "film keeps playing while the call runs")

    # Chat + reaction (the host opens the chat drawer; Dev's phone shows chat under the film)
    open_side(host)
    v2.fill("#chat-input", "this bit is great")
    v2.click("#chat-form button")
    check(wait_for(lambda: "this bit is great" in host.inner_text("#chat-log")), "chat reaches the host")
    host.click(".react[data-react='😂']")
    check(wait_for(lambda: "😂" in v1.inner_text("#chat-log")), "reaction reaches Sarah")

    time.sleep(1.5)
    host.screenshot(path=f"{OUT}/5-host-room.png")
    v1.screenshot(path=f"{OUT}/6-viewer-room.png")
    v2.screenshot(path=f"{OUT}/7-phone-room.png", full_page=True)

    # Lock, then a stranger tries to join
    host.click("#lock-room")
    v3 = new_page("late", {"width": 1280, "height": 720})
    sign_in(v3, BASE + "#join=" + code, "Late", BASE)
    v3.click("#join-start")
    check(wait_for(lambda: "locked" in v3.inner_text("#waiting-text")), "locked room turns away new people")

    # Wrong code
    v3.goto(BASE)
    v3.wait_for_selector("#screen-home:not([hidden])")
    v3.fill("#join-code", "ABCD2345")
    v3.click("#join-start")
    check(wait_for(lambda: "doesn't match" in v3.inner_text("#join-error")), "wrong code gets a clear message")

    # Kick Dev
    host.locator("#people-list button.chip", has_text="Dev").click()
    host.click("#person-remove")
    check(wait_for(lambda: "removed you" in v2.inner_text("#waiting-text")), "host can remove someone")

    # End room
    tap(host, "#leave")
    check(wait_for(lambda: "ended the session" in v1.inner_text("#waiting-text")), "ending the room tells everyone")

    check(not errors, "no JavaScript errors" + (": " + "; ".join(errors) if errors else ""))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
