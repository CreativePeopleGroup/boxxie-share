// A stand-in for the Android app's screen engine (window.BoxxieNative), for browser tests.
// It speaks the same protocol as android/.../ScreenShareEngine.java: JSON strings in, events out
// through window.boxxieNativeEvent.
(() => {
  try { delete MediaDevices.prototype.getDisplayMedia; } catch (e) {}
  let roomSocket = null, roomConfig = null, roomEpoch = 0, roomHeartbeat = null;
  const emit = (ev) => {
    if (ev.type === 'signal' && roomConfig) {
      if (roomSocket?.readyState === 1) roomSocket.send(JSON.stringify({type:'signal',to:ev.peer,data:{...ev.data,ch:'screen'}}));
      return;
    }
    setTimeout(() => window.boxxieNativeEvent && window.boxxieNativeEvent(JSON.stringify(ev)), 0);
  };
  let ice = [], stream = null, session = null, timer = null, playbackPaused = false;
  const pcs = new Map();
  let generation = 0;
  function makeStream() {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const g = c.getContext("2d"); let n = 0;
    const noise = document.createElement('canvas'); noise.width = 160; noise.height = 90;
    const ng = noise.getContext('2d'); const pixels = ng.createImageData(160, 90);
    let seed = 12345;
    timer = setInterval(() => { if (playbackPaused) return; n++;
      if (window.__networkTest) {
        // A persistent textured scene with one moving band; replacing every
        // pixel with independent noise is an unrepresentative worst-case codec load.
        const first = ((n - 1) * 16) % 160;
        for (let y = 0; y < 90; y++) for (let x = first; x < first + 16; x++) {
          const i = (y * 160 + x) * 4;
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255;
          pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255;
        }
        ng.putImageData(pixels, 0, 0); g.imageSmoothingEnabled = false;
        g.drawImage(noise, 0, 0, 1280, 720);
      } else { g.fillStyle = `hsl(${n % 360},60%,45%)`; g.fillRect(0, 0, 1280, 720); }
      g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("TV screen " + n, 80, 360);
    }, 33);
    const s = c.captureStream(30);
    const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination();
    const gain = ac.createGain(); o.connect(gain); gain.connect(d); o.start();
    playbackPaused = false;
    window.__pauseHostPlayback = paused => { playbackPaused = paused; gain.gain.value = paused ? 0 : 1; };
    s.addTrack(d.stream.getAudioTracks()[0]);
    return s;
  }
  window.__nativeCalls = [];
  window.BoxxieNative = {
    screenShareInfo: () => JSON.stringify({ available: true, audio: true, sdk: 34, automaticQuality: !window.__legacyNative, roomConnection: !!window.__nativeRoomTest,
      manufacturer: "Test", model: "Simulated TV", androidVersion: "14", webViewVersion: "test" }),
    startScreenShare: (cfg) => {
      window.__nativeCalls.push("start");
      window.__lastShareConfig = JSON.parse(cfg);
      try { ice = JSON.parse(cfg).iceServers || []; } catch (e) {}
      if (window.__denyNext) { window.__denyNext = false; return emit({ type: "denied" }); }
      stream = makeStream(); session = Math.random().toString(36).slice(2);
      try { sessionStorage.setItem("fakeSharing", "1"); } catch (e) {}
      emit({ type: "started", audio: true });
    },
    setIceServers: (j) => { try { ice = JSON.parse(j); } catch (e) {} },
    addViewer: async (id) => {
      window.__nativeCalls.push("add:" + id);
      // Like the real app, sharing outlives a page reload: pick it back up
      if (!stream && sessionStorage.getItem("fakeSharing")) { stream = makeStream(); session = Math.random().toString(36).slice(2); }
      if (!stream) return;
      if (pcs.has(id)) pcs.get(id).close();
      const pc = new RTCPeerConnection({ iceServers: ice });
      const peerSession = window.__legacyPeerSession ? session : session + "-" + (++generation);
      pc.__session = peerSession;
      pcs.set(id, pc);
      for (const t of stream.getTracks()) {
        const quality = window.__lastShareConfig && window.__lastShareConfig.quality;
        const tx = pc.addTransceiver(t, { direction: "sendonly", streams: [stream],
          ...(t.kind === "video" && quality ? { sendEncodings: [{ maxBitrate: quality.maxBitrate, maxFramerate: 30 }] } : {}) });
        if (t.kind === "video" && quality && quality.automatic) {
          const params = tx.sender.getParameters();
          params.degradationPreference = "maintain-framerate";
          await tx.sender.setParameters(params);
        }
      }
      pc.onicecandidate = (e) => e.candidate && pcs.get(id) === pc && emit({ type: "signal", peer: id, data: { session: peerSession, candidate: e.candidate.toJSON() } });
      pc.oniceconnectionstatechange = () => pcs.get(id) === pc && emit({ type: "viewer-state", peer: id, ice: pc.iceConnectionState });
      const tick = setInterval(async () => {
        if (pc.connectionState === "closed") return clearInterval(tick);
        let frames = 0, bytes = 0;
        (await pc.getStats()).forEach((r) => { if (r.type === "outbound-rtp" && r.kind === "video") { frames += r.framesEncoded || 0; bytes += r.bytesSent || 0; } });
        emit({ type: "viewer-stats", peer: id, ice: pc.iceConnectionState, frames, bytes, codec: "VP8", encoder: "test", vp8: false, sound: true, fps: 24, limit: "none" });
      }, 1500);
      await pc.setLocalDescription(await pc.createOffer());
      emit({ type: "signal", peer: id, data: { session: peerSession, sdp: { type: "offer", sdp: pc.localDescription.sdp } } });
    },
    signal: async (id, json) => {
      const pc = pcs.get(id); if (!pc) return;
      try {
      const d = JSON.parse(json);
      if (d.session && d.session !== pc.__session) return;
      if (d.displayHeight !== undefined) {
        window.__lastDisplayHeight = d.displayHeight;
        const quality = window.__lastShareConfig && window.__lastShareConfig.quality;
        if (quality) {
          const limits = window.BoxxieQuality.limits(quality, d.displayHeight);
          for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== "video") continue;
            const params = sender.getParameters();
            for (const encoding of params.encodings || []) {
              encoding.maxBitrate = limits.maxBitrate;
              encoding.scaleResolutionDownBy = Math.max(1, (sender.track.getSettings().height || limits.height) / limits.height);
            }
            params.degradationPreference = window.BoxxieQuality.preference(quality, d.displayHeight);
            await sender.setParameters(params);
          }
        }
      }
      if (d.sdp) await pc.setRemoteDescription(d.sdp);
      else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
      } catch (error) {
        // A host reconnect may replace this simulated engine's peer while a
        // live quality update is awaiting setParameters. Ignore only stale work.
        if (pcs.get(id) !== pc || pc.signalingState === "closed") return;
        throw error;
      }
    },
    removeViewer: (id) => { window.__nativeCalls.push("remove:" + id); const pc = pcs.get(id); if (pc) pc.close(); pcs.delete(id); },
    stopScreenShare: () => {
      window.__nativeCalls.push("stop");
      try { sessionStorage.removeItem("fakeSharing"); } catch (e) {}
      for (const [id, pc] of pcs) { emit({ type: "signal", peer: id, data: { session: pc.__session, bye: true } }); pc.close(); }
      pcs.clear(); clearInterval(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null;
    },
    goHome: () => window.__nativeCalls.push("home"),
    testSound: () => window.__nativeCalls.push("beep"),
    testTvSoundCapture: () => window.__nativeCalls.push("tv-capture-test"),
    mediaKey: (a) => window.__nativeCalls.push("key:" + a),
    mediaPlaying: () => window.__fakePlaying !== false,
    networkInfo: () => JSON.stringify({ vpn: !!window.__fakeVpn, wifi: true, ethernet: false }),
    isSharing: () => !!sessionStorage.getItem("fakeSharing"),
    listApps: () => JSON.stringify([{ pkg: "com.example.player", label: "Home Videos", icon: "" }, { pkg: "com.example.music", label: "Music", icon: "" }]
      .concat(window.__manyApps ? Array.from({ length: 22 }, (_, i) => ({ pkg: "com.example.app" + i, label: "App " + String(i).padStart(2, "0"), icon: "" })).concat([{ pkg: "com.streamteam", label: "The Stream Team", icon: "" }]) : [])),
    launchApp: (pkg) => window.__nativeCalls.push("launch:" + pkg),
    // Update button stand-in: pretends 1.0.6 is out; window.__updateNone = true means up to date
    appInfo: () => JSON.stringify({ code: 5, name: "1.0.5", canUpdate: true }),
    checkUpdate: () => {
      window.__nativeCalls.push("check-update");
      const none = !!window.__updateNone;
      setTimeout(() => window.boxxieNativeEvent(JSON.stringify({ type: "update", available: !none, name: none ? "1.0.5" : "1.0.6", current: "1.0.5" })), 50);
    },
    installUpdate: () => {
      window.__nativeCalls.push("install-update");
      [10, 50, 100].forEach((pct, i) => setTimeout(() => window.boxxieNativeEvent(JSON.stringify({ type: "update-progress", pct })), 100 * (i + 1)));
    },
  };
  // Opt-in native-room stand-in for wiring tests. This is not an Android
  // background-lifecycle simulation; the JVM suite tests the real transport.
  async function connectRoomTransport() {
    const epoch = ++roomEpoch, config = roomConfig;
    if (!config) return;
    const response = await fetch(config.server + '/api/ticket', {method:'POST',headers:{Authorization:'Bearer '+config.sessionToken}});
    const ticket = (await response.json()).ticket;
    if (epoch !== roomEpoch) return;
    const ws = new WebSocket(config.server.replace(/^http/,'ws') + '/api/rooms/' + config.code + '/ws?role=host&token=' + config.hostToken + '&ticket=' + ticket);
    roomSocket = ws;
    window.__nativeRoomWire = ws;
    ws.onopen = () => {
      emit({type:'room-state',connectionId:config.id,state:'open'});
      clearInterval(roomHeartbeat);
      roomHeartbeat = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 200);
    };
    ws.onmessage = e => {
      if (epoch !== roomEpoch) return;
      const m = JSON.parse(e.data);
      if (m.type === 'welcome') window.BoxxieNative.setIceServers(JSON.stringify(m.iceServers || []));
      if (m.type === 'viewer-ready' && !m.companionOf && !pcs.has(m.id)) window.BoxxieNative.addViewer(m.id);
      if (m.type === 'viewer-left') window.BoxxieNative.removeViewer(m.id);
      if (m.type === 'signal' && m.data?.ch === 'screen') {
        if (m.data.restart) window.BoxxieNative.addViewer(m.from);
        else window.BoxxieNative.signal(m.from, JSON.stringify(m.data));
      }
      emit({type:'room-message',connectionId:config.id,message:m});
    };
    ws.onclose = e => {
      clearInterval(roomHeartbeat);
      if (epoch !== roomEpoch || !roomConfig) return;
      if ([4000,4003,4004].includes(e.code)) emit({type:'room-state',connectionId:config.id,state:'closed',code:e.code,reason:e.reason});
      else { emit({type:'room-state',connectionId:config.id,state:'retrying'}); setTimeout(connectRoomTransport, window.__nativeRoomReconnectDelay || 500); }
    };
  }
  window.BoxxieNative.connectRoom = json => {
    window.__nativeRoomStarts = (window.__nativeRoomStarts || 0) + 1;
    roomConfig = JSON.parse(json);
    connectRoomTransport();
    return true;
  };
  window.BoxxieNative.sendRoom = (id,json) => { if (roomConfig?.id === id && roomSocket?.readyState === 1) roomSocket.send(json); };
  window.BoxxieNative.disconnectRoom = id => {
    if (roomConfig?.id !== id) return;
    roomConfig = null; ++roomEpoch; clearInterval(roomHeartbeat); roomSocket?.close(); roomSocket = null;
  };
})();
