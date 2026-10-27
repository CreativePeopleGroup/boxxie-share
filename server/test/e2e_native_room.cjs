// Native-room bridge wiring with real browser media. Android lifecycle is NOT simulated.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8788/';
async function page(browser, name, native) {
  const ip = native ? '10.91.0.1' : '10.91.0.2';
  const response = await fetch(BASE + 'auth/code/create', {method:'POST',headers:{'Content-Type':'application/json','X-Test-IP':ip},body:JSON.stringify({name})});
  const session = await response.json();
  assert(session.token);
  const context = await browser.newContext({viewport:native ? {width:1280,height:720} : {width:390,height:844},
    ...(native ? {userAgent:'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 BoxxieShareTV/1'} : {}),
    extraHTTPHeaders:{'X-Test-IP':ip},storageState:{cookies:[],origins:[{origin:new URL(BASE).origin,localStorage:[{name:'bx:session',value:JSON.stringify(session)}]}]}});
  await context.addInitScript(() => {
    window.__mediaPeers = [];
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Peer,{construct(Target,[config]) {
      const peer = new Target({...config,iceServers:[]}); window.__mediaPeers.push(peer); return peer;
    }});
  });
  if (native) await context.addInitScript({content:'window.__nativeRoomTest=true;\n' + readFileSync(__dirname + '/fake_native.js','utf8')});
  const result = await context.newPage(); result.setDefaultTimeout(20000);
  await result.goto(BASE);
  return result;
}
async function receiving(viewer) {
  await viewer.waitForFunction(async () => {
    const video = document.getElementById('film');
    if (!video.videoWidth || video.currentTime < 0.2) return false;
    for (const peer of window.__mediaPeers) {
      if (peer.signalingState === 'closed') continue;
      for (const r of (await peer.getStats()).values()) {
        if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio' && r.totalAudioEnergy > 0) return true;
      }
    }
    return false;
  });
}
(async () => {
  const browser = await chromium.launch({args:['--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns'],
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    const host = await page(browser,'Native room host',true);
    const viewer = await page(browser,'Native room viewer',false);
    await host.locator('[data-source="screen"]').click();
    await host.locator('[data-quality="smooth"]').click();
    await host.locator('#host-start').click();
    await host.locator('#code-tiles .tile').first().waitFor({state:'attached'});
    const code = (await host.locator('#code-tiles .tile').allTextContents()).join('');
    await viewer.locator('#join-code').fill(code);
    await viewer.locator('#join-start').click();
    await host.locator('#request-list .allow').click();
    await receiving(viewer);
    assert.equal(await host.evaluate(() => window.__nativeRoomStarts),1);
    assert.equal(await host.evaluate(() => window.__nativeCalls.filter(c => c.startsWith('add:')).length),1,
      'The page does not duplicate native viewer-ready handling');
    await host.evaluate(() => { window.__nativeRoomReconnectDelay = 1500; window.__nativeRoomWire.close(); });
    await viewer.locator('#connection-notice').waitFor({state:'visible'});
    const geometry = await viewer.locator('#connection-notice').evaluate(el => {
      const r=el.getBoundingClientRect(), button=el.querySelector('button').getBoundingClientRect();
      return {fits:r.left>=0 && r.right<=innerWidth && r.height<120, target:button.height>=44};
    });
    assert(geometry.fits && geometry.target,'Compact notice fits the phone with a full-size Hide target');
    await viewer.locator('#connection-notice-hide').click();
    assert(await viewer.locator('#connection-notice').isHidden());
    await host.waitForFunction(() => !document.getElementById('connection-notice-text').textContent);
    await receiving(viewer);
    assert.equal(await host.evaluate(() => window.__nativeRoomStarts),1,'Native retry does not restart the browser connection loop');
    // Drop delivery of room events to the app page. The native stand-in must
    // negotiate a refreshed approved viewer directly through its transport.
    await host.evaluate(() => {
      const dispatch = window.boxxieNativeEvent;
      window.boxxieNativeEvent = json => {
        const event = typeof json === 'string' ? JSON.parse(json) : json;
        if (!['room-state','room-message'].includes(event.type)) dispatch(json);
      };
    });
    const age = await viewer.locator('#room-duration').textContent();
    assert(age.startsWith('Open '));
    await viewer.reload();
    await receiving(viewer);
    assert.equal(await host.locator('#request-list .allow').count(),0,'Approved viewer rejoins without another approval');
    assert.equal(await host.evaluate(() => window.__nativeRoomStarts),1);
    assert((await viewer.locator('#room-duration').textContent()).startsWith('Open '));
    console.log('PASS native-room bridge routes generated picture/audio, retries without a browser loop, dismisses notice, and negotiates viewer rejoin while app room-event delivery is suppressed');
  } finally {
    await Promise.race([browser.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Browser shutdown timeout')),10000))]);
  }
})().catch(error => { console.error(error); process.exit(1); });
