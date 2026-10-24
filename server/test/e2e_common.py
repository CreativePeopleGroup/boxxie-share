"""Shared helpers for the browser tests: sign in through the real email-code screen."""
import json, random, time, urllib.request

RUN = "%04d" % random.randint(0, 9999)  # keeps emails unique between runs on one test server


def email_for(name):
    return f"{name.lower()}+t{RUN}@example.com"


def unique_ip():
    return "10.%d.%d.%d" % (random.randint(1, 250), random.randint(1, 250), random.randint(1, 250))


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


def sign_in(pg, url, name, base):
    """Open url, sign in with an email code as `name`, and wait until the app moves on."""
    pg.goto(url)
    pg.wait_for_selector("#screen-signin:not([hidden])", timeout=15000)
    pg.wait_for_selector("#email-form:not([hidden])", timeout=15000)
    email = email_for(name)
    pg.fill("#signin-email", email)
    pg.click("#email-send")
    pg.wait_for_selector("#code-form:not([hidden])", timeout=15000)
    mail = json.loads(urllib.request.urlopen(base.rstrip("/") + "/dev/mail?to=" + urllib.parse.quote(email)).read())
    code = __import__("re").search(r"(\d{6})", mail["subject"]).group(1)
    pg.fill("#signin-code", code)
    pg.click("#code-submit")
    if not wait(lambda: pg.evaluate("document.querySelector('#screen-signin').hidden"), 15):
        raise RuntimeError("sign-in failed: " + pg.inner_text("#signin-error"))


def open_side(pg):
    """Open the chat drawer on a big screen (phones always show it under the film)."""
    pg.evaluate("""() => { const r = document.getElementById('screen-room');
      if (r.classList.contains('side-hidden') && getComputedStyle(document.getElementById('side')).display === 'none')
        document.getElementById('toggle-side').click(); }""")


def tap(pg, sel):
    """Click a dock button: wake the faded controls first, like moving the mouse."""
    pg.evaluate("() => document.getElementById('stage').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))")
    pg.click(sel)
