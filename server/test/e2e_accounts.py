"""Accounts test: sign in with Google / Facebook / email code, friends, room invites, TV sign-in by QR."""
import json, os, re, sys, time, urllib.parse, urllib.request
import cv2
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import sign_in, unique_ip, email_for, wait, open_side, tap

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
FILM = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
TV_UA = "Mozilla/5.0 (Linux; Android 11; AFTKA) AppleWebKit/537.36 Chrome/124 Safari/537.36 BoxxieShareTV/1"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
res = []


def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)


def screen(pg):
    return pg.evaluate("document.querySelector('.screen:not([hidden])').dataset.screen")


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    errs = []

    def page(name, vp=None, ua=None):
        kw = dict(viewport=vp or {"width": 1280, "height": 800}, permissions=["camera", "microphone"], extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw["user_agent"] = ua
        pg = b.new_context(**kw).new_page()
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    # ---- signed out: only the sign-in screen ----
    g = page("google")
    g.goto(BASE)
    check(wait(lambda: screen(g) == "signin"), "signed-out visitors see the sign-in screen")
    check(wait(lambda: g.is_visible("#signin-google") and g.is_visible("#signin-facebook") and g.is_visible("#email-form")), "Google, Facebook and email options are shown")
    g.screenshot(path=f"{OUT}/acc1-signin.png")

    # ---- Google ----
    g.click("#signin-google")
    g.wait_for_selector("#as")
    g.click("#as")
    check(wait(lambda: screen(g) == "home" and "Gina Google" in g.inner_text("#me-name")), "Continue with Google signs you in")
    g.reload()
    check(wait(lambda: screen(g) == "home"), "you stay signed in after closing and reopening")
    g.click("#signout")
    check(wait(lambda: screen(g) == "signin"), "Sign out goes back to the sign-in screen")
    g.reload()
    check(wait(lambda: screen(g) == "signin"), "and stays signed out")

    # ---- Facebook ----
    f = page("facebook")
    f.goto(BASE)
    f.wait_for_selector("#signin-facebook:not([hidden])")
    f.click("#signin-facebook")
    f.wait_for_selector("#as")
    f.click("#as")
    check(wait(lambda: screen(f) == "home" and "Faye Facebook" in f.inner_text("#me-name")), "Continue with Facebook signs you in")

    # ---- Email code (wrong first) ----
    e = page("email")
    e.goto(BASE)
    e.wait_for_selector("#email-form:not([hidden])")
    e.fill("#signin-email", email_for("Mia"))
    e.click("#email-send")
    e.wait_for_selector("#code-form:not([hidden])")
    e.fill("#signin-code", "000000")
    e.click("#code-submit")
    check(wait(lambda: "isn't right" in e.inner_text("#signin-error")), "a wrong email code gets a clear message")
    mail = json.loads(urllib.request.urlopen(BASE.rstrip("/") + "/dev/mail?to=" + urllib.parse.quote(email_for("Mia"))).read())
    code = re.search(r"(\d{6})", mail["subject"]).group(1)
    e.fill("#signin-code", code)
    e.click("#code-submit")
    check(wait(lambda: screen(e) == "home" and "Mia" in e.inner_text("#me-name")), "the right email code signs you in")

    # ---- Friends ----
    ricky = page("ricky", {"width": 1440, "height": 900})
    sign_in(ricky, BASE, "Ricky", BASE)
    sarah = page("sarah", {"width": 390, "height": 844})
    sign_in(sarah, BASE, "Sarah", BASE)
    ricky.click("#go-friends")
    ricky.fill("#friend-email", email_for("Sarah"))
    ricky.click("#friend-add-form button")
    check(wait(lambda: "Request sent" in ricky.inner_text("#friend-add-msg")), "add a friend by email")
    check(wait(lambda: sarah.is_visible("#friends-badge") and sarah.inner_text("#friends-badge") == "1"), "Sarah sees a friend-request badge straight away")
    sarah.click("#go-friends")
    sarah.wait_for_selector("#friend-requests button.allow")
    sarah.screenshot(path=f"{OUT}/acc2-friend-request-phone.png")
    sarah.click("#friend-requests button.allow")
    check(wait(lambda: "Ricky" in sarah.inner_text("#friend-list")), "accepting adds Ricky to Sarah's friends")
    check(wait(lambda: "Sarah" in ricky.inner_text("#friend-list")), "and Sarah to Ricky's")
    ricky.screenshot(path=f"{OUT}/acc3-friends.png")
    ricky.click("#friends-back")
    sarah.click("#friends-back")

    # ---- Room invite ----
    ricky.set_input_files("#film-file", FILM)
    ricky.click("#host-start")
    ricky.wait_for_selector("#code-tiles .tile", state="attached")
    ricky.click("#ctl-play")
    open_side(ricky)
    ricky.click("#invite-open")
    ricky.wait_for_selector("#invite-friends button")
    ricky.screenshot(path=f"{OUT}/acc4-invite-panel.png")
    ricky.click("#invite-friends button")
    check(wait(lambda: "Invited" in ricky.inner_text("#invite-friends")), "host invites a friend from the room")
    check(wait(lambda: sarah.is_visible("#invites") and "Ricky invited you" in sarah.inner_text("#invites")), "the invite pops up on Sarah's home screen live")
    sarah.screenshot(path=f"{OUT}/acc5-invite-phone.png")
    sarah.click("#invite-list button.primary")
    check(wait(lambda: screen(sarah) == "room"), "Join takes Sarah straight in, no 'Let in' needed")
    check(wait(lambda: sarah.evaluate("document.getElementById('film').videoWidth > 0")), "and the film plays for her")
    check(wait(lambda: "Sarah" in ricky.inner_text("#people-list")), "host sees Sarah watching")

    # ---- Not invited: still needs Let in ----
    code_room = "".join(ricky.locator("#code-tiles .tile").all_inner_texts())
    e.fill("#join-code", code_room)
    e.click("#join-start")
    check(wait(lambda: ricky.is_visible("#request-list .allow") and "Mia" in ricky.inner_text("#request-list")), "someone who wasn't invited still has to be let in")

    # ---- TV sign-in by QR ----
    tv = page("tv", {"width": 1920, "height": 1080}, TV_UA)
    tv.goto(BASE)
    check(wait(lambda: screen(tv) == "signin" and tv.locator("#signin-qr svg").count() == 1), "a TV shows a QR code to sign in with your phone")
    check(tv.is_hidden("#signin-google") and tv.is_visible("#signin-inapp"), "TVs explain Google/Facebook happen on the phone")
    tv.screenshot(path=f"{OUT}/acc6-tv-signin.png")
    tv.locator("#signin-qr").screenshot(path=f"{OUT}/acc-qr.png")
    img = cv2.resize(cv2.imread(f"{OUT}/acc-qr.png"), None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    link, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    check("#device=" in link, f"the QR code scans ({link})")
    phone = sarah.context.new_page()
    phone.on("dialog", lambda d: d.accept())
    phone.goto(BASE + link[link.index("#"):])
    check(wait(lambda: screen(phone) == "device" and "Sarah" in phone.inner_text("#device-text")), "Sarah's phone asks 'Sign in on your TV?'")
    phone.screenshot(path=f"{OUT}/acc7-approve-phone.png")
    phone.click("#device-yes")
    check(wait(lambda: "signed in" in phone.inner_text("#device-title")), "phone confirms")
    check(wait(lambda: screen(tv) == "home" and "Sarah" in tv.inner_text("#me-name"), 15), "the TV signs itself in as Sarah within seconds")
    tv.screenshot(path=f"{OUT}/acc8-tv-home.png")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
