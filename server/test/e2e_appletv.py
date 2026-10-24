"""Browser test: the home cards line up, and iPhone viewers get the Apple TV (Screen Mirroring) flow.
Run: python3 test/e2e_appletv.py <screenshot-dir> <path-to-test-video>"""
import sys, time
sys.path.insert(0, "/home/claude/boxxie-share/server/test")
from playwright.sync_api import sync_playwright
from e2e_common import sign_in, unique_ip, wait, tap
BASE="http://127.0.0.1:8788/"; OUT=sys.argv[1]; FILM=sys.argv[2]
IPHONE="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
ok=[]
def check(c,l): ok.append(c); print(("PASS  " if c else "FAIL  ")+l)
with sync_playwright() as p:
    b=p.chromium.launch(args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream","--autoplay-policy=no-user-gesture-required"])
    errs=[]
    h=b.new_context(viewport={"width":1280,"height":720}, extra_http_headers={"X-Test-IP": unique_ip()}).new_page()
    h.on("pageerror", lambda e: errs.append(str(e))); h.on("dialog", lambda d: d.accept())
    sign_in(h, BASE, "Ricky", BASE); h.set_input_files("#film-file", FILM); h.wait_for_timeout(300)
    hh=h.evaluate("(()=>{const a=document.getElementById('host-form').getBoundingClientRect(),c=document.getElementById('join-form').getBoundingClientRect(),s=document.querySelector('#screen-home .topbar').getBoundingClientRect(),x=document.getElementById('host-start').getBoundingClientRect(),y=document.getElementById('join-start').getBoundingClientRect();return [a.height,c.height,a.width,c.width,a.bottom,s.bottom,x.bottom,y.bottom,document.documentElement.scrollHeight]})()")
    print(hh)
    check(abs(hh[0]-hh[1])<1 and abs(hh[2]-hh[3])<1, "both home cards are the same size")
    check(abs(hh[4]-hh[5])<1 and abs(hh[6]-hh[7])<1, "sidebar, cards and both buttons end on the same line")
    check(hh[8]<=720, "home fits a 1280x720 screen")
    h.screenshot(path=f"{OUT}/home-even.png")
    h.click("#host-start"); h.wait_for_selector("#code-tiles .tile", state="attached")
    code="".join(h.locator("#code-tiles .tile").all_inner_texts()); h.click("#ctl-play")
    check(h.is_hidden("#airplay-open"), "no Apple TV button on a non-Apple computer")
    v=b.new_context(viewport={"width":390,"height":844}, user_agent=IPHONE, is_mobile=True, has_touch=True, extra_http_headers={"X-Test-IP": unique_ip()}).new_page()
    v.on("pageerror", lambda e: errs.append(str(e))); v.on("dialog", lambda d: d.accept())
    sign_in(v, BASE+"#join="+code, "Sarah", BASE); v.click("#join-start")
    h.wait_for_selector("#request-list .allow"); h.click("#request-list .allow")
    check(wait(lambda: v.evaluate("document.getElementById('film').videoWidth>0")), "iPhone gets the film")
    check(v.is_visible("#airplay-open"), "iPhone shows the Apple TV button")
    v.click("#airplay-open")
    check(v.is_visible("#airplay-panel") and "Screen Mirroring" in v.inner_text("#airplay-panel"), "Apple TV sheet explains Screen Mirroring")
    v.screenshot(path=f"{OUT}/appletv-sheet.png")
    v.click("#airplay-close")
    v.set_viewport_size({"width":844,"height":390}); time.sleep(4)
    r=v.evaluate("(()=>{const s=document.getElementById('stage').getBoundingClientRect();return [s.width,s.height]})()")
    check(r[0]==844 and r[1]==390, f"phone turned sideways: film fills the screen {r}")
    v.screenshot(path=f"{OUT}/appletv-landscape.png")
    check(not errs, "no JavaScript errors "+"; ".join(errs))
    b.close()
print(f"{sum(ok)}/{len(ok)}")
