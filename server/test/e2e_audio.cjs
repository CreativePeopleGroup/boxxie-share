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

async function bounded(operation, label, ms = 10000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${engine}: ${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

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
    received = await bounded(page.evaluate(async () => {
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
    }), 'read received video/audio statistics');
    if (received) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!received) console.error(await bounded(page.evaluate(async () => ({
    screens: [...document.querySelectorAll('.screen')].filter(s => !s.hidden).map(s => s.id),
    waiting: document.getElementById('waiting-text').textContent,
    joinError: document.getElementById('join-error').textContent,
    code: document.getElementById('join-code').value,
    signedIn: !!localStorage.getItem('bx:session'),
    sockets: window.__testSockets.map(s => s.readyState),
    video: { width: document.getElementById('film').videoWidth, time: document.getElementById('film').currentTime },
    details: document.getElementById('screen-diag').textContent,
    peers: await Promise.all(window.__audioTestPeers.map(async p => ({
      state: p.connectionState, ice: p.iceConnectionState, signal: p.signalingState,
      stats: [...(await p.getStats()).values()].filter(r => ['inbound-rtp', 'candidate-pair'].includes(r.type)),
    }))),
  })), 'read failed receive diagnostics'));
  assert(received, `${engine}: receive rendered video and audio energy within 30 seconds`);
  console.log(`PASS ${engine}: rendered video and received nonzero audio energy over WebRTC`);
}

