"""Pairing test: TVs (no camera) pair phones for the video call.
Sarah watches on a TV and scans its QR code with her phone; the host pairs a phone by typing the code."""
import os, sys, time
import cv2
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, open_side, tap

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA) AppleWebKit/537.36 Chrome/124 Safari/537.36 BoxxieShareTV/1"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
res = []

def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

def wait(fn, t=20):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []

    def page(name, vp, ua=None, mobile=False):
        kw = dict(viewport=vp, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw["user_agent"] = ua
        if mobile: kw.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        pg = b.new_context(**kw).new_page()
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    host = page("host-tv", {"width": 1920, "height": 1080}, TV_UA)
    sign_in(host, BASE, "Ricky", BASE); host.set_input_files("#film-file", FILM); host.click("#host-start")
    host.wait_for_selector("#code-tiles .tile", state="attached"); host.click("#ctl-play")
    code = "".join(host.locator("#code-tiles .tile").all_inner_texts())
    check(host.is_hidden("#call-toggle") and host.is_visible("#pair-phone"), "TV offers 'use your phone' instead of a camera call")

    tv = page("sarah-tv", {"width": 1920, "height": 1080}, TV_UA)
    sign_in(tv, BASE + "#join=" + code, "Sarah", BASE); tv.click("#join-start")
    host.wait_for_selector("#request-list .allow"); host.click("#request-list .allow")
    check(wait(lambda: tv.evaluate("document.getElementById('film').videoWidth > 0")), "Sarah's TV gets the film")

    tap(tv, "#pair-phone")
    check(wait(lambda: tv.is_visible("#pair-panel") and tv.locator("#pair-qr svg").count() == 1), "TV shows a pairing QR code")
    pair_code = tv.inner_text("#pair-code")
    check(pair_code.startswith(code[:4] + "-" + code[4:] + "-") and len(pair_code) == 16, f"TV shows a typed code too ({pair_code})")
    tv.screenshot(path=f"{OUT}/p1-tv-pairing.png")
    tv.locator("#pair-qr").screenshot(path=f"{OUT}/p-qr.png")
    img = cv2.imread(f"{OUT}/p-qr.png")
    img = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    link, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    check("#call=" in link, f"phone camera can read the QR code ({link})")

    phone = page("sarah-phone", {"width": 390, "height": 844}, None, True)
    sign_in(phone, BASE + link[link.index("#"):], "Sarah", BASE)  # your phone signs in to your own account
    check(wait(lambda: phone.evaluate("document.getElementById('screen-room').classList.contains('call-mode')")), "scanning opens straight into call mode, no approval needed")
    check(wait(lambda: phone.evaluate("document.querySelectorAll('.cam.me video').length === 1 && document.querySelector('.cam.me video').videoWidth > 0")), "phone camera starts automatically")
    check(wait(lambda: "Sarah" in phone.inner_text("#call-mode-note")), "phone explains it's the camera and mic for Sarah's TV")
    check(wait(lambda: host.evaluate("[...document.querySelectorAll('.cam:not(.me)')].some(c => c.querySelector('video').videoWidth > 0 && c.textContent.includes('Sarah'))")), "host's TV shows Sarah's face from her phone")
    check(wait(lambda: "Phone connected" in tv.inner_text("#pair-phone")) and tv.is_hidden("#pair-panel"), "Sarah's TV confirms the phone is connected")
    check(tv.evaluate("[...document.querySelectorAll('.cam:not(.me) video')].every(v => v.muted)"), "Sarah's TV keeps call sound off (her phone plays it, so no echo)")
    check(phone.evaluate("!document.getElementById('film').srcObject"), "no film is sent to the phone (saves bandwidth)")
    chips = phone.inner_text("#people-list")
    check(chips.count("Sarah") == 1 and "Ricky" in chips, "phone lists people without duplicating Sarah")
    check(wait(lambda: "on phone" in host.inner_text("#people-list")), "host sees Sarah is on her phone")

    # Host pairs their own phone by typing the code
    tap(host, "#pair-phone")
    host.wait_for_selector("#pair-panel:not([hidden])")
    hcode = host.inner_text("#pair-code")
    hphone = page("ricky-phone", {"width": 390, "height": 844}, None, True)
    sign_in(hphone, BASE, "Ricky", BASE); hphone.fill("#join-code", hcode.replace("-", "").lower()); hphone.click("#join-start")
    check(wait(lambda: hphone.evaluate("document.getElementById('screen-room').classList.contains('call-mode')")), "typing the long code on a phone pairs it too")
    check(wait(lambda: phone.evaluate("[...document.querySelectorAll('.cam:not(.me)')].some(c => c.querySelector('video').videoWidth > 0)")), "Sarah and Ricky see each other on their phones")
    phone.fill("#chat-input", "Watching on the telly, talking on the phone"); phone.click("#chat-form button")
    check(wait(lambda: "talking on the phone" in host.inner_text("#chat-log")), "chat from the phone shows on the TVs")
    check(wait(lambda: tv.evaluate("document.getElementById('film').currentTime > 3")), "film keeps playing on Sarah's TV throughout")
    check(host.evaluate("document.querySelectorAll('#faces .cam').length > 0"), "with the drawer closed, faces sit small on the film")
    phone.fill("#chat-input", "Popcorn break?"); phone.click("#chat-form button")
    check(wait(lambda: host.evaluate("document.getElementById('chat-toasts').textContent.includes('Popcorn break?')"), 5), "chat pops up on the TV's film")
    host.screenshot(path=f"{OUT}/p3-host-tv-faces.png")

    # The paired phone is a remote for its TV
    playing = host.evaluate("!document.getElementById('film').paused")
    hphone.click("#remote-play")
    check(wait(lambda: host.evaluate("document.getElementById('film').paused") == playing, 8), "Ricky's phone pauses the film on his TV")
    hphone.click("#remote-play")
    check(wait(lambda: host.evaluate("!document.getElementById('film').paused"), 8), "and plays it again")
    check(phone.is_hidden("#remote"), "Sarah (not hosting) gets no film buttons, just the faces switch")
    phone.click("#faces-mode [data-faces='off']")
    check(wait(lambda: "faces-off" in tv.get_attribute("#faces", "class"), 8), "Sarah's phone hides the faces on her TV")
    phone.click("#faces-mode [data-faces='corner']")
    time.sleep(1)
    phone.screenshot(path=f"{OUT}/p2-phone-call.png", full_page=True)
    host.screenshot(path=f"{OUT}/p3-host-tv.png")

    # Wrong pairing code
    bad = page("bad", {"width": 390, "height": 844}, None, True)
    sign_in(bad, BASE, "Bad", BASE); bad.fill("#join-code", code + "000001" if not hcode.endswith("000001") else code + "000002"); bad.click("#join-start")
    check(wait(lambda: "pairing code doesn't match" in bad.inner_text("#join-error")), "a wrong pairing code gets a clear message")

    # Removing Sarah ends her phone's call too
    open_side(host)
    host.locator("#people-list button.chip", has_text="Sarah").click()
    host.click("#person-remove")
    check(wait(lambda: "left the room" in phone.inner_text("#waiting-text")), "removing Sarah also ends her phone's call")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
