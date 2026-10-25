// A stand-in for the Android app's screen engine (window.BoxxieNative), for browser tests.
// It speaks the same protocol as android/.../ScreenShareEngine.java: JSON strings in, events out
// through window.boxxieNativeEvent.
(() => {
  try { delete MediaDevices.prototype.getDisplayMedia; } catch (e) {}
  const emit = (ev) => setTimeout(() => window.boxxieNativeEvent && window.boxxieNativeEvent(JSON.stringify(ev)), 0);
  let ice = [], stream = null, session = null, timer = null;
  const pcs = new Map();
  function makeStream() {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const g = c.getContext("2d"); let n = 0;
    timer = setInterval(() => { n++; g.fillStyle = `hsl(${n % 360},60%,45%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("TV screen " + n, 80, 360); }, 33);
    const s = c.captureStream(30);
    const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
    s.addTrack(d.stream.getAudioTracks()[0]);
    return s;
  }
  window.__nativeCalls = [];
  window.BoxxieNative = {
    screenShareInfo: () => JSON.stringify({ available: true, audio: true, sdk: 34 }),
    startScreenShare: (cfg) => {
      window.__nativeCalls.push("start");
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
      pcs.set(id, pc);
      stream.getTracks().forEach((t) => pc.addTransceiver(t, { direction: "sendonly", streams: [stream] }));
      pc.onicecandidate = (e) => e.candidate && emit({ type: "signal", peer: id, data: { session, candidate: e.candidate.toJSON() } });
      pc.oniceconnectionstatechange = () => emit({ type: "viewer-state", peer: id, ice: pc.iceConnectionState });
      const tick = setInterval(async () => {
        if (pc.connectionState === "closed") return clearInterval(tick);
        let frames = 0, bytes = 0;
        (await pc.getStats()).forEach((r) => { if (r.type === "outbound-rtp" && r.kind === "video") { frames += r.framesEncoded || 0; bytes += r.bytesSent || 0; } });
        emit({ type: "viewer-stats", peer: id, ice: pc.iceConnectionState, frames, bytes, codec: "VP8", encoder: "test", vp8: false, sound: true, fps: 24, limit: "none" });
      }, 1500);
      await pc.setLocalDescription(await pc.createOffer());
      emit({ type: "signal", peer: id, data: { session, sdp: { type: "offer", sdp: pc.localDescription.sdp } } });
    },
    signal: async (id, json) => {
      const pc = pcs.get(id); if (!pc) return;
      const d = JSON.parse(json);
      if (d.session && d.session !== session) return;
      if (d.sdp) await pc.setRemoteDescription(d.sdp);
      else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
    },
    removeViewer: (id) => { window.__nativeCalls.push("remove:" + id); const pc = pcs.get(id); if (pc) pc.close(); pcs.delete(id); },
    stopScreenShare: () => {
      window.__nativeCalls.push("stop");
      try { sessionStorage.removeItem("fakeSharing"); } catch (e) {}
      for (const [id, pc] of pcs) { emit({ type: "signal", peer: id, data: { session, bye: true } }); pc.close(); }
      pcs.clear(); clearInterval(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null;
    },
    goHome: () => window.__nativeCalls.push("home"),
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
})();