async function mediaProgress(page) {
  return bounded(page.evaluate(async () => {
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
  }), 'read media progress');
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
    const networkTest = process.env.BOXXIE_NETWORK_TEST === '1';
    await host.addInitScript(value => { window.__networkTest = value; }, networkTest);
    const viewer = await signedInPage(viewerBrowser, `Audio ${engine}`);
    const errors = [];
    for (const page of [host, viewer]) page.on('pageerror', error => errors.push(String(error)));
    for (const page of [host, viewer]) page.on('console', msg => {
      if (msg.type() === 'warning' || msg.type() === 'error') console.error(msg.text());
    });
    // Cold load with deferred app setup held back: the home cards must not flash
    // at desktop size before TV classification, authentication and fitting.
    let releaseSetup;
    const setupGate = new Promise(resolve => { releaseSetup = resolve; });
    let releaseFont;
    const fontGate = new Promise(resolve => { releaseFont = resolve; });
    await host.route('**/app.js', async route => { await setupGate; await route.continue(); });
    await host.route('**/fonts/inter-latin.woff2', async route => { await fontGate; await route.continue(); });
    const navigation = host.goto(BASE, { waitUntil: 'domcontentloaded' });
    await host.waitForFunction(() => !!document.getElementById('screen-home'));
    assert(await host.evaluate(() => document.documentElement.classList.contains('tv')), 'TV layout is classified before deferred setup');
    assert(await host.locator('#screen-home').isHidden(), 'Uninitialised home cards remain hidden');
    releaseSetup();
    await navigation;
    await host.unroute('**/app.js');
    await host.locator('#screen-home:not([hidden])').waitFor();
    assert.equal(await host.locator('[data-quality="auto"]').getAttribute('aria-checked'), 'true', 'Supported hosts default to Auto');
    assert.equal(await host.locator('#max-viewers').inputValue(), '3', 'Room capacity defaults to three viewers');
    assert.deepEqual(await host.locator('#max-viewers option').evaluateAll(options => options.map(o => o.value)),
      ['2', '3', '4', '6', '8'], 'Room capacity still offers up to eight viewers');
    assert((await host.locator('#device-info').textContent()).includes('Simulated TV'), 'Account diagnostics identify the reported device');
    // Force an actually late font response, beyond font-display: optional's
    // brief initial window, rather than testing only a warm/fast font load.
    await new Promise(resolve => setTimeout(resolve, 200));
    const initialCards = await host.locator('.home-grid > .card').evaluateAll(cards => cards.map(c => {
      const r = c.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }));
    releaseFont();
    await host.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    await host.unroute('**/fonts/inter-latin.woff2');
    const settledCards = await host.locator('.home-grid > .card').evaluateAll(cards => cards.map(c => {
      const r = c.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }));
    assert(initialCards.every((box, i) => box.every((v, j) => Math.abs(v - settledCards[i][j]) < 1)),
      'Home card geometry stays stable after startup and font loading');
    console.log(`PASS ${engine}: cold startup sizes TV cards before showing them, without a late font/layout jump`);
    // Fail at the offending recovery/UI condition instead of waiting for the
    // workflow's global timeout with no useful location or assertion.
    host.setDefaultTimeout(20000);
    viewer.setDefaultTimeout(20000);
    await viewer.goto(BASE);
    await viewer.locator('#go-friends').click();
    const publicId = (await viewer.locator('#my-friend-code').textContent()).replace(/-/g, '');
    assert(/^[A-Z0-9]{8}$/.test(publicId), 'A public Friend ID is available');
    const signinWithFriendId = await fetch(`${BASE}auth/code/signin`, {
      method:'POST', headers:{'Content-Type':'application/json','X-Test-IP':'10.77.11.9'}, body:JSON.stringify({code:publicId}),
    });
    assert.equal(signinWithFriendId.status,400,'Friend ID cannot sign in to an account');
    await host.locator('#go-friends').click();
    for (const size of [{width:1280,height:720},{width:960,height:540}]) {
      await host.setViewportSize(size);
      await host.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const fits = await host.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
      assert(fits,'Friends stays on one TV page');
    }
    await host.setViewportSize({width:1280,height:720});
    await host.locator('#friend-email').focus();
    const beforeKeyboard = await host.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tvz'));
    await host.setViewportSize({width:1280,height:400});
    await host.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await host.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tvz')),beforeKeyboard,
      'A TV keyboard height change does not shrink the interface');
    await host.setViewportSize({width:1280,height:720});
    await host.locator('#friend-email').fill(publicId);
    await host.locator('#friend-add-form button').click();
    await viewer.locator('#friend-requests button').filter({hasText:'Accept'}).click();
    await host.locator('#friend-list button').filter({hasText:'Invite to watch'}).waitFor();
    await host.locator('#account-open').click();
    await host.locator('#screen-account:not([hidden])').waitFor();
    assert(await host.locator('#rename-input').isVisible(),'Account settings remain accessible separately');
    await host.locator('#account-back').click();
    await host.screenshot({path:`/tmp/boxxie-ui-friends-${engine}.png`});
    await host.locator('#friend-list button').filter({hasText:'Invite to watch'}).click();
    await host.locator('#screen-home:not([hidden])').waitFor();
    console.log(`PASS ${engine}: public Friend ID, one-page Friends, account separation and keyboard sizing`);
    await host.locator('[data-source="screen"]').click();
    await host.locator('#max-viewers').selectOption('8');
    for (const width of [960, 1280, 1920]) {
      await host.setViewportSize({ width, height: Math.round(width * 9 / 16) });
      await host.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const stability = await host.evaluate(async () => {
        const root = document.documentElement;
        const elements = [...document.querySelectorAll('.home-grid > .card, [data-source], [data-quality], #max-viewers, #host-start, #join-start')];
        const bounds = () => elements.map(el => {
          const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
        });
        const initial = bounds(), frames = [], writes = [], notes = [];
        const observer = new MutationObserver(records => writes.push(...records.map(r => r.oldValue)));
        observer.observe(root, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
        for (const q of ['auto', 'hd', '4k', 'smooth', 'auto']) {
          document.querySelector(`[data-quality="${q}"]`).click();
          // Reproduce content-triggered TV WebView resize notifications.
          window.dispatchEvent(new Event('resize'));
          notes.push([...document.querySelectorAll('[data-quality-note][aria-hidden="false"]')].map(n => n.dataset.qualityNote));
          for (let i = 0; i < 4; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            frames.push(bounds());
          }
        }
        observer.disconnect();
        return { initial, frames, writes, notes };
      });
      assert(stability.frames.every(frame => frame.every((box, i) => box.every((v, j) => Math.abs(v - stability.initial[i][j]) < 1))),
        `${width}px TV: resolution selection keeps card/button positions and dimensions stable`);
      assert.equal(stability.writes.length, 0, 'Resolution changes and unchanged-viewport resize events do not reset TV zoom');
      assert.deepEqual(stability.notes, [['auto'], ['hd'], ['4k'], ['smooth'], ['auto']], 'Only the selected resolution help is exposed');
      assert.equal(await host.locator('#max-viewers').inputValue(), '8', 'Resolution changes preserve the selected eight-viewer capacity');
    }
    await host.setViewportSize({ width: 1280, height: 720 });
    await host.locator('#max-viewers').selectOption('3');
    console.log(`PASS ${engine}: repeated resolution changes stay stable across 960/1280/1920 TV widths`);
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
      const settings = await host.evaluate(() => {
        const quality = document.querySelector('[aria-labelledby="quality-label"]').getBoundingClientRect();
        const viewers = document.getElementById('max-viewers').getBoundingClientRect();
        const sources = [...document.querySelectorAll('[data-source]')].map(b => b.getBoundingClientRect());
        return { aligned: Math.abs(quality.top - viewers.top) < 1 && Math.abs(quality.height - viewers.height) < 1,
          sources: sources.every(r => Math.abs(r.width - sources[0].width) < 1 && Math.abs(r.height - sources[0].height) < 1) };
      });
      assert(settings.aligned && settings.sources, 'Source buttons match; picture and viewer-count controls align at the same height');
      await host.screenshot({ path: `/tmp/boxxie-ui-quality-${viewport.width}-${engine}.png` });
    }
    const actions = await host.evaluate(() => ['host-start', 'join-start'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect(); return { width:r.width, height:r.height, bottom:r.bottom };
    }));
    assert(actions.every(a => a.width > 0 && a.height > 0 && Math.abs(a.width - actions[0].width) < 1 && Math.abs(a.height - actions[0].height) < 1 && Math.abs(a.bottom - actions[0].bottom) < 1),
      'Home actions match in size and baseline');
    if (networkTest) await host.locator('[data-quality="auto"]').click();
    await host.locator('#host-start').click();
    assert.deepEqual(await host.evaluate(() => window.__lastShareConfig.quality),
      networkTest ? { label: 'Auto 1080p', height: 1080, width: 1920, maxBitrate: 8000000, automatic: true }
        : { label: 'Smooth 720p', height: 720, width: 1280, maxBitrate: 2500000 },
      'The selected profile reaches the native bridge with its correct limits');
    await host.locator('#code-tiles .tile').first().waitFor({ state: 'attached' });
    const code = (await host.locator('#code-tiles .tile').allTextContents()).join('');
    await viewer.locator('#friends-invite-list button').filter({hasText:'Join',exact:true}).click();
    await viewer.locator('#screen-room:not([hidden])').waitFor();
    assert.equal(await host.locator('#request-list .allow').count(),0,'Explicit host invitation supplies approval without a typed room code');
    await host.locator('#help-open').click();
    await host.locator('#test-tv-capture').click();
    assert((await host.evaluate(() => window.__nativeCalls)).includes('tv-capture-test'),
      'TV sound capture control calls the Android bridge');
    console.log('PASS TV sound capture control reaches the native bridge (simulated)');
    async function checkButtonGroups() {
      const groups = await host.evaluate(() => [
        ['test-sound', 'test-tv-capture', 'copy-diagnostics'], ['ctl-reshare', 'ctl-stopshare'],
      ].map(ids => ids.map(id => {
        const box = document.getElementById(id).getBoundingClientRect();
        return { id, width: box.width, height: box.height, left: box.left, top: box.top };
      })));
      for (const [a, ...others] of groups) {
        assert(a.width > 0 && a.height > 0, `${a.id} is laid out`);
        for (const b of others) assert(Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1,
          `Matched control dimensions: ${JSON.stringify([a, b])}`);
      }
      assert(Math.abs(groups[0][0].left - groups[0][1].left) < 1, 'Sound buttons align vertically');
      assert(Math.abs(groups[1][0].top - groups[1][1].top) < 1, 'Sharing buttons align horizontally');
    }
    await checkButtonGroups();
    await host.locator('#help-close').click();
    await host.evaluate(() => { document.getElementById('join-addr').textContent = 'creativepeoplegroup.github.io/boxxie-share'; });
    const hostPanels = await host.locator('.join-row > div').evaluateAll(panels => panels.map(p => {
      const r = p.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width};
    }));
    assert(hostPanels.length === 2 && Math.abs(hostPanels[0].top-hostPanels[1].top)<1 &&
      Math.abs(hostPanels[0].bottom-hostPanels[1].bottom)<1 && Math.abs(hostPanels[0].width-hostPanels[1].width)<1,
      'Host panels match in width, top and bottom alignment');
    assert(await host.locator('#test-sound').isHidden(),'Troubleshooting tools stay off the main host screen');
    await host.screenshot({ path: `/tmp/boxxie-ui-tv-${engine}.png` });
    await host.locator('#help-open').click();
    await host.setViewportSize({ width: 390, height: 844 });
    await host.evaluate(() => document.documentElement.classList.remove('tv'));
    await checkButtonGroups();
    await host.setViewportSize({ width: 1280, height: 720 });
    await host.evaluate(() => document.documentElement.classList.add('tv'));
    await host.locator('#help-close').click();
    console.log(`PASS ${engine}: matched button dimensions and alignment at TV and phone widths`);
    try {
      await receiving(viewer);
      await viewer.setViewportSize({ width: 390, height: 844 });
      await viewer.locator('#chat-input').focus();
      const pictureBefore = await viewer.locator('#film').boundingBox();
      await viewer.setViewportSize({width:390,height:300});
      const pictureWithKeyboard = await viewer.locator('#film').boundingBox();
      assert(Math.abs(pictureBefore.width-pictureWithKeyboard.width)<1 && Math.abs(pictureBefore.height-pictureWithKeyboard.height)<1,
        'Portrait video keeps its size while the keyboard reduces viewport height');
      await viewer.setViewportSize({width:390,height:844});
      await viewer.locator('#chat-input').blur();
      await host.evaluate(() => { window.__lastDisplayHeight = null; });
      await viewer.locator('#viewer-display').selectOption('tv');
      await host.waitForFunction(() => window.__lastDisplayHeight === 1080);
      const videoCaps = await host.evaluate(() => window.__audioTestPeers
        .filter(pc => pc.connectionState === 'connected')
        .flatMap(pc => pc.getSenders()).filter(sender => sender.track?.kind === 'video')
        .flatMap(sender => sender.getParameters().encodings || []).map(e => e.maxBitrate));
      assert(videoCaps.includes(networkTest ? 8000000 : 2500000),
        'TV preference applies the Auto budget and preserves manual host quality');
      const preferences = await host.evaluate(() => window.__audioTestPeers
        .filter(pc => pc.connectionState === 'connected').flatMap(pc => pc.getSenders())
        .filter(sender => sender.track?.kind === 'video').map(sender => sender.getParameters().degradationPreference));
      assert(preferences.includes('balanced'), 'Large display balances detail and motion');
      assert.equal(await viewer.evaluate(() => localStorage.getItem('bx:displayMode')), '"tv"');
      assert(await viewer.locator('#screen-room').isVisible(), 'Changing display preference keeps the room');
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
    if (networkTest) await require('./network_adaptation.cjs')(viewer);
    await viewer.evaluate(() => document.getElementById('viewer-status').click());
    await viewer.waitForFunction(() => document.getElementById('screen-diag').textContent.includes('Mbps received'));
    await viewer.evaluate(() => document.getElementById('viewer-status').click());
    console.log(`PASS ${engine}: viewer network diagnostics report measured receive bitrate`);
    await host.locator('#help-open').click();
    await host.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async()=>{throw new Error('Clipboard unavailable in TV WebView');}}});
      document.getElementById('copy-diagnostics').click();
    });
    await host.locator('#diagnostics-report:not([hidden])').waitFor();
    const pictureReport = await host.locator('#diagnostics-report').inputValue();
    assert(pictureReport.includes('Viewer 1') && pictureReport.includes('Codec:'), 'Copy fallback displays a useful report');
    assert(!pictureReport.includes(code) && !pictureReport.includes(`Audio ${engine}`), 'Report omits room code and viewer name');
    await host.evaluate(() => { document.getElementById('diagnostics-report').hidden = true; });
    await host.locator('#help-close').click();

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

    // A brief host signalling interruption must not claim the host has dropped
    // or eject the viewer while changing players. Exercise the real host socket.
    await host.route('**/api/ticket', route => route.abort());
    const hostTicketFailed = host.waitForEvent('requestfailed', {
      predicate: request => new URL(request.url()).pathname === '/api/ticket', timeout: 15000,
    });
    await host.evaluate(() => window.__testSockets.filter(w =>
      w.url.includes('/api/rooms/') && w.readyState === 1).forEach(w => w.close()));
    await hostTicketFailed;
    assert(await host.locator('#screen-room').isVisible(),'A failed host ticket request keeps sharing active');
    const duringBefore = await mediaProgress(viewer);
    await new Promise(resolve => setTimeout(resolve,1000));
    const duringAfter = await mediaProgress(viewer);
    assert(duringAfter.frames > duringBefore.frames && duringAfter.energy > duringBefore.energy,
      'Existing picture and sound continue during host ticket failure');
    await host.unroute('**/api/ticket');
    await viewer.waitForFunction(() => document.getElementById('banner').textContent.includes("Waiting for the host's video"));
    assert(await viewer.locator('#screen-room').isVisible(), 'Host interruption keeps the viewer in the room');
    await viewer.waitForFunction(() => document.getElementById('banner').hidden);
    await receiving(viewer);
    assert.equal(await host.locator('#request-list .allow').count(), 0, 'Host recovery needs no new approval');
    console.log(`PASS ${engine}: brief host interruption preserves room and resumes media`);
    await host.evaluate(() => {
      // Older installed APKs reused one session ID across replacement peers.
      window.__legacyPeerSession = true;
      const now = Date.now;
      Date.now = () => now() + 120000;
      window.dispatchEvent(new Event('online'));
      Date.now = now;
    });
    await host.waitForFunction(() => document.getElementById('banner').hidden);
    await viewer.waitForFunction(() => document.getElementById('banner').hidden);
    await receiving(viewer);
    assert.equal(await host.locator('#viewer-health li').count(),1,'Host stale-socket recovery preserves the viewer');
    console.log(`PASS ${engine}: host ticket failure and stale signalling recover automatically`);
    await bounded(host.evaluate(() => {
      const NativeSocket = window.WebSocket;
      window.__restoreSocket = () => { window.WebSocket = NativeSocket; };
      window.__testConstructFailures = 0;
      let failNext = true;
      window.WebSocket = new Proxy(NativeSocket, { construct(Target,args) {
        if (failNext && String(args[0]).includes('/api/rooms/')) {
          failNext = false;
          window.__testConstructFailures++;
          throw new DOMException('Simulated socket construction failure','NetworkError');
        }
        return Reflect.construct(Target,args);
      }});
      window.__testSockets.filter(w => w.url.includes('/api/rooms/') && w.readyState === 1).forEach(w => w.close());
    }), 'inject host socket constructor failure');
    // Observe the injected failure itself, not a banner that may already have
    // disappeared before automation polls it. Bound these recovery checks.
    await host.waitForFunction(() => window.__testConstructFailures === 1, null, {timeout:20000});
    await host.waitForFunction(() => document.getElementById('banner').hidden &&
      window.__testSockets.some(w => w.url.includes('/api/rooms/') && w.readyState === 1), null, {timeout:20000});
    await host.evaluate(() => window.__restoreSocket());
    await receiving(viewer);
    console.log(`PASS ${engine}: host retries a WebSocket constructor failure without another user action`);

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
    await viewer.evaluate(async () => {
      const input = document.getElementById('join-code');
      input.focus();
      await new Promise(resolve => setTimeout(resolve, 80));
      if (document.activeElement !== input) throw new Error('Delayed autofocus stole the room-code input focus');
    });
    await viewer.locator('#join-code').fill(code);
    assert.equal((await viewer.locator('#join-code').inputValue()).replace(/-/g, ''), code);
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
    const legacy = await signedInPage(hostBrowser, 'Legacy app');
    await legacy.addInitScript(bridge);
    await legacy.addInitScript(() => { window.__legacyNative = true; });
    await legacy.goto(BASE);
    await legacy.locator('#screen-home:not([hidden])').waitFor();
    assert(await legacy.locator('[data-quality="auto"]').isHidden(), 'Older apps do not advertise unsupported Auto');
    assert.equal(await legacy.locator('[data-quality="hd"]').getAttribute('aria-checked'), 'true');
    await legacy.close();
    await host.evaluate(() => {
      const socket = window.__testSockets.find(w => w.url.includes('/api/rooms/') && w.readyState === 1);
      socket.onmessage(new MessageEvent('message',{data:JSON.stringify({type:'refused',error:'room_not_found'})}));
      socket.close();
    });
    await host.waitForFunction(() => document.getElementById('waiting-title').textContent === 'Room no longer available');
    assert.equal(await host.evaluate(() => window.BoxxieNative.isSharing()),false,
      'A definitive missing-room response stops stale native sharing');
    await host.evaluate(() => window.dispatchEvent(new Event('online')));
    assert(await host.locator('#screen-waiting').isVisible(),'A closed room does not pretend to be live');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  } catch (error) {
    // Report before closing browsers: a stuck browser shutdown must not hide
    // the actual failing assertion behind the workflow's five-minute limit.
    console.error(error);
    throw error;
  } finally {
    if (viewerBrowser) await bounded(viewerBrowser.close(), 'close viewer browser');
    if (hostBrowser) await bounded(hostBrowser.close(), 'close host browser');
  }
})().catch(error => { console.error(error); process.exit(1); });
