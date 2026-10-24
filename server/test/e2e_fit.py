"""Browser test: the home screen fits without scrolling, and both boxes line up, on 8 screen sizes.
Run: python3 test/e2e_fit.py <screenshot-dir> <path-to-test-video>"""
import sys
sys.path.insert(0, "/home/claude/boxxie-share/server/test")
from playwright.sync_api import sync_playwright
from e2e_common import sign_in, unique_ip
BASE="http://127.0.0.1:8788/"; OUT=sys.argv[1]; FILM=sys.argv[2]
UA="Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
IP="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
sizes=[("iphone15",390,844,IP,False),("iphoneSE",375,667,IP,False),("android",412,915,UA,False),("android-small",360,740,UA,False),("tablet",820,1180,IP,False),("laptop",1280,720,None,True),("desktop",1440,900,None,True),("tv",1920,1080,None,True)]
bad=0
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,w,h,ua,desk in sizes:
        kw=dict(viewport={"width":w,"height":h}, extra_http_headers={"X-Test-IP": unique_ip()})
        if ua: kw.update(user_agent=ua, is_mobile=not desk and w<800, has_touch=not desk)
        pg=b.new_context(**kw).new_page()
        if not desk: pg.add_init_script("try { delete MediaDevices.prototype.getDisplayMedia } catch (e) {}")
        sign_in(pg, BASE, "Box" + name.replace("-", "").capitalize(), BASE)
        pg.set_input_files("#film-file", FILM); pg.wait_for_timeout(300)
        pg.evaluate("document.activeElement.blur(); window.scrollTo(0,0)")
        sh=pg.evaluate("document.documentElement.scrollHeight"); sw=pg.evaluate("document.documentElement.scrollWidth")
        box=pg.evaluate("(()=>{const a=document.getElementById('host-form').getBoundingClientRect(),c=document.getElementById('join-form').getBoundingClientRect();return [a.left,a.width,c.left,c.width,a.height,c.height,a.top,c.top]})()")
        stacked = box[6]!=box[7]
        aligned = abs(box[0]-box[2])<1 and abs(box[1]-box[3])<1 if stacked else abs(box[4]-box[5])<1 and abs(box[1]-box[3])<1
        print("   boxes", "aligned and same size" if aligned else "NOT aligned", [round(x) for x in box])
        bad += not aligned
        fits = sh<=h and sw<=w
        bad += not fits
        print(("FITS " if fits else "OVER ")+f"{name} {w}x{h}: page {sw}x{sh}")
        pg.screenshot(path=f"{OUT}/fit-{name}.png")
    b.close()
sys.exit(1 if bad else 0)
