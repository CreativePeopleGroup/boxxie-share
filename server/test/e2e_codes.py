"""Browser test: Boxxie codes (sign in without email), friend codes and the authenticator-app lock.
Run the dev server first, then:  python3 test/e2e_codes.py <screenshot-dir>
"""
import base64, hashlib, hmac, os, struct, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_common import unique_ip, wait

BASE = os.environ.get("BASE", "http://127.0.0.1:8788/")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
res = []
def check(c, label):
    res.append(c)
    print(("PASS  " if c else "FAIL  ") + label, flush=True)

def totp(secret, t=None):
    key = base64.b32decode(secret.replace(" ", "") + "=" * (-len(secret.replace(" ", "")) % 8))
    step = int((t or time.time()) // 30)
    h = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    o = h[-1] & 15
    return "%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)

with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    def page(name, vp, mobile=False):
        kw = dict(viewport=vp, extra_http_headers={"X-Test-IP": unique_ip()})
        if mobile: kw.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        ctx = b.new_context(**kw)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
        pg = ctx.new_page()
        pg.on("pageerror", lambda e, n=name: errs.append(f"{n}: {e}"))
        pg.on("dialog", lambda d: d.accept())
        return pg

    # Asha makes an account on her phone: just her name
    asha = page("asha", {"width": 390, "height": 844}, True)
    asha.goto(BASE)
    asha.wait_for_selector("#code-signin:not([hidden])")
    check(asha.is_visible("#new-name") and asha.is_visible("#signin-boxxcode"), "sign-in offers 'create my account' and 'sign in with your code'")
    asha.screenshot(path=f"{OUT}/codes-1-signin.png")
    asha.fill("#new-name", "Asha")
    asha.click("#new-create")
    asha.wait_for_selector("#screen-newcode:not([hidden])")
    code = asha.input_value("#newcode-value")
    check(len(code) == 19 and code.startswith("BOXX-"), f"she gets her own Boxxie code ({code})")
    asha.screenshot(path=f"{OUT}/codes-2-your-code.png")
    asha.click("#newcode-copy")
    check(wait(lambda: "Copied" in asha.inner_text("#newcode-copy"), 3), "the code can be copied")
    asha.click("#newcode-done")
    check(wait(lambda: asha.is_visible("#screen-home") and "Asha" in asha.inner_text("#hero-title")), "then she's signed in and on the home screen")

    # Her friend code, and the authenticator lock
    asha.click("#go-friends")
    asha.wait_for_selector("#screen-friends:not([hidden])")
    fcode = asha.inner_text("#my-friend-code")
    check(len(fcode) == 9 and fcode[4] == "-", f"Friends shows her friend code ({fcode})")
    asha.click("#totp-toggle")
    asha.wait_for_selector("#totp-panel:not([hidden])")
    check(asha.locator("#totp-qr svg").count() == 1, "setting up the authenticator shows a QR code")
    secret = asha.inner_text("#totp-secret")
    asha.screenshot(path=f"{OUT}/codes-3-authenticator.png", full_page=True)
    asha.fill("#totp-code", "000000" if totp(secret) != "000000" else "111111")
    asha.click("#totp-submit")
    check(wait(lambda: "isn't right" in asha.inner_text("#totp-msg"), 5), "a wrong number is refused")
    used_at = time.time()
    asha.fill("#totp-code", totp(secret))
    asha.click("#totp-submit")
    check(wait(lambda: "On." in asha.inner_text("#totp-status")), "the right number turns the lock on")

    # Ben adds Asha by her friend code
    ben = page("ben", {"width": 1280, "height": 720})
    ben.goto(BASE)
    ben.wait_for_selector("#code-signin:not([hidden])")
    ben.fill("#new-name", "Ben"); ben.click("#new-create")
    ben.wait_for_selector("#screen-newcode:not([hidden])"); ben.click("#newcode-done")
    ben.wait_for_selector("#screen-home:not([hidden])")
    ben.click("#go-friends")
    ben.fill("#friend-email", fcode.lower())
    ben.click("#friend-add-form button")
    check(wait(lambda: "Request sent" in ben.inner_text("#friend-add-msg")), "Ben adds Asha with her friend code")
    asha.click("#friends-back"); asha.click("#go-friends")
    check(wait(lambda: "Ben" in asha.inner_text("#friend-requests")), "Asha sees Ben's friend request")
    ben.fill("#friend-email", "ZZZZ-ZZZZ"); ben.click("#friend-add-form button")
    check(wait(lambda: "No one has that friend code" in ben.inner_text("#friend-add-msg")), "an unknown friend code is explained")

    # Asha signs in on her laptop with her code + the authenticator
    lap = page("asha-laptop", {"width": 1280, "height": 720})
    lap.goto(BASE)
    lap.wait_for_selector("#code-signin:not([hidden])")
    lap.fill("#signin-boxxcode", "BOXX-BBBB-CCCC-DDDD"); lap.click("#code-signin-btn")
    check(wait(lambda: "isn't right" in lap.inner_text("#signin-error")), "a wrong Boxxie code is refused")
    lap.fill("#signin-boxxcode", code.lower()); lap.click("#code-signin-btn")
    check(wait(lambda: lap.is_visible("#code-otp-row")), "with the lock on, it asks for the authenticator number")
    # a number can't be reused: wait for the next 30-second window
    while int(time.time() // 30) == int(used_at // 30): time.sleep(1)
    lap.fill("#signin-otp", totp(secret)); lap.click("#code-signin-btn")
    check(wait(lambda: lap.is_visible("#screen-home") and "Asha" in lap.inner_text("#hero-title")), "code plus authenticator number signs her in on the laptop")

    # New code: the old one stops working
    lap.click("#go-friends"); lap.click("#code-reset")
    lap.wait_for_selector("#screen-newcode:not([hidden])")
    new_code = lap.input_value("#newcode-value")
    check(new_code != code, "she can get a new Boxxie code")
    lap.click("#newcode-done")
    other = page("other", {"width": 1280, "height": 720})
    other.goto(BASE); other.wait_for_selector("#code-signin:not([hidden])")
    other.fill("#signin-boxxcode", code); other.click("#code-signin-btn")
    check(wait(lambda: "isn't right" in other.inner_text("#signin-error")), "the old code no longer works")

    check(not errs, "no JavaScript errors" + (": " + "; ".join(errs) if errs else ""))
    b.close()

print(f"\n{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
