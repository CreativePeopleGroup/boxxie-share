"""Browser test: a friend whose phone locks or loses signal comes straight back into the room,
without the host having to let them in again (even if the room is locked). Removed people don't.
Run the dev server first, then:  python3 test/e2e_rejoin.py <film.mp4> <screenshot-dir>
"""
import os, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, wait, open_side

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
TRACK_WS = "(() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (u, p) { const w = p ? new W(u, p) : new W(u); window.__ws.push(w); return w; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); })();"
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []
    def page(name, vp, mobile=False):
        kw = dict(viewport=vp, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        if mobile: kw.update(is_mobile=True, has_touch=True)
        pg = b.new_context(**kw).new_page()
        pg.add_init_script(TRACK_WS)
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg
    viewing = "(() => { const v = document.getElementById('film'); return !!v.srcObject && v.videoWidth > 0 && !v.paused; })()"
    drop = "window.__ws.filter(w => w.readyState === 1).forEach(w => w.close())"

    host = page("host", {"width": 1280, "height": 720})
    sign_in(host, BASE, "Ricky", BASE)
    host.set_input_files("#film-file", FILM); host.click("#host-start")
    host.wait_for_selector("#code-tiles .tile", state="attached", timeout=15000)
    code = "".join(host.locator("#code-tiles .tile").all_inner_texts())
    host.click("#ctl-play")
    friend = page("sarah", {"width": 390, "height": 844}, mobile=True)
    sign_in(friend, BASE + "#join=" + code, "Sarah", BASE); friend.click("#join-start")
    host.wait_for_selector("#request-list .allow"); host.click("#request-list .allow")
    check(wait(lambda: friend.evaluate(viewing), 20), "Sarah is watching")

    host.evaluate("document.getElementById('lock-room') && document.getElementById('lock-room').click()")
    friend.evaluate(drop)
    check(wait(lambda: "Reconnecting" in friend.inner_text("body"), 5), "when her connection drops she sees 'Reconnecting'")
    check(wait(lambda: friend.evaluate(viewing), 25), "she's back watching on her own, even with the room locked")
    check(host.is_hidden("#requests") or "Sarah" not in host.inner_text("#requests"), "the host didn't have to let her in again")
    open_side(host)
    check(wait(lambda: host.inner_text("#people-list").count("Sarah") == 1, 8), "she's in the people list once, not twice")
    check(friend.is_visible("#screen-room") and friend.is_hidden("#banner"), "and the 'Reconnecting' message has gone")
    friend.screenshot(path=f"{OUT}/rejoin-1-back.png")

    # Removed people don't come back
    host.locator("#people-list button.chip", has_text="Sarah").click()
    host.click("#person-remove")
    check(wait(lambda: friend.is_visible("#screen-waiting") and "removed" in friend.inner_text("#screen-waiting"), 10), "if the host removes her, she's out")
    friend.wait_for_timeout(3000)
    check(friend.is_visible("#screen-waiting"), "and she doesn't sneak back in")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
