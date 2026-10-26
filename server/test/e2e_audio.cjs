// Real browser/WebRTC regression test. The Android bridge is simulated: this cannot
// establish whether a particular Android player allows playback capture.
// Start test/devserver.mjs first. Install playwright and its browser engines.
const { chromium, firefox, webkit } = require('playwright');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8788/';
const engine = process.env.BOXXIE_BROWSER || 'chromium';
const engines = { chromium, firefox, webkit };
assert(engines[engine], `Unknown browser: ${engine}`);
const args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const chromeOptions = { args, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) };
const bridge = readFileSync(`${__dirname}/fake_native.js`, 'utf8');

async function signedInPage(browser, name, options = {}) {
  const ip = `10.50.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const response = await fetch(`${BASE}auth/code/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-IP': ip },
    body: JSON.stringify({ name }),
  });
  assert(response.ok, `Create test account: ${response.status}`);
  const session = await response.json();
  assert(session.token && session.user, 'Test account has a session');
  const context = await browser.newContext({ ...options, extraHTTPHeaders: { 'X-Test-IP': ip } });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('bx:session', JSON.stringify({ token, user }));
    const NativePeer = window.RTCPeerConnection;
    window.__audioTestPeers = [];
    window.RTCPeerConnection = new Proxy(NativePeer, {
      // Both browsers run on this machine: use local ICE, independent of public
      // STUN/TURN availability. Cross-network relay coverage needs a separate test.
      construct(Target, [config]) {
        const peer = new Target({ ...config, iceServers: [] });
        window.__audioTestPeers.push(peer);
        return peer;
      },
    });
  }, { token: session.token, user: session.user });
  return context.newPage();
}

async function receiving(page) {
  const deadline = Date.now() + 30000;
  let received = false;
  while (Date.now() < deadline) {
    received = await page.evaluate(async () => {
    const video = document.getElementById('film');
    if (!video.srcObject || !video.videoWidth || video.currentTime < 0.3 ||
        !video.srcObject.getAudioTracks().some(t => t.readyState === 'live')) return false;
    for (const peer of window.__audioTestPeers) {
      if (peer.connectionState === 'closed') continue;
      const stats = await peer.getStats();
      for (const r of stats.values()) {
        if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio' && r.bytesReceived > 0 &&
            (r.totalAudioEnergy > 0 || r.audioLevel > 0)) return true;
      }
    }
    return false;
    });
    if (received) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!received) console.error(await page.evaluate(async () => ({
    video: { width: document.getElementById('film').videoWidth, time: document.getElementById('film').currentTime },
    details: document.getElementById('screen-diag').textContent,
    peers: await Promise.all(window.__audioTestPeers.map(async p => ({
      state: p.connectionState, ice: p.iceConnectionState, signal: p.signalingState,
      stats: [...(await p.getStats()).values()].filter(r => ['inbound-rtp', 'candidate-pair'].includes(r.type)),
    }))),
  })));
  assert(received, `${engine}: receive rendered video and audio energy within 30 seconds`);
  console.log(`PASS ${engine}: rendered video and received nonzero audio energy over WebRTC`);
}

(async () => {
  let hostBrowser, viewerBrowser;
  try {
    hostBrowser = await chromium.launch(chromeOptions);
    viewerBrowser = await engines[engine].launch(engine === 'chromium' ? chromeOptions :
      engine === 'firefox' ? { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } } : {});
    const host = await signedInPage(hostBrowser, 'Audio host', {
      userAgent: 'Mozilla/5.0 (Linux; Android 11; AFTKA) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 BoxxieShareTV/1',
    });
    await host.addInitScript(bridge);
    const viewer = await signedInPage(viewerBrowser, `Audio ${engine}`);
    const errors = [];
    for (const page of [host, viewer]) page.on('pageerror', error => errors.push(String(error)));
    for (const page of [host, viewer]) page.on('console', msg => {
      if (msg.type() === 'warning' || msg.type() === 'error') console.error(msg.text());
    });
    await host.goto(BASE);
    await host.locator('[data-source="screen"]').click();
    await host.locator('#host-start').click();
    await host.locator('#code-tiles .tile').first().waitFor({ state: 'attached' });
    const code = (await host.locator('#code-tiles .tile').allTextContents()).join('');
    await viewer.goto(`${BASE}#join=${code}`);
    await viewer.locator('#join-start').click();
    await host.locator('#request-list .allow').click();
    await host.locator('#test-tv-capture').click();
    assert((await host.evaluate(() => window.__nativeCalls)).includes('tv-capture-test'),
      'TV sound capture control calls the Android bridge');
    console.log('PASS TV sound capture control reaches the native bridge (simulated)');
    try {
      await receiving(viewer);
    } catch (error) {
      console.error('Sender connection details', JSON.stringify(await host.evaluate(async () =>
        Promise.all(window.__audioTestPeers.map(async p => ({
          state: p.connectionState, ice: p.iceConnectionState, signal: p.signalingState,
          localSet: !!p.localDescription, remoteSet: !!p.remoteDescription,
          stats: [...(await p.getStats()).values()].filter(r => r.type === 'outbound-rtp'),
        })))), null, 2));
      console.error('Browser errors', errors);
      throw error;
    }

    // Reproduce a browser refusing play(): the retry control must remain available.
    await viewer.evaluate(async () => {
      const film = document.getElementById('film');
      const button = document.getElementById('sound-on');
      film.play = () => Promise.reject(new DOMException('Test playback refusal', 'NotAllowedError'));
      button.hidden = false;
      await button.onclick();
      if (button.hidden) throw new Error('Playback refusal hid the sound retry button');
      delete film.play;
    });
    console.log(`PASS ${engine}: refused playback keeps the sound retry control`);
    await viewer.locator('#sound-on').click();
    await viewer.waitForFunction(() => {
      const film = document.getElementById('film');
      return !film.paused && !film.muted && document.getElementById('sound-on').hidden;
    });
    console.log(`PASS ${engine}: user gesture starts unmuted playback`);

    // Restart the native session: viewer must accept fresh audio/video tracks.
    await host.locator('#stage').dispatchEvent('mousemove');
    await host.locator('#ctl-stopshare').click();
    await viewer.locator('#stage-empty').waitFor({ state: 'visible' });
    await host.locator('#stage').dispatchEvent('mousemove');
    await host.locator('#ctl-reshare').click();
    await receiving(viewer);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  } finally {
    if (viewerBrowser) await viewerBrowser.close();
    if (hostBrowser) await hostBrowser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
