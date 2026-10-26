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
  const context = await browser.newContext({ ...options, extraHTTPHeaders: { 'X-Test-IP': ip },
    storageState: { cookies: [], origins: [{ origin: new URL(BASE).origin,
      localStorage: [{ name: 'bx:session', value: JSON.stringify({ token: session.token, user: session.user }) }] }] },
  });
  // Seed credentials once, not on every navigation: refresh tests must exercise
  // the application's real session persistence rather than repair it in a fixture.
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  await context.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = new Proxy(NativeSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        window.__testSockets.push(socket);
        return socket;
      },
    });
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
  });
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

async function mediaProgress(page) {
  return page.evaluate(async () => {
    let frames = 0, energy = 0;
    for (const peer of window.__audioTestPeers) {
      if (peer.connectionState === 'closed') continue;
      for (const r of (await peer.getStats()).values()) {
        if (r.type !== 'inbound-rtp') continue;
        frames += r.framesDecoded || 0;
        energy += r.totalAudioEnergy || 0;
      }
    }
    return { frames, energy, time: document.getElementById('film').currentTime };
  });
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
    await host.locator('[data-quality="smooth"]').click();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
      await host.setViewportSize(viewport);
      await host.evaluate(phone => document.documentElement.classList.toggle('tv', !phone), viewport.width < 600);
      const boxes = await host.locator('[data-quality]').evaluateAll(buttons => buttons.map(b => {
        const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, y: r.top, fits: b.scrollWidth <= b.clientWidth && b.scrollHeight <= b.clientHeight };
      }));
      assert(boxes.every(b => b.w > 0 && Math.abs(b.w - boxes[0].w) < 1 && Math.abs(b.h - boxes[0].h) < 1 && Math.abs(b.y - boxes[0].y) < 1),
        'Quality buttons have matching dimensions and alignment');
      assert(boxes.every(b => b.fits), 'Quality labels fit inside their buttons');
      await host.screenshot({ path: `/tmp/boxxie-ui-quality-${viewport.width}-${engine}.png` });
    }
    await host.locator('#host-start').click();
    assert.deepEqual(await host.evaluate(() => window.__lastShareConfig.quality),
      { label: 'Smooth 720p', height: 720, width: 1280, maxBitrate: 2500000 },
      'Smooth profile passes a 720p / 2.5 Mbps limit to the native engine');
    await host.locator('#code-tiles .tile').first().waitFor({ state: 'attached' });
    const code = (await host.locator('#code-tiles .tile').allTextContents()).join('');
    await viewer.goto(`${BASE}#join=${code}`);
    await viewer.locator('#join-start').click();
    await host.locator('#request-list .allow').click();
    await host.locator('#test-tv-capture').click();
    assert((await host.evaluate(() => window.__nativeCalls)).includes('tv-capture-test'),
      'TV sound capture control calls the Android bridge');
    console.log('PASS TV sound capture control reaches the native bridge (simulated)');
    async function checkButtonGroups() {
      const groups = await host.evaluate(() => [
        ['test-sound', 'test-tv-capture'], ['ctl-reshare', 'ctl-stopshare'],
      ].map(ids => ids.map(id => {
        const box = document.getElementById(id).getBoundingClientRect();
        return { id, width: box.width, height: box.height, left: box.left, top: box.top };
      })));
      for (const [a, b] of groups) {
        assert(a.width > 0 && a.height > 0, `${a.id} is laid out`);
        assert(Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1,
          `Matched control dimensions: ${JSON.stringify([a, b])}`);
      }
      assert(Math.abs(groups[0][0].left - groups[0][1].left) < 1, 'Sound buttons align vertically');
      assert(Math.abs(groups[1][0].top - groups[1][1].top) < 1, 'Sharing buttons align horizontally');
    }
    await checkButtonGroups();
    await host.screenshot({ path: `/tmp/boxxie-ui-tv-${engine}.png` });
    await host.setViewportSize({ width: 390, height: 844 });
    await host.evaluate(() => document.documentElement.classList.remove('tv'));
    await checkButtonGroups();
    await host.setViewportSize({ width: 1280, height: 720 });
    await host.evaluate(() => document.documentElement.classList.add('tv'));
    console.log(`PASS ${engine}: matched button dimensions and alignment at TV and phone widths`);
    try {
      await receiving(viewer);
      await viewer.setViewportSize({ width: 390, height: 844 });
      await viewer.screenshot({ path: `/tmp/boxxie-ui-phone-${engine}.png` });
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
    await viewer.evaluate(() => document.getElementById('viewer-status').click());
    await viewer.waitForFunction(() => document.getElementById('screen-diag').textContent.includes('Mbps received'));
    await viewer.evaluate(() => document.getElementById('viewer-status').click());
    console.log(`PASS ${engine}: viewer network diagnostics report measured receive bitrate`);

    const tracksBefore = await viewer.evaluate(() => document.getElementById('film').srcObject.getTracks().map(t => t.id).sort());
    const addsBefore = await host.evaluate(() => window.__nativeCalls.filter(c => c.startsWith('add:')).length);
    await host.evaluate(() => window.__pauseHostPlayback(true));
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert(await viewer.locator('#screen-room').isVisible(), 'Source pause keeps the viewer in the room');
    // Browsers can pause the element during an interruption without ending tracks.
    await viewer.evaluate(() => document.getElementById('film').pause());
    await viewer.waitForFunction(() => !document.getElementById('film').paused);
    const beforeResume = await mediaProgress(viewer);
    await host.evaluate(() => window.__pauseHostPlayback(false));
    const deadline = Date.now() + 15000;
    let resumed = false;
    while (Date.now() < deadline) {
      const current = await mediaProgress(viewer);
      if (current.frames > beforeResume.frames + 5 && current.energy > beforeResume.energy + 0.001 && current.time > beforeResume.time + 0.3) {
        resumed = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(resumed, 'Host resume restores advancing video, audio energy and element playback');
    assert.deepEqual(await viewer.evaluate(() => document.getElementById('film').srcObject.getTracks().map(t => t.id).sort()), tracksBefore,
      'Pause/resume reuses the existing tracks');
    assert.equal(await host.evaluate(() => window.__nativeCalls.filter(c => c.startsWith('add:')).length), addsBefore,
      'An intentional source pause does not rebuild the media connection');
    console.log(`PASS ${engine}: host pause/resume and interrupted viewer playback recover on existing tracks`);

    // A failed media path can coexist with a healthy room socket. Repair just
    // this viewer's screen peer, without new host approval or a room reload.
    await viewer.evaluate(() => {
      const pc = window.__audioTestPeers.find(p => p.connectionState !== 'closed' && p.oniceconnectionstatechange);
      if (!pc) throw new Error('Screen peer missing');
      Object.defineProperty(pc, 'iceConnectionState', { value: 'failed', configurable: true });
      pc.dispatchEvent(new Event('iceconnectionstatechange'));
    });
    await host.waitForFunction(expected => window.__nativeCalls.filter(c => c.startsWith('add:')).length === expected, addsBefore + 1);
    await receiving(viewer);
    assert.equal(await host.evaluate(() => window.__nativeCalls.filter(c => c.startsWith('add:')).length), addsBefore + 1);
    assert.equal(await host.locator('#request-list .allow').count(), 0);
    console.log(`PASS ${engine}: failed screen connection recovers without leaving the room`);

    // Restart the native session: viewer must accept fresh audio/video tracks.
    await host.locator('#stage').dispatchEvent('mousemove');
    await host.locator('#ctl-stopshare').click();
    await viewer.locator('#stage-empty').waitFor({ state: 'visible' });
    await host.locator('#stage').dispatchEvent('mousemove');
    await host.locator('#ctl-reshare').click();
    await receiving(viewer);
    // A refresh must restore the same authenticated viewer without another approval,
    // including a locked room. Do not inject credentials again during reload.
    const tokenBefore = await viewer.evaluate(() => JSON.parse(localStorage.getItem('bx:session')).token);
    await host.evaluate(() => document.getElementById('lock-room').click());
    await host.waitForFunction(() => document.getElementById('lock-room').getAttribute('aria-pressed') === 'true');
    await viewer.reload();
    await receiving(viewer);
    assert.equal(await viewer.evaluate(() => JSON.parse(localStorage.getItem('bx:session')).token), tokenBefore);
    assert.equal(await host.locator('#request-list .allow').count(), 0, 'Refresh needs no new approval');
    assert.equal(await host.locator('#viewer-health li').count(), 1, 'Refreshed viewer appears only once');
    console.log(`PASS ${engine}: refresh restores account and approved room while locked`);

    // Exercise a failed ticket fetch during a disconnect, then simultaneous wake/online events.
    await viewer.route('**/api/ticket', route => route.abort());
    const ticketFailed = viewer.waitForEvent('requestfailed', {
      predicate: request => new URL(request.url()).pathname === '/api/ticket', timeout: 15000,
    });
    await viewer.evaluate(() => window.__testSockets.filter(w =>
      w.url.includes('/api/rooms/') && w.readyState === 1).forEach(w => w.close()));
    await ticketFailed;
    assert(await viewer.locator('#screen-room').isVisible(), 'A network error must not log the viewer out');
    await viewer.unroute('**/api/ticket');
    await viewer.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await receiving(viewer);
    assert.equal(await host.locator('#viewer-health li').count(), 1, 'Reconnect does not duplicate the viewer');
    console.log(`PASS ${engine}: network drop and failed ticket fetch recover without duplicate connections`);

    await viewer.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 60000;
      window.dispatchEvent(new Event('pageshow'));
      Date.now = now;
    });
    await receiving(viewer);
    assert.equal(await host.locator('#viewer-health li').count(), 1);
    console.log(`PASS ${engine}: returning to a stale socket reconnects without waiting for its close handshake`);

    await viewer.evaluate(() => document.getElementById('leave').click());
    await viewer.reload();
    await viewer.locator('#screen-home:not([hidden])').waitFor();
    assert.equal(await viewer.evaluate(() => sessionStorage.getItem('bx:viewerRoom')), null,
      'Explicit leave must not auto-rejoin');
    await viewer.locator('#join-code').fill(code);
    await viewer.locator('#join-start').click();
    await receiving(viewer);
    console.log(`PASS ${engine}: explicit leave stays out after reload; manual rejoin still works`);

    await host.evaluate(() => document.getElementById('people-open').click());
    await host.locator('#people-list button.chip').filter({ hasText: `Audio ${engine}` }).click();
    host.once('dialog', dialog => dialog.accept());
    await host.locator('#person-remove').click();
    await viewer.waitForFunction(() => document.getElementById('waiting-text').textContent.includes('removed'));
    assert.equal(await viewer.evaluate(() => sessionStorage.getItem('bx:viewerRoom')), null);
    await viewer.reload();
    await viewer.locator('#screen-home:not([hidden])').waitFor();
    console.log(`PASS ${engine}: removed viewer is not silently restored on refresh`);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  } finally {
    if (viewerBrowser) await viewerBrowser.close();
    if (hostBrowser) await hostBrowser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
