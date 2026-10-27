/* Boxxie Share web app — host and viewer.
 *
 * How it works:
 *  - The host picks a video file. The browser plays it and captures the picture + sound
 *    (video.captureStream) and sends it to each approved viewer over WebRTC.
 *  - Everyone can join a video call (camera + mic) that runs alongside the film.
 *  - The connection server only introduces devices and relays chat; video goes device to
 *    device and is always encrypted by WebRTC.
 */
(() => {
  "use strict";

  const CFG = window.BOXXIE_CONFIG || {};
  const SERVER = String(CFG.serverUrl || "").replace(/\/$/, "");
  const WS_SERVER = SERVER.replace(/^http/, "ws");
  // Picture quality. Bitrate is per friend, sent from the host's home connection.
  // If the connection can't keep up, WebRTC steps the picture down automatically.
  const QUALITY = {
    auto: { label: "Auto 1080p", height: 1080, width: 1920, maxBitrate: 8_000_000, automatic: true },
    smooth: { label: "Smooth 720p", height: 720, width: 1280, maxBitrate: 2_500_000 },
    hd: { label: "HD 1080p", height: 1080, width: 1920, maxBitrate: 8_000_000 },
    "4k": { label: "4K Ultra HD", height: 2160, width: 3840, maxBitrate: 25_000_000 },
  };
  const quality = () => QUALITY[S.quality] || QUALITY.hd;
  const CAM_CONSTRAINTS = {
    video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: "user" },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  };

  const $ = (id) => document.getElementById(id);
  const isTV = matchMedia("(pointer: none)").matches || /\b(AFT[A-Z0-9]*|Android TV|BRAVIA|GoogleTV)\b/i.test(navigator.userAgent) || /BoxxieShareTV/.test(navigator.userAgent);
  if (isTV) document.documentElement.classList.add("tv");
  // TVs report different page sizes (Fire TV is often 960×540). The TV screens are laid out
  // for 1280×720 and scale down to fit exactly, so nothing ever needs scrolling.
  const root = document.documentElement;
  function shrinkToFit() {
    // Home and sign-in are one screen each: still taller than the TV? Shrink a bit more (not too far).
    // Longer pages like Friends scroll instead, so their text stays readable.
    const scr = [...document.querySelectorAll(".screen")].find((x) => !x.hidden);
    if (!scr || !["home", "signin"].includes(scr.dataset.screen)) return;
    const h = root.scrollHeight;
    if (h > innerHeight + 1) {
      const z = Number(getComputedStyle(root).getPropertyValue("--tvz")) || 1;
      root.style.setProperty("--tvz", String(Math.max(0.6, Math.floor(z * (innerHeight / h) * 1000) / 1000)));
    }
  }
  function fitTV() {
    if (!isTV) return;
    root.style.setProperty("--tvz", String(Math.floor(Math.min(1, innerWidth / 1280, innerHeight / 720) * 1000) / 1000));
    shrinkToFit();
  }
  if (isTV) {
    fitTV();
    let fittedWidth = innerWidth, fittedHeight = innerHeight;
    addEventListener("resize", () => {
      // Some TV WebViews notify resize after content/focus changes even when
      // the viewport is unchanged. Do not reset the fitted zoom for those.
      if (innerWidth === fittedWidth && innerHeight === fittedHeight) return;
      fittedWidth = innerWidth;
      fittedHeight = innerHeight;
      fitTV();
    });
  }

  // ---------------- tiny storage helpers (never required to work) ----------------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("bx:" + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("bx:" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("bx:" + k); } catch {} },
  };

  // ---------------- state ----------------
  const S = {
    role: null, // "host" | "viewer"
    source: "file", // host: "file" | "screen"
    quality: "auto", // host: "auto" | "smooth" | "hd" | "4k"
    capture: null, // host: stream captured from the film player
    code: null,
    hostToken: null,
    myId: null,
    myName: "",
    ws: null,
    ice: [],
    peers: new Map(), // id -> Peer
    companionOf: new Map(), // paired-device id -> owner id ("host" or a viewer id)
    companion: false, // this device is someone's paired phone
    phonePaired: false, // this TV has a phone handling its call
    names: new Map(), // id -> name
    filmStream: null,
    camStream: null,
    inCall: false,
    locked: false,
    pingTimer: null,
    reconnectTries: 0,
    closing: false,
    wakeLock: null,
  };

  // ---------------- screens ----------------
  function show(name) {
    document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.dataset.screen !== name));
    fitTV();
    // The first screen has its final dimensions before the loading layer leaves.
    $("main").removeAttribute("inert");
    $("startup")?.remove();
    const target = document.querySelector(`[data-screen="${name}"]`);
    const first = target && (target.querySelector("[data-autofocus]") || target.querySelector("button:not([hidden]), input:not([type=hidden]):not(.visually-hidden)"));
    // Focus before showing the next frame. A delayed focus can steal keystrokes
    // from someone who has already started entering a room code.
    if (first && (isTV || name !== "room")) first.focus();
  }

  let hostAwayTimer;
  let toastTimer;
  function toast(text, ms = 3500) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  function banner(text) {
    const b = $("banner");
    b.textContent = text || "";
    b.hidden = !text;
  }
  function showError(el, text) {
    el.textContent = text;
    el.hidden = !text;
  }

  function formatCode(c) {
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  }
  function cleanCode(v) {
    return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }
  function fmtTime(s) {
    if (!isFinite(s)) return "0:00";
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  }

  const ERRORS = {
    room_not_found: "That code doesn't match an open room. Check it with the host and try again.",
    not_allowed: "You can't join this room.",
    too_many_attempts: "Too many wrong codes from this connection. Wait 15 minutes, then try again.",
    too_many_rooms: "You've opened a lot of rooms this hour. Wait a while, then try again.",
    origin_not_allowed: "This copy of the app isn't allowed to use the server. Check ALLOWED_ORIGINS in the server settings.",
    wrong_pin: "That pairing code doesn't match. Check the code on the TV and try again. It only works while the TV is in the room.",
    signed_out: "Please sign in again.",
    not_host: "This room was opened on another device or has closed. Open a new room.",
    no_server: "The app isn't connected to a server yet. Add your server address to config.js.",
    network: "Couldn't reach the server. Check your internet connection and try again.",
  };

  // ---------------- capability checks ----------------
  // A see-through poster: Android TV and phone web views otherwise draw a big grey play button
  const BLANK_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const testVideo = document.createElement("video");
  const canHost = !!(testVideo.captureStream || testVideo.mozCaptureStream) && "RTCPeerConnection" in window;
  const canCall = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  // Screen sharing works in desktop browsers (Chrome, Edge, Firefox, Safari on Mac).
  const canShareScreenWeb = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && "RTCPeerConnection" in window;
  // The Android app (phones, Android TV, Fire TV) can share the whole device screen from the
  // background with its own video engine. It talks to this page through window.BoxxieNative.
  const NATIVE = window.BoxxieNative && typeof window.BoxxieNative.screenShareInfo === "function" ? window.BoxxieNative : null;
  let nativeInfo = {};
  try { nativeInfo = NATIVE ? JSON.parse(NATIVE.screenShareInfo()) || {} : {}; } catch {}
  const canNativeShare = !!nativeInfo.available;
  const canShareScreen = canShareScreenWeb || canNativeShare;

  // ---------------- home ----------------
  // ---------------- accounts ----------------
  // Everyone signs in (Google, Facebook or an email code). TVs and the Android app sign in
  // by QR code from a signed-in phone, because Google/Facebook block sign-in inside apps.
  const inApp = /BoxxieShare(TV|App)\//.test(navigator.userAgent);
  const SITE = location.origin + location.pathname;
  S.session = store.get("session");
  const myName = () => (S.session && S.session.user && S.session.user.name) || "";
  function needName() {
    const n = myName();
    if (n) return n;
    signOutLocal("Please sign in first.");
    return null;
  }
  async function api(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(SERVER + path, {
        method,
        headers: { "Content-Type": "application/json", ...(S.session ? { Authorization: "Bearer " + S.session.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { ok: false, status: 0, data: { error: "network" } };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && S.session && path.startsWith("/api/")) signOutLocal("Your sign-in has expired. Please sign in again.");
    return { ok: res.ok, status: res.status, data };
  }
  async function getTicket() {
    const r = await api("/api/ticket", { method: "POST" });
    return r.ok ? r.data.ticket : null;
  }
  function setSession(r) {
    S.session = { token: r.token, user: r.user };
    store.set("session", S.session);
    afterSignIn();
  }
  function signOutLocal(message) {
    S.session = null;
    S.me = null;
    store.del("session");
    closeInbox();
    stopDevicePolling();
    if (S.ws) cleanup();
    S.role = null;
    showSignin(message);
  }
  $("signout").onclick = async () => {
    forgetViewerRoom();
    await api("/auth/signout", { method: "POST" });
    signOutLocal();
  };

  function renderAvatar(el, user, i = 0) {
    el.replaceChildren();
    el.style.background = AV_COLOURS[i % AV_COLOURS.length];
    if (user && user.photo) {
      const img = document.createElement("img");
      img.src = user.photo;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => { img.remove(); el.textContent = initial(user.name); };
      el.append(img);
    } else el.textContent = initial(user && user.name);
  }
  const initial = (n) => (n || "?").trim().charAt(0).toUpperCase();

  function greet() {
    const h = new Date().getHours();
    const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const first = (myName() || "").split(" ")[0];
    const t = $("hero-title");
    t.replaceChildren(document.createTextNode(first ? part + ", " : part));
    if (first) {
      const n = document.createElement("span");
      n.className = "hl";
      n.textContent = first;
      t.append(n);
    }
    $("hero-kicker").textContent = new Date().toLocaleDateString(undefined, { weekday: "long" });
  }
  async function afterSignIn() {
    $("me-name").textContent = myName();
    greet();
    renderAvatar($("me-av"), S.session.user, 0);
    openInbox();
    await loadMe();
    if (!S.session) return;
    const after = S.after;
    S.after = null;
    if (after && after.device) return showDeviceApproval(after.device);
    if (after && after.pair) return joinAsPhone(after.pair[0], after.pair[1]);
    if (after && after.join) $("join-code").value = formatCode(after.join);
    if (!after && resumeTVRoom()) return;
    if (!after && resumeViewerRoom()) return;
    show("home");
    if (after && after.join) $("join-start").focus();
  }

  async function loadMe() {
    if (!S.session) return;
    const r = await api("/api/me");
    if (!r.ok) return;
    S.me = r.data;
    S.blocked = new Set((r.data.blocked || []).map((b) => b.id));
    S.session.user = { ...S.session.user, ...r.data.user };
    store.set("session", S.session);
    $("me-name").textContent = myName();
    greet();
    $("me-email").textContent = (S.me.user && S.me.user.email) || (S.me.user ? S.me.user.name : "");
    const fc = S.me.user && S.me.user.friendCode;
    $("my-friend-code").textContent = fc ? `${fc.slice(0, 4)}-${fc.slice(4)}` : "…";
    $("friend-code-share").hidden = !navigator.share;
    $("totp-status").textContent = S.me.user && S.me.user.totp ? "On. Signing in on a new device asks for the number from your app." : "Add Google Authenticator as an extra lock.";
    setLabel($("totp-toggle"), S.me.user && S.me.user.totp ? "Turn off" : "Set up");
    renderAvatar($("me-av"), S.session.user, 0);
    const incoming = S.me.friends.filter((f) => f.status === "incoming").length;
    $("friends-badge").textContent = String(incoming);
    $("friends-badge").hidden = !incoming;
    renderInvites();
    renderFriends();
    if (!$("invite-panel").hidden) renderInvitePanel();
  }

  // ----- live notifications (invites, friend requests) -----
  async function openInbox() {
    if (!S.session || S.inbox) return;
    const ticket = await getTicket();
    if (!ticket || !S.session) return;
    let ws;
    try {
      ws = new WebSocket(`${WS_SERVER}/api/me/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      return;
    }
    S.inbox = ws;
    const ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "invite") {
        toast(`${m.invite.from.name} invited you to watch`, 6000);
        loadMe().then(() => {
          if (!$("screen-home").hidden) $("invites").scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } else if (m.type === "friends-changed") loadMe();
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (S.inbox === ws) S.inbox = null;
      if (S.session) setTimeout(openInbox, 5000);
    };
  }
  function closeInbox() {
    const ws = S.inbox;
    S.inbox = null;
    try { ws && ws.close(); } catch {}
  }

  // ----- invites on the home screen -----
  function renderInvites() {
    const list = $("invite-list");
    list.replaceChildren();
    const invites = (S.me && S.me.invites) || [];
    invites.forEach((inv) => {
      const li = document.createElement("li");
      const av = document.createElement("span");
      av.className = "chip";
      const a = document.createElement("span");
      a.className = "av";
      renderAvatar(a, inv.from, 2);
      av.append(a);
      const what = document.createElement("span");
      what.className = "what";
      const b = document.createElement("b");
      b.textContent = inv.from.name;
      what.append(b, " invited you to watch together");
      const join = document.createElement("button");
      join.className = "primary";
      join.textContent = "Join";
      join.onclick = () => joinRoom(inv.code);
      const no = document.createElement("button");
      no.className = "small";
      no.textContent = "Dismiss";
      no.onclick = async () => {
        await api("/api/me/invites/dismiss", { method: "POST", body: { code: inv.code } });
        loadMe();
      };
      li.append(av, what, join, no);
      list.append(li);
    });
    $("invites").hidden = invites.length === 0;
  }

  // ----- friends screen -----
  $("go-friends").onclick = () => {
    $("rename-input").value = myName();
    $("friend-add-msg").textContent = "";
    renderFriends();
    show("friends");
    loadMe();
  };
  $("friends-back").onclick = () => show("home");
  $("friend-code-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("my-friend-code").textContent);
      toast("Friend code copied.");
    } catch {}
  };
  $("friend-code-share").onclick = async () => {
    try {
      await navigator.share({ title: "Add me on Boxxie Share", text: `Add me on Boxxie Share: my friend code is ${$("my-friend-code").textContent}\n${SITE}` });
    } catch {}
  };
  $("code-reset").onclick = async () => {
    if (!confirm("Get a new Boxxie code? Your old code stops working straight away. Devices already signed in stay signed in.")) return;
    const r = await api("/api/me/code/reset", { method: "POST" });
    if (r.ok && r.data.code) showNewCode(r.data.code, myName());
    else toast("Couldn't make a new code. Try again.");
  };
  $("totp-toggle").onclick = async () => {
    const on = S.me && S.me.user && S.me.user.totp;
    const panel = $("totp-panel");
    if (!panel.hidden) return (panel.hidden = true);
    $("totp-msg").textContent = "";
    $("totp-code").value = "";
    $("totp-setup-box").hidden = on;
    $("totp-off-text").hidden = !on;
    setLabel($("totp-submit"), on ? "Turn off" : "Turn on");
    if (!on) {
      const r = await api("/api/me/totp/setup", { method: "POST" });
      if (!r.ok) return toast("Couldn't start. Try again.");
      const box = $("totp-qr");
      box.replaceChildren();
      try { box.append(window.BoxxieQR.svg(r.data.uri, { size: 180, dark: "#142130", light: "#ffffff" })); } catch {}
      $("totp-secret").textContent = r.data.secret.replace(/(.{4})/g, "$1 ").trim();
    }
    panel.hidden = false;
    $("totp-code").focus();
  };
  $("totp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const on = S.me && S.me.user && S.me.user.totp;
    const code = $("totp-code").value.replace(/\D/g, "");
    const r = await api(on ? "/api/me/totp/disable" : "/api/me/totp/confirm", { method: "POST", body: { code } });
    if (!r.ok) {
      $("totp-msg").textContent = r.data.error === "expired" ? "That took a while. Press Set up again." : "That number isn't right. Type the newest one from the app.";
      return;
    }
    $("totp-panel").hidden = true;
    toast(on ? "Authenticator lock is off." : "Authenticator lock is on.");
    loadMe();
  });

  $("delete-account").onclick = async () => {
    if (!confirm("Delete your Boxxie Share account? Your friends list and invites are removed for good.")) return;
    await api("/api/me/delete", { method: "POST" });
    signOutLocal("Your account has been deleted.");
  };
  function friendRow(f, buttons) {
    const li = document.createElement("li");
    li.append(chip(f.name, "", 1, null, f.photo));
    buttons.forEach(([label, cls, fn]) => {
      const b = document.createElement("button");
      b.className = "small " + (cls || "");
      b.textContent = label;
      b.onclick = fn;
      li.append(b);
    });
    return li;
  }
  function renderFriends() {
    const fr = (S.me && S.me.friends) || [];
    const reqs = fr.filter((f) => f.status === "incoming");
    const mine = fr.filter((f) => f.status === "friends");
    const sent = fr.filter((f) => f.status === "outgoing");
    const respond = (f, accept) => async () => {
      await api("/api/friends/respond", { method: "POST", body: { id: f.id, accept } });
      loadMe();
    };
    const remove = (f, ask) => async () => {
      if (ask && !confirm(`Remove ${f.name} from your friends?`)) return;
      await api("/api/friends/remove", { method: "POST", body: { id: f.id } });
      loadMe();
    };
    $("friend-requests").replaceChildren(...reqs.map((f) => friendRow(f, [["Accept", "allow", respond(f, true)], ["Decline", "deny", respond(f, false)]])));
    const blockF = (f) => () => {
      if (confirm(`Block ${f.name}? They'll be removed from your friends and can't invite you or join your rooms.`)) blockUser(f.id, f.name);
    };
    $("friend-list").replaceChildren(...mine.map((f) => friendRow(f, [["Remove", "deny", remove(f, true)], ["Block", "deny", blockF(f)]])));
    $("friend-requests").replaceChildren(...reqs.map((f) => friendRow(f, [["Accept", "allow", respond(f, true)], ["Decline", "deny", respond(f, false)], ["Block", "deny", blockF(f)]])));
    const blocked = (S.me && S.me.blocked) || [];
    $("blocked-list").replaceChildren(...blocked.map((b) => friendRow(b, [["Unblock", "", () => unblockUser(b.id, b.name)]])));
    $("blocked-wrap").hidden = !blocked.length;
    $("friend-sent").replaceChildren(...sent.map((f) => friendRow(f, [["Cancel", "deny", remove(f, false)]])));
    $("friend-requests-wrap").hidden = !reqs.length;
    $("friend-sent-wrap").hidden = !sent.length;
    $("friends-empty").hidden = mine.length > 0;
  }
  $("friend-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("friend-email").value.trim();
    if (!email) return;
    const byCode = !email.includes("@");
    const r = await api("/api/friends/add", { method: "POST", body: byCode ? { code: email } : { email, return: SITE } });
    $("friend-add-msg").textContent = r.ok
      ? r.data.status === "friends"
        ? `You're now friends.`
        : byCode ? "Request sent. They'll see it on their Friends screen." : `Request sent to ${email}. They'll see it when they sign in.`
      : {
          bad_email: "That doesn't look like an email address.",
          bad_code: "Friend codes are 8 letters and numbers, like K7FQ-2MXP.",
          no_such_code: "No one has that friend code. Check it with your friend.",
          self: "That's your own code.",
          too_many: "You've sent a lot of requests today. Try again tomorrow.",
        }[r.data.error] || "Couldn't send that request. Try again.";
    if (r.ok) $("friend-email").value = "";
    loadMe();
  });
  $("rename-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/me/name", { method: "POST", body: { name: $("rename-input").value } });
    if (r.ok && r.data.user) {
      S.session.user = { ...S.session.user, ...r.data.user };
      store.set("session", S.session);
      $("me-name").textContent = myName();
      toast("Name saved");
    }
  });

  // ----- sign-in screen -----
  async function showSignin(message) {
    show("signin");
    showError($("signin-error"), message || "");
    $("code-form").hidden = true;
    $("email-form").hidden = false;
    const r = await api("/auth/providers");
    const prov = r.ok ? r.data : {};
    $("signin-google").hidden = inApp || !prov.google;
    $("signin-facebook").hidden = inApp || !prov.facebook;
    $("signin-inapp").hidden = !(inApp && (prov.google || prov.facebook));
    $("email-form").hidden = !prov.email;
    $("code-signin").hidden = !prov.code;
    $("code-otp-row").hidden = true;
    const social = !inApp && (prov.google || prov.facebook);
    // "or" sits between whichever blocks are showing
    $("signin-or").hidden = !prov.email || !(social || prov.code || inApp);
    if (!SERVER) showError($("signin-error"), ERRORS.no_server);
    else if (r.ok && !prov.email && !prov.google && !prov.facebook && !prov.code)
      showError($("signin-error"), "Sign-in isn't switched on yet. Whoever runs this Boxxie Share needs to add an email, Google or Facebook key (README, Step 5).");
    else if (!r.ok) showError($("signin-error"), "Can't reach the Boxxie Share server right now. Check your internet connection and try again.");
    if (isTV || inApp) startDeviceSignin();
    setTimeout(() => {
      const first = !$("signin-google").hidden ? $("signin-google") : prov.code ? $("signin-boxxcode") : $("signin-email");
      if (!isTV) first.focus();
    }, 60);
  }
  $("signin-google").onclick = () => (location.href = `${SERVER}/auth/google/start?return=${encodeURIComponent(SITE)}`);
  $("signin-facebook").onclick = () => (location.href = `${SERVER}/auth/facebook/start?return=${encodeURIComponent(SITE)}`);
  $("email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    showError($("signin-error"), "");
    if (!email) return showError($("signin-error"), "Type your email address.");
    $("email-send").disabled = true;
    const r = await api("/auth/email/start", { method: "POST", body: { email, return: SITE } });
    $("email-send").disabled = false;
    if (!r.ok) {
      return showError($("signin-error"), {
        bad_email: "That doesn't look like an email address.",
        too_many: "Too many sign-in emails. Wait 15 minutes, then try again.",
        not_configured: "Email sign-in isn't switched on for this Boxxie Share yet.",
        email_failed: "The email couldn't be sent. Check the address and try again.",
      }[r.data.error] || ERRORS.network);
    }
    S.signinEmail = email;
    $("code-email").textContent = email;
    $("email-form").hidden = true;
    $("code-form").hidden = false;
    $("signin-code").value = "";
    $("signin-code").focus();
  });
  $("code-back").onclick = () => {
    $("code-form").hidden = true;
    $("email-form").hidden = false;
    $("signin-email").focus();
  };
  $("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("signin-code").value.replace(/\D/g, "");
    const r = await api("/auth/email/verify", { method: "POST", body: { email: S.signinEmail, code } });
    if (!r.ok) {
      return showError($("signin-error"), {
        wrong_code: "That code isn't right. Check the email and try again.",
        too_many_tries: "Too many wrong codes. Ask for a new email.",
        expired: "That code has expired. Ask for a new email.",
      }[r.data.error] || ERRORS.network);
    }
    stopDevicePolling();
    setSession(r.data);
  });

  // ----- Boxxie codes: your own sign-in code, no email needed -----
  $("boxxcode-show").onclick = () => {
    const i = $("signin-boxxcode");
    const showIt = i.type === "password";
    i.type = showIt ? "text" : "password";
    $("boxxcode-show").textContent = showIt ? "Hide" : "Show";
    $("boxxcode-show").setAttribute("aria-pressed", String(showIt));
  };
  $("code-signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("signin-boxxcode").value.trim();
    if (!code) return showError($("signin-error"), "Type your Boxxie code.");
    const otpVisible = !$("code-otp-row").hidden;
    const body = { code };
    if (otpVisible) body.otp = $("signin-otp").value.replace(/\D/g, "");
    $("code-signin-btn").disabled = true;
    const r = await api("/auth/code/signin", { method: "POST", body });
    $("code-signin-btn").disabled = false;
    if (r.ok && r.data.needOtp) {
      $("code-otp-row").hidden = false;
      showError($("signin-error"), "");
      $("signin-otp").focus();
      return;
    }
    if (!r.ok) {
      return showError($("signin-error"), {
        wrong_code: "That code isn't right. It looks like BOXX-XXXX-XXXX-XXXX.",
        wrong_otp: "That number isn't right. Use the newest number in your authenticator app.",
        too_many_attempts: ERRORS.too_many_attempts,
      }[r.data.error] || ERRORS.network);
    }
    stopDevicePolling();
    setSession(r.data);
  });
  $("code-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("new-name").value.trim();
    if (!name) return showError($("signin-error"), "Type your name first.");
    $("new-create").disabled = true;
    const r = await api("/auth/code/create", { method: "POST", body: { name } });
    $("new-create").disabled = false;
    if (!r.ok) {
      return showError($("signin-error"), { too_many: "Lots of accounts were made from this connection. Try again in an hour." }[r.data.error] || ERRORS.network);
    }
    stopDevicePolling();
    S.pendingSession = { token: r.data.token, user: r.data.user };
    showNewCode(r.data.code, r.data.user.name);
  });
  function showNewCode(code, name) {
    $("newcode-value").value = code;
    $("newcode-user").value = name || "";
    setLabel($("newcode-copy"), "Copy");
    show("newcode");
  }
  $("newcode-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("newcode-value").value);
      setLabel($("newcode-copy"), "Copied");
    } catch {
      $("newcode-value").select();
    }
  };
  $("newcode-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    // Offer to save it in the phone's or browser's passwords (Keychain, Google Password Manager).
    try {
      if (window.PasswordCredential && navigator.credentials) {
        await navigator.credentials.store(new PasswordCredential({ id: $("newcode-user").value || "Boxxie Share", password: $("newcode-value").value, name: "Boxxie Share" }));
      }
    } catch {}
    $("newcode-value").value = "";
    if (S.pendingSession) {
      const sess = S.pendingSession;
      S.pendingSession = null;
      setSession(sess);
    } else show("friends");
  });

  // ----- TV: sign in by scanning a QR code with your phone -----
  async function startDeviceSignin() {
    stopDevicePolling();
    $("signin-tv").hidden = false;
    $("signin-site").textContent = location.host + location.pathname.replace(/\/$/, "");
    const r = await api("/auth/device/start", { method: "POST" });
    if (!r.ok) {
      $("signin-tv-status").textContent = "Couldn't get a sign-in code. Check the internet connection.";
      return;
    }
    const { deviceCode, userCode } = r.data;
    const pretty = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    $("signin-device-code").textContent = pretty;
    const box = $("signin-qr");
    box.replaceChildren();
    try { box.append(window.BoxxieQR.svg(`${SITE}#device=${userCode}`, { size: 200 })); } catch {}
    $("signin-tv-status").textContent = "Waiting for your phone…";
    const started = Date.now();
    S.devicePoll = setInterval(async () => {
      if (Date.now() - started > 9.5 * 60 * 1000) return startDeviceSignin(); // fresh code before it expires
      const p = await api("/auth/device/poll", { method: "POST", body: { deviceCode } });
      if (p.ok && p.data.token) {
        stopDevicePolling();
        setSession(p.data);
      } else if (p.ok && p.data.error === "expired") startDeviceSignin();
    }, 3000);
  }
  function stopDevicePolling() {
    clearInterval(S.devicePoll);
    S.devicePoll = null;
  }

  // ----- phone: approve a TV that wants to sign in -----
  async function showDeviceApproval(userCode) {
    const r = await api("/auth/device/info", { method: "POST", body: { userCode } });
    show("device");
    if (!r.ok) {
      $("device-title").textContent = "That code has expired";
      $("device-text").textContent = "Show a new QR code on the TV and scan it again.";
      $("device-yes").hidden = true;
      $("device-no").textContent = "Back to start";
      return;
    }
    $("device-title").textContent = "Sign in on your TV?";
    $("device-text").textContent = `A device is asking to sign in to Boxxie Share as ${myName()}. Only say yes if it's your TV or a device you're using right now.`;
    $("device-yes").hidden = false;
    $("device-no").textContent = "No";
    $("device-yes").onclick = async () => {
      const a = await api("/auth/device/approve", { method: "POST", body: { userCode } });
      $("device-yes").hidden = true;
      $("device-no").textContent = "Done";
      $("device-title").textContent = a.ok ? "Your TV is signed in" : "That code has expired";
      $("device-text").textContent = a.ok ? "It'll show your name in a moment. You can carry on using this phone." : "Show a new QR code on the TV and scan it again.";
    };
  }
  $("device-no").onclick = () => show("home");
  (function setUpShareCard() {
    const any = canHost || canShareScreen;
    $("host-unsupported").hidden = any;
    $("share-options").hidden = !any;
    $("source-field").hidden = !(canHost && canShareScreen);
    $("host-form").classList.toggle("file-only", canHost && !canShareScreen);
  })();
  // Screen sharing: whole screen, one window, or one browser tab (the browser's picker opens on that choice)
  S.surface = store.get("surface") || "monitor";
  const SURFACE_NOTES = {
    monitor: "Everything on your screen, from any app. Tick <strong>Share system audio</strong> for sound.",
    window: "Just one app's window, such as a media player. Other windows stay private.",
    browser: "One browser tab, such as a video site. Tick <strong>Share tab audio</strong> for sound: it's the most reliable way to share sound.",
  };
  function setSurface(v) {
    S.surface = v;
    store.set("surface", v);
    document.querySelectorAll("[data-surface]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.surface === v)));
    $("surface-note").innerHTML = SURFACE_NOTES[v];
  }
  document.querySelectorAll("[data-surface]").forEach((b) => (b.onclick = () => setSurface(b.dataset.surface)));
  setSurface(S.surface);
  if (canNativeShare && !canShareScreenWeb) {
    // Android app: always the whole device, from any app, while Boxxie Share runs in the background.
    $("surface-choice").hidden = true;
    $("surface-label").hidden = true;
    $("surface-note").innerHTML = `Shares everything on this ${isTV ? "TV" : "device"}, from any app. Start sharing, then press <strong>Home</strong> and open what you like. ${nativeInfo.audio ? "Sound is shared too." : "This device can only share the picture, not the sound."} Netflix, Prime and other paid apps show black.`;
    document.querySelector('[data-source="screen"]').lastChild.textContent = isTV ? "TV screen" : "Phone screen";
  }
  function setSource(src) {
    S.source = src;
    document.querySelectorAll("[data-source]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.source === src)));
    $("file-field").hidden = src !== "file";
    $("screen-field").hidden = src !== "screen";
  }
  document.querySelectorAll("[data-source]").forEach((b) => (b.onclick = () => setSource(b.dataset.source)));
  setSource(canHost ? "file" : "screen");
  const qualityNotes = {
    auto: "Adapts to each friend's display and connection, up to 1080p and 8 Mbps of video per friend on larger screens. Favours smooth motion when the connection or device is busy.",
    "4k": "4K needs about 25 Mbps of upload for each friend, so it suits 1–2 friends on full-fibre broadband, with a 4K film or screen. If your connection can't keep up, the picture steps down by itself.",
    smooth: "Uses up to 2.5 Mbps of video upload per friend, plus sound and network overhead. Try this for remote viewers, VPNs or a choppy picture.",
    hd: "Up to 8 Mbps of video upload per friend, plus sound and network overhead. Choose Smooth 720p if the picture is choppy.",
  };
  // Stack the notes in the same grid cell. All contribute their natural height,
  // so the longest note reserves space without guessing a fixed line count.
  for (const [q, text] of Object.entries(qualityNotes)) {
    const note = document.createElement("span");
    note.dataset.qualityNote = q;
    note.textContent = text;
    note.setAttribute("aria-hidden", "true");
    $("quality-note").append(note);
  }
  function setQuality(q) {
    if (!QUALITY[q]) return;
    if (q === "auto" && NATIVE && !nativeInfo.automaticQuality) q = "hd";
    S.quality = q;
    document.querySelectorAll("[data-quality]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.quality === q)));
    $("quality-note").querySelectorAll("[data-quality-note]").forEach(note =>
      note.setAttribute("aria-hidden", String(note.dataset.qualityNote !== q)));
  }
  document.querySelectorAll("[data-quality]").forEach((b) => (b.onclick = () => setQuality(b.dataset.quality)));
  document.querySelector('[data-quality="auto"]').hidden = !!NATIVE && !nativeInfo.automaticQuality;
  setQuality("auto");

  // Install hint for phones
  const DOWNLOADER_CODE = "1920999"; // AFTVnews short code for the latest BoxxieShare.apk
  (function installHint() {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const hint = $("install-hint");
    if (inApp) return;
    if (isTV) {
      // A TV browser: point to the real app
      hint.innerHTML = `Get the Boxxie Share app for this TV: open <strong>Downloader</strong> and type <strong>${DOWNLOADER_CODE}</strong>.`;
      hint.hidden = false;
      return;
    }
    if (standalone) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (ios) {
      hint.textContent = "To keep Boxxie Share on your home screen, tap Share in Safari, then Add to Home Screen.";
      hint.hidden = false;
    } else if (/Android/.test(navigator.userAgent)) {
      hint.textContent = "To keep Boxxie Share on your home screen, open the browser menu and choose Install app or Add to Home screen.";
      hint.hidden = false;
    } else {
      hint.innerHTML = `Watching on a Fire TV or Android TV? Get the app: open <strong>Downloader</strong> on the TV and type <strong>${DOWNLOADER_CODE}</strong>.`;
      hint.hidden = false;
    }
  })();

  // ---------------- host setup ----------------
  const filmVideo = $("film");
  let filmFile = null;
  let filmUrl = null;

  $("film-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    filmFile = f;
    $("film-label").textContent = f.name;
    document.querySelector(".file-pick").classList.add("has-file");
    if (S.role === "host" && S.ws) loadFilm(f, true);
  });
  // Make the label behave like a button for remotes/keyboards
  document.querySelector(".file-pick").tabIndex = 0;
  document.querySelector(".file-pick").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("film-file").click();
    }
  });

  $("host-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("host-error");
    showError(err, "");
    const name = needName(err);
    if (!name) return;
    if (S.source === "file" && !filmFile) return showError(err, "Choose a film to share.");
    if (!SERVER) return showError(err, ERRORS.no_server);

    $("host-start").disabled = true;
    try {
      if (S.source === "screen" && !canShareScreenWeb && canNativeShare) {
        const ok = await nativeStart();
        if (!ok) return showError(err, "Screen sharing wasn't allowed. Press Start sharing and choose Start now (or Allow) when asked.");
        useNativeScreen();
      } else if (S.source === "screen") {
        // Must be asked for straight away, while the button press still counts.
        const stream = await pickScreen();
        if (!stream) return showError(err, "Screen sharing was cancelled. Press Start sharing to choose what to share.");
        useScreen(stream);
      } else {
        const ok = await loadFilm(filmFile, false);
        if (!ok) return showError(err, "This file won't play on this device. Try an MP4 version of the film.");
      }
      const r = await api("/api/rooms", { method: "POST", body: { maxViewers: Number($("max-viewers").value) } });
      const data = r.data;
      if (!r.ok) return showError(err, ERRORS[data.error] || "Couldn't open a room. Try again.");
      S.role = "host";
      S.myId = "host";
      S.myName = name;
      S.code = data.code;
      S.hostToken = data.hostToken;
      enterRoom();
      connect();
      rememberTVRoom();
    } catch {
      showError(err, ERRORS.network);
    } finally {
      $("host-start").disabled = false;
    }
  });

  function loadFilm(file, swapping) {
    return new Promise((resolve) => {
      if (filmUrl) URL.revokeObjectURL(filmUrl);
      filmUrl = URL.createObjectURL(file);
      filmVideo.muted = false;
      filmVideo.srcObject = null;
      filmVideo.src = filmUrl;
      const done = (ok) => {
        filmVideo.removeEventListener("loadedmetadata", onMeta);
        filmVideo.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onMeta = () => {
        if (!S.capture) {
          S.capture = filmVideo.captureStream ? filmVideo.captureStream() : filmVideo.mozCaptureStream();
          S.capture.addEventListener("addtrack", refreshFileStream);
          S.capture.addEventListener("removetrack", refreshFileStream);
        }
        S.filmStream = fileStream();
        $("stage-empty").hidden = true;
        if (swapping) {
          banner("");
          toast("Film changed");
        }
        syncFilmToAll();
        done(filmVideo.videoWidth > 0 || filmVideo.duration > 0);
      };
      const onErr = () => done(false);
      filmVideo.addEventListener("loadedmetadata", onMeta);
      filmVideo.addEventListener("error", onErr);
      filmVideo.load();
    });
  }

  // ---------------- film capture, with a safety net ----------------
  // Normally the film player's own capture is sent. Some browsers capture sound but no
  // picture from certain formats (e.g. VP9). If no picture frames go out, switch to copying
  // the film frame by frame through a canvas. Friends never notice the switch.
  function fileStream() {
    if (!S.canvasMode) return S.capture;
    if (!S.combined) S.combined = new MediaStream();
    const want = [S.canvasTrack, ...S.capture.getAudioTracks()];
    for (const t of S.combined.getTracks()) if (!want.includes(t)) S.combined.removeTrack(t);
    for (const t of want) if (!S.combined.getTracks().includes(t)) S.combined.addTrack(t);
    return S.combined;
  }
  function refreshFileStream() {
    if (S.source !== "file" || (S.filmStream && S.filmStream._screen)) return;
    S.filmStream = fileStream();
    syncFilmToAll();
  }
  function startCanvasMode() {
    if (S.canvasMode) return;
    S.canvasMode = true;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    const draw = () => {
      if (!S.canvasMode) return;
      const w = filmVideo.videoWidth, h = filmVideo.videoHeight;
      if (w && h) {
        const scale = Math.min(1, quality().height / h);
        const cw = Math.round((w * scale) / 2) * 2, ch = Math.round((h * scale) / 2) * 2;
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        ctx.drawImage(filmVideo, 0, 0, cw, ch);
      }
      if (filmVideo.requestVideoFrameCallback) filmVideo.requestVideoFrameCallback(draw);
      else requestAnimationFrame(draw);
    };
    draw();
    S.canvasTrack = canvas.captureStream(30).getVideoTracks()[0];
    refreshFileStream();
  }
  setInterval(async () => {
    if (S.role !== "host" || S.source !== "file" || S.canvasMode || filmVideo.paused || !S.peers.size) return;
    let frames = 0, senders = 0;
    for (const p of S.peers.values()) {
      for (const sender of p.filmSenders.values()) {
        if (!sender.track || sender.track.kind !== "video") continue;
        senders++;
        try {
          (await sender.getStats()).forEach((r) => { if (r.type === "outbound-rtp") frames += r.framesEncoded || 0; });
        } catch {}
      }
    }
    if (!senders) return;
    S.noFrameChecks = frames === 0 ? (S.noFrameChecks || 0) + 1 : 0;
    if (S.noFrameChecks >= 2) startCanvasMode();
  }, 2000);

  // ---------------- screen sharing ----------------
  async function pickScreen() {
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: quality().width }, height: { ideal: quality().height }, frameRate: { ideal: 30, max: 30 }, displaySurface: S.surface || "monitor" },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: "include",
        surfaceSwitching: "include",
        selfBrowserSurface: "exclude",
        monitorTypeSurfaces: "include",
      });
    } catch {
      return null;
    }
  }
  function useScreen(stream) {
    const old = S.filmStream;
    if (old && old._screen && old !== stream) old.getTracks().forEach((t) => t.stop());
    stream._screen = true;
    S.filmStream = stream;
    filmVideo.pause();
    filmVideo.removeAttribute("src");
    filmVideo.srcObject = stream;
    filmVideo.muted = true; // your own preview; friends still get the sound
    filmVideo.play().catch(() => {});
    $("stage-empty").hidden = true;
    banner("");
    const v = stream.getVideoTracks()[0];
    if (v) v.addEventListener("ended", () => S.filmStream === stream && stoppedSharing());
    $("screen-status").textContent = stream.getAudioTracks().length
      ? "Friends see and hear your screen live"
      : "Friends see your screen. No sound: share again and tick Share audio.";
    syncFilmToAll();
  }
  function stoppedSharing() {
    if (S.filmStream && S.filmStream._screen) S.filmStream.getTracks().forEach((t) => t.stop());
    S.filmStream = new MediaStream();
    S.filmStream._screen = true;
    filmVideo.srcObject = null;
    $("stage-empty").hidden = false;
    $("stage-empty-text").textContent = "You've stopped sharing. Friends are still in the room.";
    $("screen-status").textContent = "Not sharing";
    syncFilmToAll();
    autoEnd("idle");
    $("ctl-reshare").focus();
  }
  $("ctl-reshare").onclick = async () => {
    if (S.native) {
      if (S.nativeSharing) return openApps();
      const ok = await nativeStart();
      if (ok) {
        useNativeScreen();
        for (const id of S.peers.keys()) if (!S.companionOf.has(id)) NATIVE.addViewer(id);
      }
      return;
    }
    const stream = await pickScreen();
    if (stream) useScreen(stream);
  };
  $("ctl-stopshare").onclick = () => {
    if (S.native) {
      try { NATIVE.stopScreenShare(); } catch {}
      return nativeStopped();
    }
    stoppedSharing();
  };

  // ----- Android app (Fire TV / Downloader build): Update button -----
  // The app checks the latest GitHub release; pressing Update downloads it and Android asks to install.
  const APP = (() => {
    try { return NATIVE && typeof NATIVE.appInfo === "function" ? JSON.parse(NATIVE.appInfo()) : null; } catch { return null; }
  })();
  let manualCheck = false;
  let updating = false;
  function checkForUpdate(manual) {
    if (!APP || !APP.canUpdate) return;
    manualCheck = !!manual;
    try { NATIVE.checkUpdate(); } catch {}
  }
  function updateLabel(text) {
    setLabel($("update-btn"), text);
  }
  function onUpdateEvent(ev) {
    const btn = $("update-btn");
    if (ev.type === "update") {
      const avail = !!ev.available;
      btn.hidden = !avail;
      if (avail && !updating) updateLabel(ev.name ? `Update to ${ev.name}` : "Update");
      $("app-version-text").textContent = `Boxxie Share ${ev.current || APP.name}` + (avail ? ` · ${ev.name || "an update"} is ready` : ev.failed ? "" : " · up to date");
      if (manualCheck) toast(avail ? "An update is ready. Press Update at the top." : ev.failed ? "Couldn't check for updates. Try again in a moment." : "You have the latest version.");
      manualCheck = false;
    } else if (ev.type === "update-progress") {
      updateLabel(ev.pct >= 100 ? "Installing…" : `Downloading ${ev.pct || 0}%`);
    } else if (ev.type === "update-permission") {
      updating = false;
      updateLabel("Update");
      toast("Turn on Boxxie Share in this list, press Back, then press Update again.", 9000);
    } else if (ev.type === "update-error") {
      updating = false;
      updateLabel("Try the update again");
      toast(ev.message || "The update didn't work. Try again.", 9000);
    }
  }
  if (APP && APP.canUpdate) {
    $("app-version").hidden = false;
    $("app-version-text").textContent = `Boxxie Share ${APP.name}`;
    checkForUpdate(false);
    setInterval(() => checkForUpdate(false), 6 * 60 * 60 * 1000);
  }
  $("update-check").onclick = () => checkForUpdate(true);
  if (NATIVE) {
    const details = [[nativeInfo.manufacturer, nativeInfo.model].filter(Boolean).join(" "),
      nativeInfo.androidVersion ? `Android ${nativeInfo.androidVersion}` : `Android API ${nativeInfo.sdk || "?"}`,
      nativeInfo.webViewVersion ? `WebView ${nativeInfo.webViewVersion}` : "",
      nativeInfo.automaticQuality ? "Automatic quality supported" : "Update the app for automatic quality"].filter(Boolean);
    $("device-info").textContent = details.join(" · ");
    $("device-info").hidden = false;
  }
  $("update-btn").onclick = () => {
    if (updating) return;
    updating = true;
    updateLabel("Starting…");
    try { NATIVE.installUpdate(); } catch { updating = false; }
  };

  // ----- TV app: notice when the film has finished -----
  // While sharing the TV screen, Boxxie can't see inside the other app, but it can tell whether
  // anything is playing sound. Nothing for 10 minutes = the film's over: start the 2-minute
  // countdown (the host's phone can keep the room open). Sound again cancels it.
  const QUIET_MS = (window.__boxxieQuietMs || 10 * 60 * 1000);
  let lastSound = Date.now();
  setInterval(() => {
    if (S.role !== "host" || !S.nativeSharing || typeof NATIVE.mediaPlaying !== "function") return;
    let playing = false;
    try { playing = !!NATIVE.mediaPlaying(); } catch {}
    if (playing) {
      lastSound = Date.now();
      if (S.endingWhy === "quiet") autoEnd(null);
    } else if (!S.endingWhy && S.roster && S.roster.length && Date.now() - lastSound > QUIET_MS) {
      autoEnd("quiet");
    }
  }, window.__boxxieQuietMs ? 1000 : 15000);

  // ----- TV app: warn when a VPN is on (it usually stops friends reaching the TV) -----
  function checkVpn() {
    let vpn = false;
    try { vpn = typeof NATIVE.networkInfo === "function" && !!JSON.parse(NATIVE.networkInfo()).vpn; } catch {}
    $("vpn-note").hidden = !(vpn && S.nativeSharing); // only the sharing TV ever runs this
  }
  setInterval(() => S.nativeSharing && checkVpn(), 15000);

  // ----- TV app: how each friend's picture is doing (shown under "Friends join here") -----
  const health = new Map();
  let localAudioHealth = null;
  $("copy-diagnostics").onclick = async () => {
    const active = (S.roster || []).filter(v => !v.companionOf).map(v => health.get(v.id) || {});
    const report = window.BoxxieDiagnostics.report({
      version: APP ? APP.name : "web",
      device: NATIVE ? [nativeInfo.manufacturer, nativeInfo.model,
        `Android ${nativeInfo.androidVersion || nativeInfo.sdk || "unknown"}`,
        `WebView ${nativeInfo.webViewVersion || "unknown"}`].filter(Boolean).join(" · ") : "Web browser",
      quality: quality().label, viewers: active,
    });
    try {
      await navigator.clipboard.writeText(report);
      $("diagnostics-report").hidden = true;
      toast("Picture diagnostics copied");
    } catch {
      // TV WebViews may not expose the clipboard. Keep the same report readable.
      const field = $("diagnostics-report");
      field.value = report;
      field.hidden = false;
      field.focus();
      field.select();
      toast("Report shown below. You can copy it or take a photo.");
    }
  };
  let browserStatsPending = false;
  setInterval(async () => {
    if (S.role !== "host" || S.native || browserStatsPending) return;
    browserStatsPending = true;
    try {
      for (const [id, p] of S.peers) {
        if (S.companionOf.has(id)) continue;
        const sender = [...p.filmSenders.values()].find(s => s.track?.kind === "video");
        if (!sender) continue;
        const report = await sender.getStats();
        if (S.peers.get(id) !== p || S.role !== "host") continue;
        const video = [...report.values()].find(r => r.type === "outbound-rtp" && (r.kind === "video" || r.mediaType === "video"));
        if (!video) continue;
        const codec = report.get(video.codecId);
        onViewerHealth({ type: "viewer-stats", peer: id, ice: p.pc.iceConnectionState,
          frames: video.framesEncoded || 0, bytes: video.bytesSent || 0,
          width: video.frameWidth, height: video.frameHeight, fps: video.framesPerSecond,
          codec: codec?.mimeType?.replace("video/", ""),
          profile: codec?.sdpFmtpLine?.match(/(?:^|[;\s])profile-level-id=([0-9a-f]{6})(?:;|\s|$)/i)?.[1],
          encoder: video.encoderImplementation, limit: video.qualityLimitationReason,
          targetBitrate: video.targetBitrate, route: window.BoxxieDiagnostics.route(report) });
      }
    } catch {} finally { browserStatsPending = false; }
  }, 3000);
  function onViewerHealth(ev) {
    if (ev.type === "audio-health") {
      localAudioHealth = ev;
      renderHealth();
      return;
    }
    if (!ev.peer) return;
    const h = health.get(ev.peer) || { frames: 0, last: 0 };
    if (ev.ice) h.ice = ev.ice;
    if (ev.type === "viewer-stats") {
      const now = performance.now();
      if (h.sampleAt && ev.bytes >= h.bytes) h.mbps = (ev.bytes - h.bytes) * 8 / (now - h.sampleAt) / 1000;
      h.sampleAt = now;
      h.growing = ev.frames > h.frames;
      h.frames = ev.frames;
      h.bytes = ev.bytes;
      h.codec = ev.codec || h.codec;
      h.encoder = ev.encoder || h.encoder;
      h.vp8 = ev.vp8;
      if (ev.sound !== undefined) h.sound = ev.sound;
      if (ev.audioBytes !== undefined) {
        h.soundSending = ev.audioBytes > (h.audioBytes || 0) + 500;
        h.audioBytes = ev.audioBytes;
      }
      h.fps = ev.fps;
      h.height = ev.height;
      h.width = ev.width;
      h.profile = ev.profile;
      h.route = ev.route;
      h.targetBitrate = ev.targetBitrate;
      h.startupBitrateAccepted = ev.startupBitrateAccepted;
      h.audioState = ev.audioState;
      h.audioFrames = ev.audioFrames;
      h.audioFormat = ev.audioFormat;
      h.capturedPcmBytes = ev.capturedPcmBytes;
      h.capturedPeak = ev.capturedPeak;
      h.outgoingPeak = ev.outgoingPeak;
      h.captureError = ev.captureError;
      h.limit = ev.limit;
    }
    health.set(ev.peer, h);
    renderHealth();
  }
  function renderHealth() {
    const list = $("viewer-health");
    list.replaceChildren();
    if (S.role !== "host") {
      list.hidden = true;
      $("test-sound").hidden = true;
      $("test-tv-capture").hidden = true;
      $("sound-detail").hidden = true;
      return;
    }
    // Everyone watching (from the room's list), with their picture status and a Remove button
    for (const v of S.roster || []) {
      const id = v.id;
      const h = health.get(id) || {};
      const li = document.createElement("li");
      const who = document.createElement("b");
      who.textContent = v.name || S.names.get(id) || "Friend";
      const st = document.createElement("span");
      const ice = h.ice || "new";
      let text;
      if (ice === "failed" || ice === "disconnected") {
        text = "can't connect (network)";
        li.className = "bad";
      } else if ((ice === "connected" || ice === "completed") && h.frames > 0) {
        const busy = h.limit === "cpu" ? " (encoder busy)" : h.limit === "bandwidth" ? " (network limited)" : "";
        const why = {
          "no-permission": " · no sound: Boxxie isn't allowed to record sound",
          error: " · no sound: recording didn't start",
          silent: " · captured audio is silent",
          nodata: " · no audio samples available",
          none: " · no sound",
        }[h.audioState];
        const snd = h.sound === undefined ? "" : !h.sound ? why || " · no sound playing" : h.soundSending === false ? " · sound not sending" : " and sound";
        text = `getting the picture${snd}${h.height ? ` · ${qualityName(h.height)}` : ""} · ${h.codec || "video"}${h.fps ? ` · ${h.fps} fps${busy}` : ""}`;
        if (h.mbps !== undefined) text += ` · ${h.mbps.toFixed(1)} Mbps`;
        if (h.route && h.route !== "unknown") text += ` · ${h.route}`;
        li.className = "ok";
      } else if (ice === "connected" || ice === "completed") {
        text = h.vp8 ? "connected, trying another video format…" : "connected, starting the picture…";
      } else {
        text = "connecting…";
      }
      st.textContent = text;
      const right = document.createElement("span");
      right.className = "vh-right";
      const rm = document.createElement("button");
      rm.className = "small";
      rm.type = "button";
      rm.textContent = "Remove";
      rm.setAttribute("aria-label", `Remove ${v.name} from the room`);
      rm.onclick = () => openPerson(v, true);
      right.append(st, rm);
      li.append(who, right);
      list.append(li);
    }
    list.hidden = !list.children.length;
    // Sound check tools (only while someone's watching)
    const anyone = !list.hidden;
    $("test-sound").hidden = !(anyone && NATIVE && typeof NATIVE.testSound === "function");
    $("test-tv-capture").hidden = !(anyone && NATIVE && S.nativeAudio && typeof NATIVE.testTvSoundCapture === "function");
    const first = [...health.values()].find((x) => x.audioFrames !== undefined);
    const diag = first || localAudioHealth;
    $("sound-detail").hidden = !diag;
    if (diag) $("sound-detail").textContent =
      `Sound: ${diag.audioState || "?"} · captured ${Math.round((diag.capturedPcmBytes || 0) / 1024)} KB` +
      ` · input peak ${diag.capturedPeak ?? "?"} · output peak ${diag.outgoingPeak ?? "?"}` +
      (first ? ` · RTP sent ${Math.round((first.audioBytes || 0) / 1024)} KB` : "") +
      (diag.captureError ? ` · error: ${diag.captureError}` : "");
  }
  $("test-sound").onclick = () => {
    try { NATIVE.testSound(); } catch {}
    toast("Sending a 3-second beep. Ask your friend if they heard it.", 5000);
    send({ type: "chat", text: "🔔 Test beep sent: can you hear it?" });
  };
  $("test-tv-capture").onclick = () => {
    try { NATIVE.testTvSoundCapture(); } catch {}
    toast("Playing a 4-second tone on the TV. Check whether your friend hears it too.", 6000);
    send({ type: "chat", text: "🔊 TV capture test: a tone is playing on the TV. Can you hear it here too?" });
  };

  // ----- TV app: choose one of the TV's apps to open while sharing -----
  let appsCache = null;
  function openApps() {
    if (typeof NATIVE.listApps !== "function") return NATIVE.goHome(); // older app versions
    if (!appsCache) {
      try { appsCache = JSON.parse(NATIVE.listApps()) || []; } catch { appsCache = []; }
    }
    const grid = $("apps-grid");
    grid.replaceChildren();
    const tile = (label, icon, onPick) => {
      const b = document.createElement("button");
      b.className = "app-tile";
      b.type = "button";
      b.append(icon);
      const t = document.createElement("span");
      t.textContent = label;
      b.append(t);
      b.onclick = () => {
        closeApps();
        onPick();
      };
      return b;
    };
    const home = document.createElement("span");
    home.className = "app-home";
    home.innerHTML = '<svg><use href="#i-home"/></svg>';
    grid.append(tile("TV home screen", home, () => NATIVE.goHome()));
    for (const a of appsCache) {
      const img = document.createElement("img");
      img.alt = "";
      if (a.icon) img.src = a.icon;
      grid.append(tile(a.label || a.pkg, img, () => NATIVE.launchApp(a.pkg)));
    }
    $("apps-panel").hidden = false;
    // While the list is open, the remote only moves around the list (not the buttons behind it)
    for (const el of $("screen-room").children) if (el.id !== "apps-panel") el.inert = true;
    const first = grid.querySelectorAll(".app-tile")[1] || grid.querySelector(".app-tile");
    if (first) first.focus();
  }
  function closeApps() {
    for (const el of $("screen-room").children) el.inert = false;
    $("apps-panel").hidden = true;
  }
  $("apps-close").onclick = () => {
    closeApps();
    $("ctl-reshare").focus();
  };
  // The remote moves through the list by itself (the buttons behind it are switched off while
  // it's open); keep whichever app is selected scrolled into view.
  $("apps-grid").addEventListener("focusin", (e) => {
    if (e.target.classList.contains("app-tile")) e.target.scrollIntoView({ block: "nearest" });
  });

  // ----- TV app: if Android restarts Boxxie's page while you're sharing, go straight back in -----
  function rememberTVRoom() {
    if (S.role === "host" && S.native && S.code) store.set("tvRoom", { code: S.code, hostToken: S.hostToken, at: Date.now() });
  }
  setInterval(() => S.ws && rememberTVRoom(), 30000);
  function forgetTVRoom() {
    store.set("tvRoom", null);
  }
  function resumeTVRoom() {
    const r = store.get("tvRoom");
    if (!r || !NATIVE || !r.code) return false;
    let sharing = false;
    try { sharing = typeof NATIVE.isSharing === "function" && !!NATIVE.isSharing(); } catch {}
    // The room keeps waiting 3 minutes for its host; after that it has closed.
    if (!sharing && Date.now() - r.at > 150000) {
      forgetTVRoom();
      return false;
    }
    S.role = "host";
    S.myId = "host";
    S.myName = myName();
    S.code = r.code;
    S.hostToken = r.hostToken;
    S.source = "screen";
    S.native = true;
    enterRoom();
    if (sharing) useNativeScreen();
    else nativeStopped();
    connect();
    toast(sharing ? "Back in your room. Still sharing." : "Back in your room. Press Share the screen again.", 6000);
    return true;
  }

  // Per-tab room recovery: account credentials stay in the existing session store;
  // this only remembers where this tab was watching. The server still checks the
  // account, room lifetime, host approval, lock and removal permissions on rejoin.
  function rememberViewerRoom() {
    if (S.role !== "viewer" || !S.code || !S.session) return;
    try {
      sessionStorage.setItem("bx:viewerRoom", JSON.stringify({
        code: S.code, companion: !!S.companion, pin: S.companion ? S.pin : null,
        userId: S.session.user.id, at: Date.now(),
      }));
    } catch {}
  }
  function forgetViewerRoom() {
    try { sessionStorage.removeItem("bx:viewerRoom"); } catch {}
  }
  function resumeViewerRoom() {
    let room;
    try { room = JSON.parse(sessionStorage.getItem("bx:viewerRoom") || "null"); } catch {}
    if (!room || !S.session) return false;
    if (room.userId !== S.session.user.id || !/^[A-Z0-9]{8}$/.test(room.code || "") ||
        !Number.isFinite(room.at) || Date.now() - room.at > 12 * 60 * 60 * 1000) {
      forgetViewerRoom();
      return false;
    }
    S.rejoinSince = Date.now();
    if (room.companion) {
      if (!/^\d{6}$/.test(room.pin || "")) { forgetViewerRoom(); return false; }
      joinAsPhone(room.code, room.pin);
    } else joinRoom(room.code);
    return true;
  }

  // ----- Android app: whole-screen sharing from the background -----
  // The page hands each viewer to the app's engine; the engine's offers/answers travel over the
  // normal signalling as {ch: "screen"} messages, on a connection separate from the call.
  let nativeWait = null;
  function nativeStart() {
    return new Promise((resolve) => {
      nativeWait = resolve;
      try {
        NATIVE.startScreenShare(JSON.stringify({ iceServers: S.ice || [], quality: quality() }));
      } catch {
        nativeWait = null;
        resolve(false);
      }
    });
  }
  window.boxxieNativeEvent = (json) => {
    let ev;
    try { ev = typeof json === "string" ? JSON.parse(json) : json; } catch { return; }
    if (!ev) return;
    if (String(ev.type).startsWith("update")) return onUpdateEvent(ev);
    if (ev.type === "viewer-state" || ev.type === "viewer-stats" || ev.type === "audio-health") return onViewerHealth(ev);
    if (ev.type === "started" || ev.type === "denied") {
      const w = nativeWait;
      nativeWait = null;
      if (ev.type === "started") S.nativeAudio = !!ev.audio;
      if (w) w(ev.type === "started");
    } else if (ev.type === "stopped") {
      if (S.nativeSharing) nativeStopped();
    } else if (ev.type === "signal" && ev.peer) {
      send({ type: "signal", to: ev.peer, data: { ...(ev.data || {}), ch: "screen" } });
    } else if (ev.type === "error") {
      toast(ev.message || "Screen sharing hit a problem.", 6000);
    }
  };
  function useNativeScreen() {
    S.native = true;
    S.nativeSharing = true;
    S.filmStream = new MediaStream(); // the picture goes through the app's own engine
    S.filmStream._screen = true;
    filmVideo.removeAttribute("src");
    filmVideo.srcObject = null;
    $("stage-empty").hidden = false;
    $("stage-empty-text").textContent = `Friends can see your ${isTV ? "TV" : "screen"}. Press Home and open any app; Boxxie Share keeps sharing in the background.`;
    $("screen-status").textContent = S.nativeAudio ? "Sharing this screen and its sound" : "Sharing this screen (picture only)";
    setLabel($("ctl-reshare"), "Open another app");
    try { NATIVE.setIceServers(JSON.stringify(S.ice || [])); } catch {}
    syncFilmToAll();
    lastSound = Date.now();
    if (S.endingWhy) autoEnd(null);
    checkVpn();
  }
  function nativeStopped() {
    S.nativeSharing = false;
    $("stage-empty").hidden = false;
    $("stage-empty-text").textContent = "You've stopped sharing. Friends are still in the room.";
    $("screen-status").textContent = "Not sharing";
    setLabel($("ctl-reshare"), "Share the screen again");
    autoEnd("idle");
  }

  // Viewer: the app's screen arrives on its own connection
  const screenPeers = new Map();
  const screenRestartAt = new Map();
  function restartScreenPeer(sp) {
    if (screenPeers.get(sp.from) !== sp || S.role !== "viewer" || S.closing ||
        !S.ws || S.ws.readyState !== 1 || document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - (screenRestartAt.get(sp.from) || 0) < 30000) return;
    screenRestartAt.set(sp.from, now);
    closeScreenPeer(sp.from);
    $("stage-empty-text").textContent = "Reconnecting to the TV's picture…";
    send({ type: "signal", to: sp.from, data: { ch: "screen", restart: true } });
  }
  async function screenDiag(sp) {
    if (screenPeers.get(sp.from) !== sp) return;
    let frames = 0, bytes = 0, audioBytes = 0;
    let route = "", fps = null, roundTrip = null;
    const mine = new Set(), theirs = new Set();
    try {
      const report = await sp.pc.getStats();
      let pairId;
      report.forEach(r => { if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      const pair = pairId ? report.get(pairId) : [...report.values()].find(r =>
        r.type === "candidate-pair" && r.state === "succeeded" && r.nominated);
      if (pair) {
        const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
        const relay = [local, remote].some(c => c && c.candidateType === "relay");
        const protocol = local && (local.relayProtocol || local.protocol);
        route = `${relay ? "relay" : "direct"}${protocol ? " " + protocol.toUpperCase() : ""}`;
        if (typeof pair.currentRoundTripTime === "number") roundTrip = Math.round(pair.currentRoundTripTime * 1000);
      }
      report.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          frames += r.framesDecoded || 0;
          bytes += r.bytesReceived || 0;
          if (typeof r.framesPerSecond === "number") fps = r.framesPerSecond;
        }
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          audioBytes += r.bytesReceived || 0;
          if (typeof r.audioLevel === "number") sp.level = r.audioLevel;
          if (typeof r.totalAudioEnergy === "number") {
            sp.energyRise = r.totalAudioEnergy - (sp.energy || 0);
            sp.energy = r.totalAudioEnergy;
          }
        }
        if (r.type === "local-candidate") mine.add(r.candidateType);
        if (r.type === "remote-candidate") theirs.add(r.candidateType);
      });
    } catch {}
    if (screenPeers.get(sp.from) !== sp) return;
    const el = $("screen-diag");
    const ice = sp.pc.iceConnectionState;
    const now = Date.now();
    const elapsed = sp.sampleAt ? (now - sp.sampleAt) / 1000 : 0;
    const mbps = elapsed > 0 ? Math.max(0, bytes - (sp.sampleBytes || 0)) * 8 / elapsed / 1e6 : null;
    sp.sampleAt = now;
    sp.sampleBytes = bytes;
    sp.networkDetails = [route, roundTrip === null ? "" : `${roundTrip} ms round trip`,
      mbps === null ? "" : `${mbps.toFixed(2)} Mbps received`, fps === null ? "" : `${Math.round(fps)} fps`].filter(Boolean).join(" · ");
    if (ice === "disconnected" || ice === "failed") {
      if (!sp.disconnectedAt) sp.disconnectedAt = now;
      if (ice === "failed" || now - sp.disconnectedAt > 10000) restartScreenPeer(sp);
    } else sp.disconnectedAt = null;
    // A paused/static source is valid. Only repair a stalled decoder when new
    // video bytes keep arriving without decoded frames for a sustained interval.
    if (bytes > (sp.lastVideoBytes || 0) && frames === sp.lastFrames) {
      if (!sp.decodeStallAt) sp.decodeStallAt = now;
      if (now - sp.decodeStallAt > 15000) restartScreenPeer(sp);
    } else sp.decodeStallAt = null;
    sp.lastVideoBytes = bytes;
    if (screenPeers.get(sp.from) !== sp) return;
    if (frames > (sp.lastFrames || 0)) resumeViewerPlayback();
    // Picture moving? Sound arriving?
    if (frames > (sp.lastFrames || 0)) sp.frameAt = now;
    if (audioBytes > (sp.lastAudio || 0) + 2000) sp.audioAt = now;
    sp.lastFrames = frames;
    sp.lastAudio = audioBytes;
    el.classList.toggle("corner", frames > 0);
    if (frames > 0) {
      const stalled = now - (sp.frameAt || now) > 5000;
      const noSound = now - (sp.audioAt || sp.started || now) > 8000;
      if (stalled) {
        el.replaceChildren(document.createTextNode("The TV's picture has paused. Waiting for it to come back…"));
      } else if (noSound) {
        el.replaceChildren(document.createTextNode("Picture's here, but no sound is arriving from the TV yet."));
      } else if (sp.showDetails) {
        const loud = (sp.level || 0) > 0.01 || (sp.energyRise || 0) > 0.0005;
        el.replaceChildren(document.createTextNode(loud ? "Sound is arriving from the TV 🔊" : "Sound is arriving, but it's silent 🔇"));
      } else {
        el.hidden = true;
        // Sound is arriving: make sure it isn't muted here
        if (filmVideo.muted) $("sound-on").hidden = false;
        return;
      }
      const small = document.createElement("small");
      small.textContent = `Network: ${ice}${sp.networkDetails ? " · " + sp.networkDetails : ""} · sound received ${Math.round(audioBytes / 1024)} KB · level ${(sp.level || 0).toFixed(3)} · ${filmVideo.muted ? "muted here" : "not muted"} · picture ${frames} frames`;
      el.append(small);
      el.hidden = false;
      return;
    }
    let msg;
    if (ice === "failed") msg = "Can't reach the TV's picture. Try the same Wi-Fi as the TV, or ask the host to press Stop sharing and share again.";
    else if (ice === "connected" || ice === "completed") msg = bytes > 0 ? "The picture is arriving…" : "Connected to the TV. Waiting for its picture…";
    else msg = "Connecting to the TV's picture…";
    el.replaceChildren(document.createTextNode(msg));
    const small = document.createElement("small");
    // relay = the relay server answered; srflx = internet address found; host = local network only
    const kinds = (set) => ["relay", "srflx", "host", "prflx"].filter((k) => set.has(k)).join("+") || "none";
    small.textContent = `Network: ${ice} · received ${Math.round(bytes / 1024)} KB · relay: ${mine.has("relay") ? "yes" : "no"} · you: ${kinds(mine)} · TV: ${kinds(theirs)}`;
    el.append(small);
    el.hidden = false;
  }
  // Friends: tap "Live from the host" to see connection and sound details
  $("viewer-status").addEventListener("click", () => {
    for (const sp of screenPeers.values()) sp.showDetails = !sp.showDetails;
  });
  function closeScreenPeer(from) {
    const sp = screenPeers.get(from);
    if (!sp) return;
    clearInterval(sp.timer);
    $("screen-diag").hidden = true;
    try { sp.pc.close(); } catch {}
    for (const track of sp.tracks || []) {
      if (S.filmView) S.filmView.removeTrack(track);
      try { track.stop(); } catch {}
    }
    screenPeers.delete(from);
    // Closing doesn't fire "ended" on the tracks, so tidy the picture up here.
    const view = S.filmView;
    if (view && S.role === "viewer") {
      for (const t of [...view.getTracks()]) if (t.readyState === "ended") view.removeTrack(t);
      if (!view.getVideoTracks().length) {
        $("stage-empty").hidden = false;
        $("stage-empty-text").textContent = "The host has paused sharing. Stay here and it'll come back.";
      }
    }
  }
  function screenSignal(from, data) {
    let sp = screenPeers.get(from);
    // A new sharing session (the host restarted sharing or the app reconnected) starts afresh.
    if (sp && data.session && sp.session !== data.session) {
      closeScreenPeer(from);
      sp = null;
    }
    if (!sp) {
      const pc = new RTCPeerConnection({ iceServers: S.ice, bundlePolicy: "max-bundle" });
      sp = { pc, session: data.session, pending: [], tracks: new Set(), from, started: Date.now() };
      sp.timer = setInterval(() => screenDiag(sp), 2000);
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: "signal", to: from, data: { ch: "screen", session: sp.session, candidate: e.candidate.toJSON() } });
      };
      pc.ontrack = (e) => {
        sp.tracks.add(e.track);
        attachFilm(e.streams[0] || new MediaStream([e.track]), e.track);
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") restartScreenPeer(sp);
      };
      screenPeers.set(from, sp);
    }
    const pc = sp.pc;
    (async () => {
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === "offer") {
            await pc.setLocalDescription(await pc.createAnswer());
            send({ type: "signal", to: from, data: { ch: "screen", session: sp.session, displayHeight: receiverDisplayHeight(), sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
          }
          for (const c of sp.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
          else sp.pending.push(data.candidate);
        } else if (data.bye) {
          closeScreenPeer(from);
        }
      } catch (e) {
        console.warn("screen", e);
      }
    })();
  }

  // ---------------- join ----------------
  // Room codes are 8 characters. A pairing code from a TV is the room code + 6 digits.
  function formatAny(raw) {
    const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
    return [c.slice(0, 4), c.slice(4, 8), c.slice(8)].filter(Boolean).join("-");
  }
  $("join-code").addEventListener("input", (e) => {
    e.target.value = formatAny(e.target.value);
  });
  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $("join-error");
    showError(err, "");
    const all = String($("join-code").value).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (all.length === 14 && /^\d{6}$/.test(all.slice(8))) return joinAsPhone(all.slice(0, 8), all.slice(8));
    const code = cleanCode(all);
    if (code.length !== 8) return showError(err, "Room codes have 8 letters and numbers. Pairing codes from a TV are longer.");
    const name = needName(err);
    if (!name) return;
    if (!SERVER) return showError(err, ERRORS.no_server);
    store.set("name", name);
    S.role = "viewer";
    S.companion = false;
    S.pin = null;
    S.code = code;
    S.myName = name;
    $("waiting-title").textContent = "Waiting to be let in";
    $("waiting-text").textContent = "The host will see your name and choose whether to let you in.";
    show("waiting");
    connect();
  });
  $("waiting-cancel").onclick = () => leave();

  function joinRoom(code) {
    const name = needName();
    if (!name) return;
    S.role = "viewer";
    S.companion = false;
    S.pin = null;
    S.code = cleanCode(code);
    S.myName = name;
    $("waiting-title").textContent = "Waiting to be let in";
    $("waiting-text").textContent = "The host will see your name and choose whether to let you in.";
    show("waiting");
    connect();
  }

  // A phone/tablet/laptop joining as the camera + mic for someone's TV. No approval, no film.
  function joinAsPhone(code, pin) {
    if (!SERVER) return showError($("join-error"), ERRORS.no_server);
    if (!S.session) {
      S.after = { pair: [code, pin] };
      return showSignin("Sign in with the same account as your TV to use this device for its video call.");
    }
    S.role = "viewer";
    S.companion = true;
    S.code = code;
    S.pin = pin;
    S.myName = "";
    $("waiting-title").textContent = "Pairing with the TV…";
    $("waiting-text").textContent = "Connecting this device as the TV's camera and microphone.";
    show("waiting");
    connect();
  }

  // ---------------- connection to server ----------------
  let connectionEpoch = 0;
  let connectionPending = false;
  async function connect() {
    if (!S.role || connectionPending || (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1))) return;
    const epoch = ++connectionEpoch;
    connectionPending = true;
    S.closing = false;
    const ticket = await getTicket();
    if (epoch !== connectionEpoch) return;
    connectionPending = false;
    if (S.closing || !S.role) return;
    if (!ticket) {
      if (S.session && S.role === "viewer") return rejoinSoon();
      return failConnect("signed_out");
    }
    const q = `ticket=${encodeURIComponent(ticket)}&` + (S.role === "host"
      ? `role=host&token=${encodeURIComponent(S.hostToken)}`
      : S.companion
        ? `role=companion&pin=${encodeURIComponent(S.pin)}`
        : `role=viewer`);
    let ws;
    try {
      ws = new WebSocket(`${WS_SERVER}/api/rooms/${S.code}/ws?${q}`);
    } catch {
      if (S.role === "viewer") return rejoinSoon();
      return failConnect("network");
    }
    S.ws = ws;
    let opened = false;
    S.refused = null;
    ws.onopen = () => {
      if (S.ws !== ws || S.closing) { ws.close(); return; }
      opened = true;
      S.reconnectTries = 0;
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(() => send({ type: "ping" }), 25000);
    };
    ws.onmessage = (ev) => {
      if (S.ws !== ws || S.closing) return;
      S.lastHeard = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onServer(m);
    };
    ws.onclose = (ev) => {
      if (S.ws !== ws || S.closing) return;
      clearInterval(S.pingTimer);
      if (S.refused) return failConnect(S.refused);
      if (S.role === "viewer" && ev.code === 4000) {
        return endWithMessage("Room opened elsewhere", "This account joined the room in another tab. You can rejoin here when you're ready.");
      }
      // Friends and paired phones: a locked screen or a signal drop isn't goodbye. Keep coming back.
      if (S.role === "viewer" && ev.code !== 4004 && ev.code !== 4003) return rejoinSoon();
      if (!opened) return failConnect("network");
      if (S.role === "host" && ev.code !== 4004 && ev.code !== 4000 && (S.reconnectTries < 8 || S.nativeSharing)) {
        S.reconnectTries++;
        banner("Connection dropped. Reconnecting…");
        setTimeout(() => S.ws === ws && connect(), Math.min(1000 * 2 ** S.reconnectTries, S.nativeSharing ? 5000 : 15000));
        return;
      }
      if (ev.code === 4004 || ev.code === 4003) return; // handled by room-closed / denied
      banner("You've been disconnected from the room.");
      if (S.role === "viewer") endWithMessage("Disconnected", "Your connection to the room dropped. Ask the host for the code and join again.");
    };
  }

  // ----- Coming back after the phone locks or loses signal -----
  // The server lets people the host already let in straight back in, so this is seamless.
  function rejoinSoon() {
    clearTimeout(hostAwayTimer);
    if (!S.rejoinSince) S.rejoinSince = Date.now();
    if (Date.now() - S.rejoinSince > 15 * 60 * 1000) {
      S.rejoinSince = null;
      return endWithMessage("Disconnected", "Your connection to the room dropped. Ask the host for the code and join again.");
    }
    banner("Reconnecting to the room…");
    for (const id of [...S.peers.keys()]) closePeer(id);
    for (const id of [...screenPeers.keys()]) closeScreenPeer(id);
    clearTimeout(S.rejoinTimer);
    const wait = document.visibilityState === "visible" ? Math.min(1000 * 2 ** S.reconnectTries, 10000) : 8000;
    S.reconnectTries++;
    S.rejoinTimer = setTimeout(() => S.role === "viewer" && !S.closing && connect(), wait);
  }
  function checkConnectionNow() {
    if (S.closing || S.role !== "viewer") return;
    if (S.rejoinSince) {
      // Unlocked or back online: try again straight away
      clearTimeout(S.rejoinTimer);
      S.reconnectTries = 0;
      connect();
    } else if (S.ws && S.ws.readyState === 1 && Date.now() - (S.lastHeard || 0) > 45000) {
      // A sleeping phone can retain a ghost socket whose close handshake never
      // finishes. Detach it before retrying; its late events must not affect us.
      const stale = S.ws;
      S.ws = null;
      clearInterval(S.pingTimer);
      try { stale.close(); } catch {}
      rejoinSoon();
    }
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && checkConnectionNow());
  addEventListener("online", checkConnectionNow);
  addEventListener("pageshow", checkConnectionNow);

  function failConnect(reason) {
    if (S.role === "host" && reason === "not_host") forgetTVRoom();
    if (S.role === "host") {
      banner(ERRORS[reason] || ERRORS.network);
      return;
    }
    if (reason !== "network" && reason !== "signed_out") forgetViewerRoom();
    S.ws = null;
    show("home");
    showError($("join-error"), ERRORS[reason] || ERRORS.network);
  }

  function send(m) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
  }

  function onServer(m) {
    switch (m.type) {
      case "refused": // server said no before we got in (wrong code, too many tries…)
        S.refused = m.error;
        return;
      case "welcome": // host
        S.ice = m.iceServers || [];
        if (S.native) try { NATIVE.setIceServers(JSON.stringify(S.ice)); } catch {}
        banner("");
        return;
      case "waiting": // viewer
        S.myId = m.id;
        $("waiting-text").textContent = `${m.hostName || "The host"} will see your name and choose whether to let you in.`;
        return;
      case "approved":
        if (S.rejoinSince) {
          S.rejoinSince = null;
          banner("");
        }
        S.ice = m.iceServers || [];
        if (S.native) try { NATIVE.setIceServers(JSON.stringify(S.ice)); } catch {}
        if (m.companion) {
          S.companion = true;
          S.myName = m.ownerName || "Guest";
          S.companionOwner = m.ownerId;
        }
        rememberViewerRoom();
        enterRoom();
        if (S.companion) startCall(); // straight onto the call: that's what this device is for
        return;
      case "companion-code":
        showPairing(m.pin);
        return;
      case "paired": // our phone has connected
        setPhonePaired(true);
        return;
      case "denied":
        if (S.role === "viewer") {
          forgetViewerRoom();
          const text = { locked: "The host has locked this room, so no one else can join right now.", busy: "Lots of people are waiting to join. Try again in a minute.", removed: "The host removed you from the room.", denied: "The host didn't let you in this time." }[m.reason] || "You can't join this room.";
          endWithMessage("Not let in", text);
        }
        return;
      case "join-request":
        S.names.set(m.id, m.name);
        toast(`${m.name} wants to join`);
        const r = $("requests");
        r.classList.remove("flash");
        void r.offsetWidth;
        r.classList.add("flash");
        if (isTV && !isTyping()) setTimeout(() => document.querySelector("#request-list .allow")?.focus(), 50);
        try { navigator.vibrate && navigator.vibrate(120); } catch {}
        return;
      case "roster": // host
        renderRoster(m);
        return;
      case "peers": // viewer: everyone else in the room
        S.myId = m.you;
        m.peers.forEach((p) => (p.companionOf ? S.companionOf.set(p.id, p.companionOf) : S.companionOf.delete(p.id)));
        syncViewerPeers(m.peers);
        renderPeople(m.peers.map((p) => ({ ...p })), false);
        setPhonePaired(m.peers.some((p) => p.companionOf && p.companionOf === S.myId));
        return;
      case "viewer-ready": // host: start streaming to this viewer
        S.names.set(m.id, m.name);
        if (m.companionOf) S.companionOf.set(m.id, m.companionOf);
        else S.companionOf.delete(m.id);
        resetPeer(m.id);
        if (S.nativeSharing && !m.companionOf) try { NATIVE.addViewer(m.id); } catch {}
        return;
      case "viewer-left":
        health.delete(m.id);
        renderHealth();
        closePeer(m.id);
        if (S.native) try { NATIVE.removeViewer(m.id); } catch {}
        return;
      case "requests": // the host's paired phone: who's waiting to be let in
        renderRequests(m.pending);
        return;
      case "signal":
        onSignal(m.from, m.data);
        return;
      case "chat":
        addChat(m);
        // The host sent a test beep: show this friend's sound meter for 20 seconds
        if (S.role === "viewer" && m.host && /Test beep sent/.test(m.text || "")) {
          for (const sp of screenPeers.values()) sp.showDetails = true;
          setTimeout(() => { for (const sp of screenPeers.values()) sp.showDetails = false; }, 20000);
        }
        return;
      case "remote":
        applyRemote(m.action, m.by);
        return;
      case "host-away":
        // Switching players can briefly interrupt signalling while the media
        // connection remains usable. Keep the room and its existing tracks.
        clearTimeout(hostAwayTimer);
        banner("Waiting for the host's video. Stay here—the room is still open.");
        hostAwayTimer = setTimeout(() => {
          if (S.role === "viewer" && !S.closing)
            banner("Reconnecting to the host. Stay here—we'll resume when they're back.");
        }, 10000);
        return;
      case "host-back":
        clearTimeout(hostAwayTimer);
        banner("");
        resetPeer("host");
        return;
      case "ending":
        showEnding(m.in, m.why);
        return;
      case "room-closed":
        S.closing = true;
        forgetViewerRoom();
        forgetTVRoom();
        if (S.role === "host") {
          cleanup();
          show("home");
          toast({ expired: "The room reached its 12-hour limit and closed.", finished: "The film finished and the room closed.", idle: "Sharing stopped, so the room closed.", quiet: "Nothing played for a while, so the room closed." }[m.reason] || "Room closed.");
        } else {
          const why = {
            expired: "The room reached its 12-hour limit.",
            "paired-left": "The TV this device was paired with has left the room.",
            "paired-elsewhere": "Another device has been paired with the TV instead.",
            finished: "The film has finished. Thanks for watching!",
            idle: "The host stopped sharing, so the room closed. Thanks for watching!",
            quiet: "Nothing has played on the TV for a while, so the room closed. Thanks for watching!",
          }[m.reason] || "The host has ended the session. Thanks for watching.";
          endWithMessage(m.reason && m.reason.startsWith("paired") ? "Call ended" : "The room has closed", why);
        }
        return;
      case "error":
        if (m.error === "room_full") toast("The room is full. Remove someone or raise the limit next time.");
        return;
    }
  }

  // ---------------- room UI ----------------
  function enterRoom() {
    show("room");
    const host = S.role === "host";
    $("screen-room").classList.toggle("screen-host", host && S.source === "screen");
    $("code-block").hidden = !host;
    $("share-panel").hidden = true;
    setTimeout(showControls, 0);
    $("invite-panel").hidden = true;
    if (host) S.invitedIds = new Set();
    $("host-controls").hidden = !host || S.source === "screen";
    $("quality-tag").textContent = host ? `Sending up to ${quality().label}` : "";
    $("quality-tag").hidden = !host;
    $("screen-controls").hidden = !host || S.source !== "screen";
    $("viewer-controls").hidden = host;
    $("viewer-display-control").hidden = host || !!S.companion;
    $("requests").hidden = true;
    $("chat-log").replaceChildren();
    $("cams").replaceChildren();
    renderJoinCard();
    if (host) {
      renderCode(S.code);
      $("stage-empty").hidden = !!(filmVideo.src || filmVideo.srcObject);
      updatePlayButton();
    } else {
      filmVideo.removeAttribute("src");
      filmVideo.srcObject = null;
      $("stage-empty").hidden = false;
      $("stage-empty-text").textContent = "Connecting to the film…";
    }
    $("screen-room").classList.toggle("call-mode", !!S.companion);
    setSide(!!S.companion);
    $("share-open").hidden = !host;
    $("people-open").hidden = !host;
    $("ask-pause").hidden = host || !!S.companion;
    $("code-pill").hidden = !host;
    if (host) $("code-pill").textContent = formatCode(S.code);
    $("live-text").textContent = host ? `Live · ${quality().label.split(" ")[0]}` : "Live";
    $("toggle-side").hidden = !!S.companion;
    $("airplay-open").hidden = !isApple || !!S.companion || isTV;
    $("airplay-panel").hidden = true;
    $("ctl-full").hidden = !!S.companion;
    $("remote").hidden = !(S.companion && S.companionOwner === "host");
    $("faces").replaceChildren();
    $("chat-toasts").replaceChildren();
    $("chat-unread").hidden = true;
    renderFaces();
    $("call-mode-note").hidden = !S.companion;
    if (S.companion) $("call-mode-note").textContent = `You're the camera and mic for ${S.myName}'s TV. The film stays on the TV. Keep this device nearby to talk.`;
    // TVs have no camera: offer to use a phone instead. Phones/laptops can do both.
    const tvOnly = isTV || !canCall;
    $("call-toggle").hidden = tvOnly && !S.companion;
    $("pair-phone").hidden = !!S.companion;
    setLabel($("pair-phone"), tvOnly ? "Use your phone for the video call" : "Use phone");
    $("pair-phone").classList.toggle("primary", tvOnly);
    $("pair-panel").hidden = true;
    setPhonePaired(false);
    addChat({ system: true, text: host ? "Room open. Share the code with friends." : "You're in. Say hello." });
    keepAwake();
    if (isTV) setTimeout(() => (host ? (S.source === "screen" ? $("ctl-reshare") : $("ctl-play")) : $("ctl-full")).focus(), 50);
  }

  function renderCode(code) {
    const box = $("code-tiles");
    box.replaceChildren();
    box.setAttribute("aria-label", "Room code " + code.split("").join(" "));
    code.split("").forEach((ch, i) => {
      if (i === 4) {
        const g = document.createElement("span");
        g.className = "gap";
        box.append(g);
      }
      const t = document.createElement("span");
      t.className = "tile";
      t.textContent = ch;
      t.setAttribute("aria-hidden", "true");
      box.append(t);
    });
  }

  function joinLink() {
    return `${location.origin}${location.pathname}#join=${formatCode(S.code)}`;
  }
  // The website address without https:// or a trailing slash, for reading off a TV
  const siteAddress = () => (location.host + location.pathname).replace(/\/(index\.html)?$/, "");
  function renderJoinCard() {
    const show = S.role === "host" && !!S.code;
    $("join-card").hidden = !show;
    if (!show) return;
    $("join-addr").textContent = siteAddress();
    $("join-code-big").textContent = formatCode(S.code);
    const box = $("join-qr");
    box.replaceChildren();
    try { box.append(window.BoxxieQR.svg(joinLink(), { size: 200, dark: "#142130", light: "#ffffff" })); } catch {}
  }

  // ----- Share invite: WhatsApp, Messages (iMessage on iPhone), Email, copy, phone share menu, QR -----
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && "ontouchend" in document || /iPhone|iPad|iPod/.test(navigator.userAgent);
  function inviteText() {
    return `${myName() || "A friend"} invited you to watch together on Boxxie Share.\nJoin here: ${joinLink()}\nRoom code: ${formatCode(S.code)}`;
  }
  $("share-open").onclick = () => {
    const text = inviteText();
    const enc = encodeURIComponent(text);
    $("share-whatsapp").href = `https://wa.me/?text=${enc}`;
    // iPhone/iPad: sms:&body= opens iMessage. Android: sms:?body=
    $("share-sms").href = isApple ? `sms:&body=${enc}` : `sms:?body=${enc}`;
    $("share-sms-label").textContent = isApple ? "iMessage" : "Messages";
    $("share-email").href = `mailto:?subject=${encodeURIComponent("Watch with me on Boxxie Share")}&body=${enc}`;
    $("share-more").hidden = !navigator.share;
    // TVs can't send messages: just show the QR code, big.
    $("share-apps").hidden = isTV;
    $("share-panel").classList.toggle("tv-share", isTV);
    const box = $("share-qr");
    box.replaceChildren();
    try { box.append(window.BoxxieQR.svg(joinLink(), { size: 200 })); } catch {}
    $("share-addr").textContent = siteAddress();
    $("share-code").textContent = formatCode(S.code);
    $("invite-panel").hidden = true;
    $("share-panel").hidden = false;
    $("share-link-label").textContent = "Copy link";
    (isTV ? $("share-close") : $("share-whatsapp")).focus();
  };
  $("share-close").onclick = () => {
    $("share-panel").hidden = true;
    $("share-open").focus();
  };
  $("share-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(inviteText());
      $("share-link-label").textContent = "Copied";
      toast("Invite copied. Paste it into any chat.");
    } catch {
      toast(`Room code: ${formatCode(S.code)}`, 8000);
    }
  };
  $("share-more").onclick = async () => {
    try {
      await navigator.share({ title: "Watch with me on Boxxie Share", text: inviteText() });
    } catch {}
  };
  function setLabel(btn, text) {
    const span = btn.querySelector("span");
    if (span) span.textContent = text;
    else btn.textContent = text;
  }

  $("lock-room").onclick = () => send({ type: "lock", locked: !S.locked });

  S.invitedIds = new Set();
  $("invite-open").onclick = async () => {
    $("invite-panel").hidden = false;
    renderInvitePanel();
    await loadMe();
    renderInvitePanel();
    const first = document.querySelector("#invite-friends button");
    (first || $("invite-close")).focus();
  };
  $("invite-close").onclick = () => {
    $("invite-panel").hidden = true;
    $("invite-open").focus();
  };
  function renderInvitePanel() {
    const friends = ((S.me && S.me.friends) || []).filter((f) => f.status === "friends");
    const list = $("invite-friends");
    list.replaceChildren(...friends.map((f) => {
      const li = document.createElement("li");
      li.append(chip(f.name, "", 1, null, f.photo));
      if (S.invitedIds.has(f.id)) {
        const done = document.createElement("span");
        done.className = "sent";
        done.textContent = "Invited";
        li.append(done);
      } else {
        const b = document.createElement("button");
        b.className = "small primary";
        b.textContent = "Invite";
        b.onclick = async () => {
          b.disabled = true;
          const r = await api(`/api/rooms/${S.code}/invite`, { method: "POST", body: { hostToken: S.hostToken, friendIds: [f.id] } });
          if (r.ok && r.data.invited.includes(f.id)) S.invitedIds.add(f.id);
          else toast("Couldn't invite them. Try again.");
          renderInvitePanel();
        };
        li.append(b);
      }
      return li;
    }));
    $("invite-empty").hidden = friends.length > 0;
  }

  function renderRoster(m) {
    S.locked = !!m.locked;
    const lockBtn = $("lock-room");
    setLabel(lockBtn, S.locked ? "Unlock" : "Lock");
    lockBtn.setAttribute("aria-label", S.locked ? "Unlock room" : "Lock room");
    lockBtn.title = S.locked ? "Let new people ask to join again" : "Stop anyone else asking to join";
    lockBtn.setAttribute("aria-pressed", String(S.locked));

    renderRequests(m.pending);

    m.viewers.forEach((v) => {
      S.names.set(v.id, v.name);
      if (v.companionOf) S.companionOf.set(v.id, v.companionOf);
    });
    renderPeople(m.viewers, true, m.maxViewers);
    S.roster = m.viewers.filter((v) => !v.companionOf);
    renderHealth();
    setPhonePaired(m.viewers.some((v) => v.companionOf === "host"));
  }
  function renderRequests(pending) {
    const list = $("request-list");
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren();
    pending.forEach((p) => {
      S.names.set(p.id, p.name);
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.className = "who";
      const b = document.createElement("b");
      b.textContent = p.name;
      n.append(b, " wants to join");
      const yes = document.createElement("button");
      yes.className = "small allow";
      yes.textContent = "Let in";
      yes.onclick = () => send({ type: "approve", id: p.id });
      const no = document.createElement("button");
      no.className = "small deny";
      no.textContent = "Decline";
      no.onclick = () => send({ type: "deny", id: p.id });
      li.append(n, yes, no);
      list.append(li);
    });
    $("requests").hidden = pending.length === 0;
    if (hadFocus && S.role === "host") (list.querySelector(".allow") || (S.source === "screen" ? $("ctl-reshare") : $("ctl-play"))).focus();
  }

  const AV_COLOURS = ["#efcb99", "#ca99a6", "#e97684", "#489fa0", "#b0bfd1", "#5f83a1"];
  function chip(name, tag, i, onRemove, photo) {
    const el = document.createElement(onRemove ? "button" : "span");
    el.className = "chip";
    const av = document.createElement("span");
    av.className = "av";
    renderAvatar(av, { name, photo }, i);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = name;
    el.append(av, nm);
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      el.append(t);
    }
    if (onRemove) {
      el.title = `Remove ${name}`;
      el.setAttribute("aria-label", `${name}. Press to remove from the room`);
      el.onclick = onRemove;
    }
    return el;
  }
  function renderPeople(people, asHost, max) {
    const list = $("people-list");
    list.replaceChildren();
    const myId = asHost ? "host" : S.myId;
    const phones = new Set(people.filter((p) => p.companionOf).map((p) => p.companionOf));
    const myOwner = S.companion ? S.companionOwner : null;
    // Paired phones fold into their owner's chip; a phone doesn't list its own TV separately.
    const watchers = people.filter((p) => !p.companionOf && p.id !== myOwner);
    const tagFor = (id, base) => [base, phones.has(id) ? "on phone" : ""].filter(Boolean).join(" · ");
    list.append(chip(S.myName, S.companion ? "you · call on this device" : tagFor(myId, asHost ? "you · sharing" : "you"), 0, null, S.session && S.session.user.photo));
    watchers.forEach((p, i) => {
      const open = () => openPerson(p, asHost || (canControlRoom() && !p.host));
      const c = chip(p.name, tagFor(p.id, p.host ? "sharing" : ""), i + 1, open, p.photo);
      c.title = `${p.name}: remove, block or report`;
      c.setAttribute("aria-label", `${p.name}. Press to remove, block or report`);
      list.append(c);
    });
    $("people-count").textContent = asHost && max ? `Watching · ${watchers.length} of ${max}` : `Watching · ${watchers.length + 1}`;
  }

  // ----- Safety: remove, block, report (needed for Google Play and the App Store) -----
  S.blocked = new Set();
  S.recentByUser = new Map();
  let personNow = null;
  function openPerson(p, asHost) {
    personNow = { ...p, asHost };
    $("person-name").textContent = p.name;
    $("person-remove").hidden = !asHost;
    $("person-block").hidden = !p.userId;
    $("person-block").textContent = S.blocked.has(p.userId) ? "Unblock" : "Block";
    $("person-report").hidden = false;
    $("person-panel").hidden = false;
    (asHost ? $("person-remove") : $("person-report")).focus();
  }
  $("person-close").onclick = () => ($("person-panel").hidden = true);
  $("person-remove").onclick = () => {
    const p = personNow;
    if (!p || !confirm(`Remove ${p.name} from the room?`)) return;
    send({ type: "kick", id: p.id });
    $("person-panel").hidden = true;
  };
  async function blockUser(userId, name, roomId) {
    const r = await api("/api/blocks/add", { method: "POST", body: { id: userId } });
    if (!r.ok) return toast("Couldn't block them. Try again.");
    S.blocked.add(userId);
    if (S.role === "host" && roomId) send({ type: "kick", id: roomId });
    hideBlockedChat();
    toast(`${name} is blocked.`);
    loadMe();
  }
  async function unblockUser(userId, name) {
    await api("/api/blocks/remove", { method: "POST", body: { id: userId } });
    S.blocked.delete(userId);
    toast(`${name} is unblocked.`);
    loadMe();
  }
  $("person-block").onclick = async () => {
    const p = personNow;
    if (!p || !p.userId) return;
    $("person-panel").hidden = true;
    if (S.blocked.has(p.userId)) return unblockUser(p.userId, p.name);
    if (!confirm(`Block ${p.name}? They won't be able to invite you, join your rooms or appear in your chat.`)) return;
    blockUser(p.userId, p.name, p.id);
  };
  $("person-report").onclick = () => {
    const p = personNow;
    $("person-panel").hidden = true;
    openReport(p ? { userId: p.userId, name: p.name, roomId: p.id } : null);
  };
  let reportNow = null;
  function openReport(target) {
    reportNow = target;
    $("report-title").textContent = target ? `Report ${target.name}` : "Report a problem";
    $("report-block-row").hidden = !(target && target.userId);
    $("report-note").hidden = !(target && target.userId);
    $("report-details").value = "";
    $("report-panel").hidden = false;
    $("report-panel").querySelector("input[name=reason]").focus();
  }
  $("report-cancel").onclick = () => ($("report-panel").hidden = true);
  $("report-problem").onclick = () => openReport(null);
  $("report-panel").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = reportNow;
    const reason = ($("report-panel").querySelector("input[name=reason]:checked") || {}).value || "other";
    const block = !!(t && t.userId && $("report-block").checked);
    const body = {
      userId: (t && t.userId) || null,
      room: S.code || "",
      reason,
      details: $("report-details").value,
      messages: (t && t.userId && S.recentByUser.get(t.userId)) || [],
      block,
    };
    $("report-send").disabled = true;
    const r = await api("/api/report", { method: "POST", body });
    $("report-send").disabled = false;
    if (!r.ok) return toast(r.status === 429 ? "You've sent a lot of reports today. Try again tomorrow." : "Couldn't send the report. Try again.");
    $("report-panel").hidden = true;
    if (block) {
      S.blocked.add(t.userId);
      if (S.role === "host" && t.roomId) send({ type: "kick", id: t.roomId });
      hideBlockedChat();
      loadMe();
    }
    toast(block ? "Thanks. Report sent and they're blocked." : "Thanks. Your report was sent.", 5000);
  });
  function hideBlockedChat() {
    document.querySelectorAll("#chat-log li[data-user]").forEach((li) => {
      if (S.blocked.has(li.dataset.user)) li.remove();
    });
  }

  // ---------------- chat ----------------
  function addChat(m) {
    if (m.userId && S.blocked.has(m.userId)) return; // you've blocked them
    if (m.userId && !m.system) {
      const list = S.recentByUser.get(m.userId) || [];
      list.push(m.text);
      S.recentByUser.set(m.userId, list.slice(-20));
    }
    const log = $("chat-log");
    const li = document.createElement("li");
    if (m.system) {
      li.className = "system";
      li.textContent = m.text;
    } else {
      if (m.host) li.className = "host-tag";
      if (m.userId) li.dataset.user = m.userId;
      if (m.name && m.name === S.myName) li.classList.add("mine");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = m.name;
      const txt = document.createElement("span");
      txt.textContent = m.text;
      if (/^\p{Extended_Pictographic}(️)?$/u.test(m.text)) txt.className = "big";
      li.append(who, txt);
    }
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(li);
    while (log.children.length > 300) log.firstChild.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
    if (!$("screen-room").hidden) chatToast(m);
  }
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    input.value = "";
  });
  document.querySelectorAll(".react").forEach((b) => (b.onclick = () => send({ type: "chat", text: b.dataset.react })));

  // ---------------- WebRTC peers ----------------
  // One connection per pair of people. Host→viewer carries the film (+ cameras);
  // viewer↔viewer carries cameras only. "Perfect negotiation" lets either side add
  // or remove tracks at any time without clashing.
  class Peer {
    constructor(id) {
      this.id = id;
      this.polite = S.myId > id; // deterministic tie-break
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.kinds = {}; // remote streamId -> "film" | "cam"
      this.filmSenders = new Map(); // trackId -> RTCRtpSender
      this.camSenders = [];
      this.pc = new RTCPeerConnection({ iceServers: S.ice, bundlePolicy: "max-bundle" });
      const pc = this.pc;
      pc.onnegotiationneeded = () => this.negotiate();
      pc.onicecandidate = (e) => e.candidate && this.signal({ candidate: e.candidate });
      pc.ontrack = (e) => this.onTrack(e);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") pc.restartIce();
        if (this.id === "host" && S.role === "viewer") {
          if (pc.connectionState === "connected") updateViewerQuality();
          if (pc.connectionState === "failed") $("viewer-status").textContent = "Trouble connecting. Retrying…";
        }
      };
    }
    async negotiate() {
      const pc = this.pc;
      if (pc.signalingState !== "stable" || this.makingOffer) {
        this.retryOffer = true; // try again once the current exchange finishes
        return;
      }
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription });
      } catch (e) {
        console.warn("negotiation", e);
      } finally {
        this.makingOffer = false;
      }
    }
    // If both sides changed tracks at once, one offer is dropped. Re-offer so nothing is lost.
    afterExchange() {
      if (S.role === "host" && !S.companionOf.has(this.id)) applyViewerLimits(this);
      if (!this.retryOffer || this.pc.signalingState !== "stable") return;
      this.retryOffer = false;
      setTimeout(() => this.negotiate(), 50);
    }
    signal(data) {
      if (S.role === "viewer" && this.id === "host") data = { ...data, displayHeight: receiverDisplayHeight() };
      send({ type: "signal", to: this.id, data });
    }
    // Handle this person's messages strictly one after another. Running them in parallel
    // made an offer look like a clash while the previous answer was still being applied.
    onSignal(data) {
      this.queue = (this.queue || Promise.resolve()).then(() => this.handleSignal(data)).catch(() => {});
      return this.queue;
    }
    async handleSignal(data) {
      const pc = this.pc;
      try {
        if (S.role === "host" && !S.companionOf.has(this.id) && data.displayHeight !== undefined) {
          this.displayHeight = data.displayHeight >= 1080 ? 1080 : 720;
          applyViewerLimits(this);
        }
        if (data.displayOnly) return;
        if (data.kinds) {
          Object.assign(this.kinds, data.kinds);
          return;
        }
        if (data.camOff) {
          removeCamTile(this.id);
          return;
        }
        if (data.description) {
          const d = data.description;
          const collision = d.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
          this.ignoreOffer = !this.polite && collision;
          if (this.ignoreOffer) return;
          if (collision) this.retryOffer = true; // our own offer is being rolled back
          await pc.setRemoteDescription(d);
          if (d.type === "offer") {
            await pc.setLocalDescription();
            this.signal({ description: pc.localDescription });
          }
          this.afterExchange();
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (e) {
            if (!this.ignoreOffer) console.warn("ice", e);
          }
        }
      } catch (e) {
        console.warn("signal", e);
      }
    }
    onTrack(e) {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const kind = this.kinds[stream.id] || (this.id === "host" && e.track.kind === "video" && !this.sawFilm ? "film" : "cam");
      if (kind === "film") {
        this.sawFilm = true;
        attachFilm(stream, e.track);
      } else {
        showCamTile(this.id, S.names.get(this.id) || "Guest", stream, false);
      }
      e.track.addEventListener("ended", () => kind === "cam" && removeCamTile(this.id));
    }
    close() {
      try { this.pc.close(); } catch {}
      removeCamTile(this.id);
    }
  }

  function getPeer(id) {
    let p = S.peers.get(id);
    if (!p) {
      p = new Peer(id);
      S.peers.set(id, p);
      if (S.role === "host" && !S.companionOf.has(id)) syncFilm(p);
      if (S.inCall && S.camStream) addCam(p);
    }
    return p;
  }
  function resetPeer(id) {
    closePeer(id);
    getPeer(id);
  }
  function closePeer(id) {
    const p = S.peers.get(id);
    if (p) {
      p.close();
      S.peers.delete(id);
    }
  }
  function onSignal(from, data) {
    if (!data || typeof data !== "object") return;
    if (data.ch === "screen") {
      if (S.role === "host") {
        if (data.restart) {
          if (S.nativeSharing && S.peers.has(from) && !S.companionOf.has(from)) {
            const now = Date.now();
            if (now - (screenRestartAt.get(from) || 0) >= 15000) {
              screenRestartAt.set(from, now);
              try { NATIVE.addViewer(from); } catch {}
            }
          }
          return;
        }
        if (NATIVE && S.native) try { NATIVE.signal(from, JSON.stringify(data)); } catch {}
      } else screenSignal(from, data);
      return;
    }
    getPeer(from).onSignal(data);
  }

  function syncViewerPeers(peers) {
    const ids = new Set(peers.map((p) => p.id));
    peers.forEach((p) => {
      S.names.set(p.id, p.name);
      getPeer(p.id);
    });
    for (const id of [...S.peers.keys()]) if (!ids.has(id)) closePeer(id);
  }

  // Host: make sure each viewer is receiving the current film tracks.
  function applyViewerLimits(p) {
    const q = window.BoxxieQuality.limits(quality(), p.displayHeight);
    // Serialize updates: resize and negotiation can otherwise race setParameters.
    p.qualityUpdate = (p.qualityUpdate || Promise.resolve()).then(async () => {
      for (const sender of p.filmSenders.values()) {
        if (!sender.track || sender.track.kind !== "video") continue;
        try {
          const params = sender.getParameters();
          params.degradationPreference = window.BoxxieQuality.preference(q, p.displayHeight);
          const height = sender.track.getSettings?.().height || filmVideo.videoHeight || q.height;
          for (const encoding of params.encodings || []) {
            encoding.maxBitrate = q.maxBitrate;
            encoding.scaleResolutionDownBy = Math.max(1, height / q.height);
          }
          await sender.setParameters(params);
        } catch {} // Browsers that reject live changes retain negotiated limits.
      }
    }).catch(() => {});
  }
  function syncFilm(p) {
    if (!S.filmStream) return;
    const tracks = S.filmStream.getTracks();
    p.signal({ kinds: { [S.filmStream.id]: "film" } });
    for (const t of tracks) {
      if (p.filmSenders.has(t.id)) continue;
      if (t.kind === "video") t.contentHint = "motion";
      const Q = window.BoxxieQuality.limits(quality(), p.displayHeight);
      // Never send more than the chosen quality (a 4K film in HD mode is scaled to 1080p).
      const srcHeight = (t.getSettings && t.getSettings().height) || filmVideo.videoHeight || Q.height;
      const scale = srcHeight > Q.height ? srcHeight / Q.height : 1;
      const tx = p.pc.addTransceiver(t, {
        direction: "sendonly",
        streams: [S.filmStream],
        sendEncodings: t.kind === "video"
          ? [{ maxBitrate: Q.maxBitrate, maxFramerate: 30, scaleResolutionDownBy: scale }]
          : [{ maxBitrate: 256000 }],
      });
      p.filmSenders.set(t.id, tx.sender);
      if (t.kind === "video") {
        preferCodecs(tx);
        try {
          const params = tx.sender.getParameters();
          params.degradationPreference = window.BoxxieQuality.preference(Q, p.displayHeight);
          tx.sender.setParameters(params).catch(() => {});
        } catch {}
      }
    }
    const live = new Set(tracks.map((t) => t.id));
    for (const [id, sender] of p.filmSenders) {
      if (!live.has(id)) {
        try { p.pc.removeTrack(sender); } catch {}
        p.filmSenders.delete(id);
      }
    }
  }
  // Android TVs, Fire TV and phones only have hardware video encoding for H.264, so prefer it
  // there; software encoding a 4K picture would overheat the stick. Elsewhere, browser defaults.
  const preferH264 = /Android|AFT|BoxxieShare/i.test(navigator.userAgent);
  function preferCodecs(tx) {
    try {
      if (!preferH264 || !tx.setCodecPreferences || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
      const caps = RTCRtpReceiver.getCapabilities("video").codecs;
      const rank = (c) => (c.mimeType.toLowerCase() === "video/h264" ? 0 : 1);
      tx.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
    } catch {}
  }
  function syncFilmToAll() {
    if (S.role !== "host") return;
    for (const p of S.peers.values()) if (!S.companionOf.has(p.id)) syncFilm(p);
  }

  // Viewer: show the film
  let viewerPlayPending = null;
  function resumeViewerPlayback() {
    const view = S.filmView;
    if (S.role !== "viewer" || S.closing || document.visibilityState !== "visible" ||
        !view || filmVideo.srcObject !== view || !filmVideo.paused ||
        !view.getTracks().some(t => t.readyState === "live") || viewerPlayPending === view) return;
    viewerPlayPending = view;
    Promise.resolve().then(() => {
      if (filmVideo.srcObject === view && S.role === "viewer" && !S.closing) return filmVideo.play();
    }).catch(() => {
      if (filmVideo.srcObject === view && !S.closing) $("sound-on").hidden = false;
    }).finally(() => {
      if (viewerPlayPending === view) viewerPlayPending = null;
    });
  }
  // A returning stream reuses its tracks, so ontrack alone cannot restart an
  // element that the browser suspended during a source gap or backgrounding.
  filmVideo.addEventListener("pause", () => setTimeout(resumeViewerPlayback, 0));
  document.addEventListener("visibilitychange", resumeViewerPlayback);
  window.addEventListener("pageshow", resumeViewerPlayback);
  // Viewer: the film's picture and sound can arrive in separate streams (and change when the
  // host switches film or screen), so always play the newest picture + newest sound together.
  function attachFilm(stream, track) {
    // WebKit can leave the element attached to an inactive stream after a restart,
    // even when replacement tracks are added to that same stream. Bind a fresh
    // stream and retain only live tracks of the other kind (audio/video may arrive separately).
    const previous = S.filmView;
    const view = new MediaStream(previous ? previous.getTracks().filter(
      (t) => t.kind !== track.kind && t.readyState === "live"
    ) : []);
    view.addTrack(track);
    S.filmView = view;
    const showState = () => {
      const live = S.filmView && S.filmView.getVideoTracks().some((t) => t.readyState === "live");
      $("stage-empty").hidden = live;
      if (!live) $("stage-empty-text").textContent = "The host has paused sharing. Stay here and it'll come back.";
    };
    if (!stream._watched) {
      stream._watched = true;
      stream.addEventListener("removetrack", (ev) => {
        if (S.filmView && S.filmView.getTracks().includes(ev.track)) S.filmView.removeTrack(ev.track);
        showState();
      });
    }
    track.addEventListener("ended", () => {
      if (S.filmView && S.filmView.getTracks().includes(track)) S.filmView.removeTrack(track);
      showState();
    });
    track.addEventListener("unmute", () => {
      if (S.filmView && S.filmView.getTracks().includes(track)) {
        showState();
        resumeViewerPlayback();
      }
    });
    filmVideo.srcObject = view;
    showState();
    filmVideo.muted = $("sound-on").hidden ? false : filmVideo.muted;
    const p = filmVideo.play();
    if (p && p.catch) {
      p.catch(() => {
        // A newer track may have replaced this stream while play() was pending.
        if (filmVideo.srcObject !== view) return;
        // Browsers block sound until you tap. Start silently and offer a button.
        filmVideo.muted = true;
        filmVideo.play().catch(() => {});
        $("sound-on").hidden = false;
        if (isTV) $("sound-on").focus();
      });
    }
  }
  function qualityName(h) {
    return h >= 2000 ? "4K" : h >= 1400 ? "1440p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h ? h + "p" : "";
  }
  function receiverDisplayHeight() {
    return window.BoxxieQuality.displayHeight({
      width: Math.max(innerWidth, screen.width || 0),
      height: Math.max(innerHeight, screen.height || 0),
      tv: isTV, mode: $("viewer-display").value,
    });
  }
  function requestDisplayQuality() {
    if (S.role !== "viewer" || S.companion) return;
    const displayHeight = receiverDisplayHeight();
    if (screenPeers.has("host")) {
      const sp = screenPeers.get("host");
      send({ type: "signal", to: "host", data: { ch: "screen", session: sp.session, displayHeight } });
    } else if (S.peers.has("host")) {
      S.peers.get("host").signal({ displayOnly: true, displayHeight });
    }
  }
  $("viewer-display").value = store.get("displayMode") === "tv" ? "tv" : "auto";
  $("viewer-display").addEventListener("change", () => {
    store.set("displayMode", $("viewer-display").value);
    requestDisplayQuality();
    toast("Display preference sent. Quality still depends on the host and connection.");
  });
  let displayResizeTimer;
  addEventListener("resize", () => {
    clearTimeout(displayResizeTimer);
    displayResizeTimer = setTimeout(requestDisplayQuality, 300);
  });
  document.addEventListener("fullscreenchange", requestDisplayQuality);
  filmVideo.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
    if (filmVideo.webkitCurrentPlaybackTargetIsWireless) {
      $("viewer-display").value = "tv";
      requestDisplayQuality();
    }
  });
  function updateViewerQuality() {
    if (S.role !== "viewer") return;
    const q = qualityName(filmVideo.videoHeight);
    $("viewer-status").textContent = q ? `Live from the host · receiving ${q}` : "Live from the host";
  }
  filmVideo.addEventListener("resize", () => {
    updateViewerQuality();
    if (S.role === "host" && S.source === "screen" && filmVideo.videoHeight) {
      $("screen-status").dataset.q = qualityName(filmVideo.videoHeight);
    }
  });
  $("sound-on").onclick = async () => {
    filmVideo.muted = false;
    try {
      await filmVideo.play();
      $("sound-on").hidden = !filmVideo.muted && !filmVideo.paused;
    } catch {
      // A failed play request must leave a way to retry on phones, browsers and TVs.
      $("sound-on").hidden = false;
      toast("Sound couldn't start. Press Turn sound on to try again.");
    }
  };

  // ---------------- video call ----------------
  function addCam(p) {
    if (!S.camStream) return;
    p.signal({ kinds: { [S.camStream.id]: "cam" } });
    // Always a fresh channel: addTrack() would reuse the incoming film channel, which the
    // other side has marked send-only, and the camera would never arrive.
    p.camSenders = S.camStream.getTracks().map(
      (t) => p.pc.addTransceiver(t, { direction: "sendonly", streams: [S.camStream] }).sender
    );
  }
  function removeCam(p) {
    for (const s of p.camSenders) {
      try { p.pc.removeTrack(s); } catch {}
    }
    p.camSenders = [];
    p.signal({ camOff: true });
  }

  $("call-toggle").onclick = () => (S.inCall ? leaveCall() : startCall());
  async function startCall() {
    if (S.inCall) return;
    const btn = $("call-toggle");
    btn.disabled = true;
    try {
      S.camStream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS).catch(async (e) => {
        // No camera (common on TVs)? Try voice only.
        if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) {
          toast("No camera found, joining with voice only");
          return navigator.mediaDevices.getUserMedia({ audio: CAM_CONSTRAINTS.audio });
        }
        throw e;
      });
      S.inCall = true;
      showCamTile("me", S.myName, S.camStream, true);
      for (const p of S.peers.values()) addCam(p);
      setLabel(btn, "Leave call");
      btn.setAttribute("aria-pressed", "true");
      $("mic-toggle").hidden = false;
      $("cam-toggle").hidden = !S.camStream.getVideoTracks().length;
    } catch (e) {
      const msg = e && e.name === "NotAllowedError"
        ? "Camera and microphone are blocked. Allow them in your browser or device settings, then try again."
        : "Couldn't start your camera or microphone on this device.";
      toast(msg, 6000);
    } finally {
      btn.disabled = false;
    }
  }
  function leaveCall() {
    for (const p of S.peers.values()) removeCam(p);
    if (S.camStream) S.camStream.getTracks().forEach((t) => t.stop());
    S.camStream = null;
    S.inCall = false;
    removeCamTile("me");
    setLabel($("call-toggle"), "Join video call");
    $("call-toggle").setAttribute("aria-pressed", "false");
    $("mic-toggle").hidden = true;
    $("cam-toggle").hidden = true;
  }
  $("mic-toggle").onclick = () => {
    const t = S.camStream && S.camStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setLabel($("mic-toggle"), t.enabled ? "Mute" : "Unmute");
    $("mic-toggle").title = t.enabled ? "Mute" : "Unmute";
    $("mic-toggle").setAttribute("aria-pressed", String(!t.enabled));
  };
  $("cam-toggle").onclick = () => {
    const t = S.camStream && S.camStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setLabel($("cam-toggle"), t.enabled ? "Camera off" : "Camera on");
    $("cam-toggle").title = t.enabled ? "Camera off" : "Camera on";
    $("cam-toggle").setAttribute("aria-pressed", String(!t.enabled));
  };

  function showCamTile(id, name, stream, isMe) {
    let tile = document.querySelector(`.cam[data-id="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "cam" + (isMe ? " me" : "");
      tile.dataset.id = id;
      const v = document.createElement("video");
      v.poster = BLANK_POSTER; // Android's default poster is a big grey play button
      v.autoplay = true;
      v.playsInline = true;
      v.muted = isMe || S.phonePaired; // never play your own mic back; a paired phone plays the call instead
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = isMe ? "You" : name;
      tile.append(v, label);
      if (isMe) camBox().prepend(tile);
      else camBox().append(tile);
    }
    const v = tile.querySelector("video");
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
  }
  // When a phone handles this TV's call, the TV stays silent for the call so there's no echo.
  function setPhonePaired(on) {
    if (S.companion) return;
    S.phonePaired = !!on;
    document.querySelectorAll(".cam:not(.me) video").forEach((v) => (v.muted = S.phonePaired));
    const btn = $("pair-phone");
    const tvOnly = isTV || !canCall;
    if (on) {
      setLabel(btn, "Phone connected");
      btn.classList.remove("primary");
      $("pair-panel").hidden = true;
    } else {
      setLabel(btn, tvOnly ? "Use your phone for the video call" : "Use phone");
      btn.classList.toggle("primary", tvOnly);
    }
  }
  $("pair-phone").onclick = () => {
    if (S.phonePaired) return toast("Your phone is connected. To stop, leave the room on the phone.");
    send({ type: "companion-code" });
  };
  $("pair-close").onclick = () => {
    $("pair-panel").hidden = true;
    $("pair-phone").focus();
  };
  function showPairing(pin) {
    const code = `${S.code.slice(0, 4)}-${S.code.slice(4)}-${pin}`;
    const link = `${location.origin}${location.pathname}#call=${S.code}-${pin}`;
    const box = $("pair-qr");
    box.replaceChildren();
    try {
      box.append(window.BoxxieQR.svg(link, { size: 200, dark: "#142130", light: "#ffffff" }));
    } catch {}
    $("pair-code").textContent = code;
    $("pair-site").textContent = location.host + location.pathname.replace(/\/$/, "");
    $("pair-panel").hidden = false;
    $("pair-close").focus();
  }
  function removeCamTile(id) {
    document.querySelector(`.cam[data-id="${CSS.escape(id)}"]`)?.remove();
  }

  // ---------------- host playback controls ----------------
  function updatePlayButton() {
    const btn = $("ctl-play");
    const label = filmVideo.paused ? "Play" : "Pause";
    btn.querySelector("use").setAttribute("href", filmVideo.paused ? "#i-play" : "#i-pause");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    showControls();
  }
  $("ctl-play").onclick = () => {
    if (filmVideo.paused) {
      filmVideo.play().catch(() => toast("Press play again to start the film"));
    } else filmVideo.pause();
  };
  $("ctl-back").onclick = () => (filmVideo.currentTime = Math.max(0, filmVideo.currentTime - 10));
  $("ctl-fwd").onclick = () => (filmVideo.currentTime = Math.min(filmVideo.duration || 0, filmVideo.currentTime + 30));
  $("ctl-change").onclick = () => $("film-file").click();
  $("ctl-seek").addEventListener("input", (e) => {
    if (filmVideo.duration) filmVideo.currentTime = (e.target.value / 1000) * filmVideo.duration;
  });
  filmVideo.addEventListener("play", updatePlayButton);
  filmVideo.addEventListener("pause", updatePlayButton);
  filmVideo.addEventListener("timeupdate", () => {
    if (S.role !== "host") return;
    $("ctl-time").textContent = `${fmtTime(filmVideo.currentTime)} / ${fmtTime(filmVideo.duration)}`;
    if (document.activeElement !== $("ctl-seek") && filmVideo.duration) {
      $("ctl-seek").value = Math.round((filmVideo.currentTime / filmVideo.duration) * 1000);
      $("ctl-seek").style.setProperty("--pct", `${(filmVideo.currentTime / filmVideo.duration) * 100}%`);
    }
  });
  filmVideo.addEventListener("ended", () => {
    if (S.role !== "host" || S.source === "screen") return;
    send({ type: "chat", text: "The film has finished 🎬" });
    autoEnd("finished");
  });
  // Playing again (or sharing something new) cancels the countdown
  filmVideo.addEventListener("playing", () => S.role === "host" && S.endingWhy && autoEnd(null));

  // Remote-control media keys work anywhere in the room
  document.addEventListener("keydown", (e) => {
    if (S.role !== "host" || S.source === "screen" || $("screen-room").hidden || isTyping()) return;
    if (e.key === "MediaPlayPause" || (e.key === " " && document.activeElement === document.body)) {
      e.preventDefault();
      $("ctl-play").click();
    } else if (e.key === "MediaPlay") filmVideo.play();
    else if (e.key === "MediaPause") filmVideo.pause();
    else if (e.key === "MediaRewind") $("ctl-back").click();
    else if (e.key === "MediaFastForward") $("ctl-fwd").click();
  });

  // ----- Player controls float over the picture and fade away while it plays (like Plex) -----
  let hideTimer;
  function showControls() {
    const stage = $("stage");
    const room = $("screen-room");
    stage.classList.add("show-controls");
    room.classList.add("show-controls");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const inBar = (stage.querySelector(".bottom-overlay").contains(document.activeElement) || $("dock").contains(document.activeElement)) && isTV;
      const playing = filmVideo.srcObject || !filmVideo.paused;
      const sheetOpen = document.querySelector(".sheet:not([hidden])");
      if (playing && !inBar && !sheetOpen && !room.hidden) {
        stage.classList.remove("show-controls");
        room.classList.remove("show-controls");
      }
    }, 3500);
  }
  ["mousemove", "pointerdown", "touchstart"].forEach((ev) => $("stage").addEventListener(ev, showControls, { passive: true }));
  document.addEventListener("keydown", () => !$("screen-room").hidden && showControls());
  $("stage").addEventListener("focusin", showControls);
  ["mousemove", "pointerdown", "touchstart"].forEach((ev) => $("dock").addEventListener(ev, showControls, { passive: true }));
  $("dock").addEventListener("focusin", showControls);

  // ----- The drawer (chat, people, call) and the faces that stay on the film when it's closed -----
  const wideMQ = matchMedia("(min-width: 861px)");
  function sideShowing() {
    const room = $("screen-room");
    return !room.hidden && (S.companion || !wideMQ.matches || !room.classList.contains("side-hidden"));
  }
  function camBox() {
    return sideShowing() ? $("cams") : $("faces");
  }
  function placeCams() {
    const to = camBox();
    const from = to === $("cams") ? $("faces") : $("cams");
    const tiles = [...from.children];
    if (!tiles.length) return;
    tiles.forEach((t) => to.append(t));
    to.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
  }
  function setSide(open) {
    const room = $("screen-room");
    room.classList.toggle("side-hidden", !open);
    const b = $("toggle-side");
    b.setAttribute("aria-expanded", String(open));
    b.title = open ? "Hide chat" : "Show chat";
    setLabel(b, open ? "Hide chat" : "Chat");
    b.classList.toggle("on", open);
    if (open) $("chat-unread").hidden = true;
    placeCams();
  }
  $("toggle-side").onclick = () => setSide($("screen-room").classList.contains("side-hidden"));
  wideMQ.addEventListener ? wideMQ.addEventListener("change", placeCams) : wideMQ.addListener(placeCams);

  // Faces on the big screen: corner, mini or off. A paired phone sets it for its TV.
  S.faces = store.get("faces") || "corner";
  function renderFaces() {
    const f = $("faces");
    f.className = `faces faces-${S.faces}`;
    document.querySelectorAll("#faces-mode [data-faces]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.faces === S.faces)));
  }
  function setFaces(mode) {
    if (!["corner", "mini", "off"].includes(mode)) return;
    S.faces = mode;
    store.set("faces", mode);
    renderFaces();
  }
  document.querySelectorAll("#faces-mode [data-faces]").forEach((b) => (b.onclick = () => {
    setFaces(b.dataset.faces);
    if (S.companion) send({ type: "remote", action: "faces:" + b.dataset.faces });
  }));
  renderFaces();

  // The paired phone as a remote
  $("remote-play").onclick = () => send({ type: "remote", action: "play" });
  $("remote-back").onclick = () => send({ type: "remote", action: "back" });
  $("remote-fwd").onclick = () => send({ type: "remote", action: "fwd" });
  function applyRemote(action, by) {
    if (typeof action !== "string") return;
    if (action.startsWith("faces:")) return setFaces(action.slice(6));
    if (S.role !== "host") return;
    // A friend pressed pause/play: it happens for everyone
    if (by && (action === "pause" || action === "play")) {
      toast(`${by} pressed ${action}`);
      if (S.source === "screen") {
        if (S.nativeSharing && typeof NATIVE.mediaKey === "function") try { NATIVE.mediaKey(action === "pause" ? "pause" : "playonly"); } catch {}
        return;
      }
      if (action === "pause") filmVideo.pause();
      else filmVideo.play().catch(() => {});
      return;
    }
    if (S.source === "screen") {
      // The paired phone's remote: ⏯ goes to whatever app is playing on the TV
      if (action === "play" && S.nativeSharing && typeof NATIVE.mediaKey === "function") try { NATIVE.mediaKey("playpause"); } catch {}
      return;
    }
    showControls();
    if (action === "play") $("ctl-play").click();
    else if (action === "back") $("ctl-back").click();
    else if (action === "fwd") $("ctl-fwd").click();
  }
  $("code-pill").onclick = () => $("share-open").click();

  // ----- Apple TV: Screen Mirroring from an iPhone, iPad or Mac (tvOS has no web browser) -----
  $("airplay-open").onclick = () => {
    $("airplay-pick").hidden = !filmVideo.webkitShowPlaybackTargetPicker;
    $("airplay-panel").hidden = false;
    $("airplay-full").focus();
  };
  $("airplay-close").onclick = () => ($("airplay-panel").hidden = true);
  $("airplay-full").onclick = () => {
    $("airplay-panel").hidden = true;
    $("ctl-full").click();
  };
  $("airplay-pick").onclick = () => {
    try { filmVideo.webkitShowPlaybackTargetPicker(); } catch { toast("Use Screen Mirroring in Control Center instead."); }
  };

  // Chat pops up briefly on the film while the drawer is closed
  function chatToast(m) {
    if (sideShowing()) return;
    const box = $("chat-toasts");
    const li = document.createElement("li");
    if (m.system) li.className = "system";
    else {
      const who = document.createElement("b");
      who.textContent = m.name;
      li.append(who, document.createTextNode(" " + m.text));
    }
    if (m.system) li.textContent = m.text;
    box.append(li);
    while (box.children.length > (isTV ? 2 : 3)) box.firstChild.remove();
    setTimeout(() => li.classList.add("gone"), 6000);
    setTimeout(() => li.remove(), 6600);
    if (!m.system) $("chat-unread").hidden = false;
  }
  $("ctl-full").onclick = () => {
    const stage = $("stage");
    if (document.fullscreenElement) return document.exitFullscreen();
    const room = $("screen-room");
    if (room.requestFullscreen) room.requestFullscreen().catch(() => {});
    else if (filmVideo.webkitEnterFullscreen) filmVideo.webkitEnterFullscreen(); // iPhone
  };

  // ---------------- the room closes itself when the film is over ----------------
  // Film or audio ends: everyone gets a 1-minute countdown. Host stops sharing: 10 minutes.
  // The host (or their paired phone) can keep the room open or close it straight away.
  const AUTO_END = Object.assign({ finished: 60 * 1000, idle: 10 * 60 * 1000, quiet: 2 * 60 * 1000 }, window.__boxxieAutoEnd || {}); // tests shorten these
  let endTimer = null;
  function autoEnd(why) {
    if (S.role !== "host") return;
    send(why ? { type: "auto-end", after: AUTO_END[why], why } : { type: "auto-end", after: null });
  }
  const canControlRoom = () => S.role === "host" || (S.companion && S.companionOwner === "host");
  function showEnding(ms, why) {
    clearInterval(endTimer);
    S.endingWhy = ms == null ? null : why;
    const card = $("end-card");
    if (ms == null) {
      card.hidden = true;
      return;
    }
    const until = Date.now() + ms;
    const ctrl = canControlRoom();
    $("end-title").textContent = why === "idle" ? "Sharing has stopped" : why === "quiet" ? "Nothing's playing on the TV" : "The film has finished";
    $("end-keep").hidden = !ctrl;
    $("end-now").hidden = !ctrl;
    $("end-leave").hidden = ctrl;
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $("end-count").textContent = fmtTime(left);
      $("end-text").firstChild.textContent = why === "idle" && S.role === "host" ? "Share again, or the room closes in " : "Everyone leaves the room in ";
    };
    tick();
    endTimer = setInterval(tick, 500);
    // On the host's own screen, don't cover the film-idle controls: the card sits over the empty stage.
    card.hidden = false;
    if (isTV || !document.activeElement || document.activeElement === document.body) (ctrl ? $("end-keep") : $("end-leave")).focus();
  }
  $("end-keep").onclick = () => {
    send({ type: "auto-end", after: null });
    $("end-card").hidden = true;
  };
  $("end-now").onclick = () => send({ type: "end" });
  $("end-leave").onclick = () => leave();

  // Friends: pause or play the film for everyone
  let askedPause = false;
  $("ask-pause").onclick = () => {
    askedPause = !askedPause;
    send({ type: "remote", action: askedPause ? "pause" : "play" });
    setLabel($("ask-pause"), askedPause ? "Play for everyone" : "Pause for everyone");
    $("ask-pause").title = askedPause ? "Play for everyone" : "Pause for everyone";
  };

  // Host: People button opens the list where you can remove, block or report anyone
  $("people-open").onclick = () => {
    if (!sideShowing()) $("toggle-side").click();
    setTimeout(() => {
      const c = [...document.querySelectorAll("#people-list button.chip")][0];
      if (c) c.focus();
      else toast("No one else is in the room yet.");
    }, 120);
  };

  // ---------------- leaving ----------------
  $("leave").onclick = () => {
    if (S.role === "host") {
      if (!confirm("End the room for everyone?")) return;
      send({ type: "end" });
    }
    leave();
  };

  function cleanup() {
    S.closing = true;
    health.clear();
    localAudioHealth = null;
    $("diagnostics-report").hidden = true;
    clearTimeout(hostAwayTimer);
    screenRestartAt.clear();
    connectionEpoch++;
    connectionPending = false;
    clearTimeout(S.rejoinTimer);
    S.rejoinSince = null;
    clearInterval(endTimer);
    S.endingWhy = null;
    $("end-card").hidden = true;
    clearInterval(S.pingTimer);
    for (const id of [...S.peers.keys()]) closePeer(id);
    for (const id of [...screenPeers.keys()]) closeScreenPeer(id);
    if (S.native) {
      try { NATIVE.stopScreenShare(); } catch {}
      S.native = false;
      S.nativeSharing = false;
      setLabel($("ctl-reshare"), "Share something else");
    }
    if (S.camStream) S.camStream.getTracks().forEach((t) => t.stop());
    S.camStream = null;
    S.inCall = false;
    setLabel($("call-toggle"), "Join video call");
    $("call-toggle").setAttribute("aria-pressed", "false");
    $("mic-toggle").hidden = true;
    $("cam-toggle").hidden = true;
    try { S.ws && S.ws.close(1000); } catch {}
    S.ws = null;
    banner("");
    $("sound-on").hidden = true;
    if (S.role === "viewer") {
      filmVideo.srcObject = null;
      S.filmView = null;
    } else {
      filmVideo.pause();
      if (S.filmStream && S.filmStream._screen) {
        S.filmStream.getTracks().forEach((t) => t.stop());
        filmVideo.srcObject = null;
        S.filmStream = null;
      }
    }
    try { S.wakeLock && S.wakeLock.release(); } catch {}
    S.wakeLock = null;
  }
  function leave() {
    if (S.role === "viewer" && S.code) $("join-code").value = formatCode(S.code);
    forgetViewerRoom();
    forgetTVRoom();
    cleanup();
    $("invite-panel").hidden = true;
    S.role = null;
    S.companion = false;
    S.phonePaired = false;
    S.companionOf.clear();
    show("home");
  }
  function endWithMessage(title, text) {
    cleanup();
    $("waiting-title").textContent = title;
    $("waiting-text").textContent = text;
    $("waiting-cancel").textContent = "Back to start";
    document.querySelector("#screen-waiting .pulse").hidden = true;
    show("waiting");
    $("waiting-cancel").onclick = () => {
      document.querySelector("#screen-waiting .pulse").hidden = false;
      $("waiting-cancel").textContent = "Cancel";
      $("waiting-cancel").onclick = () => leave();
      leave();
    };
  }

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator) S.wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.ws && !S.wakeLock) keepAwake();
  });

  // ---------------- TV remote: arrow-key navigation ----------------
  function isTyping() {
    const a = document.activeElement;
    return a && ((a.tagName === "INPUT" && !["range", "file", "button"].includes(a.type)) || a.tagName === "TEXTAREA");
  }
  function focusables() {
    // An open app list keeps the remote inside it; switched-off (inert) parts are skipped.
    const scope = !$("apps-panel").hidden ? $("apps-panel") : document;
    return [...scope.querySelectorAll("button, input, select, .file-pick, [tabindex='0']")].filter((el) => {
      if (el.disabled || el.classList.contains("visually-hidden") || el.closest("[inert]")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest("[hidden]");
    });
  }
  document.addEventListener("keydown", (e) => {
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = dirs[e.key];
    if (!d || e.defaultPrevented) return;
    const a = document.activeElement;
    // Let text boxes and sliders keep left/right for themselves.
    if (a && (isTyping() || a.type === "range") && d[0] !== 0) return;
    const from = a && a !== document.body ? a.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
    let best = null, bestScore = Infinity;
    for (const el of focusables()) {
      if (el === a) continue;
      const r = el.getBoundingClientRect();
      // Distance along the arrow's direction, edge to edge.
      const along = d[1] > 0 ? r.top - from.bottom : d[1] < 0 ? from.top - r.bottom : d[0] > 0 ? r.left - from.right : from.left - r.right;
      if (along < -4) continue;
      // Sideways gap (0 when the two overlap, e.g. a wide box under a small button).
      const across = d[1] !== 0 ? Math.max(0, r.left - from.right, from.left - r.right) : Math.max(0, r.top - from.bottom, from.top - r.bottom);
      const score = Math.max(0, along) + across * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      e.preventDefault();
      best.focus();
      best.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });

  // The TV/phone app asks this when Back is pressed. Returning true means "handled".
  window.boxxieBack = () => {
    const current = document.querySelector(".screen:not([hidden])");
    const name = current && current.dataset.screen;
    if (!name || name === "home") return false;
    if (name === "room") {
      // Back closes an open panel first (app list, invite, etc.)
      if (!$("apps-panel").hidden) {
        $("apps-close").click();
        return true;
      }
      const sheet = [...document.querySelectorAll("#screen-room .sheet")].find((x) => !x.hidden);
      if (sheet) {
        sheet.hidden = true;
        return true;
      }
      if (S.role === "host") $("leave").click(); // asks "End the room for everyone?"
      else if (confirm("Leave the room?")) leave();
      return true;
    }
    if (name === "waiting") {
      $("waiting-cancel").click();
      return true;
    }
    if (name === "signin") return false;
    show(S.session ? "home" : "signin");
    return true;
  };

  // ---------------- start-up ----------------
  async function boot() {
    const hash = location.hash;
    if (hash) history.replaceState(null, "", location.pathname);
    // Coming back from Google/Facebook, or from the emailed link
    const login = hash.match(/login=([0-9a-f]{48})/);
    const magic = hash.match(/magic=([0-9a-f]{48})/);
    const loginErr = hash.match(/login_error=([a-z_]+)/);
    // Links that need you signed in first
    const c = hash.match(/call=([A-Za-z0-9]{8})-?(\d{6})/);
    const d = hash.match(/device=([A-Za-z0-9]{8})/);
    const m = hash.match(/join=([A-Za-z0-9-]+)/);
    if (c) S.after = { pair: [c[1].toUpperCase(), c[2]] };
    else if (d) S.after = { device: d[1].toUpperCase() };
    else if (m) S.after = { join: cleanCode(m[1]) };
    try { S.after = S.after || JSON.parse(sessionStorage.getItem("bx:after") || "null"); } catch {}
    try { sessionStorage.removeItem("bx:after"); } catch {}

    if (login || magic) {
      const r = login
        ? await api("/auth/exchange", { method: "POST", body: { code: login[1] } })
        : await api("/auth/email/verify", { method: "POST", body: { token: magic[1] } });
      if (r.ok && r.data.token) return setSession(r.data);
      return showSignin("That sign-in link has expired. Please try again.");
    }
    if (S.session) {
      const r = await api("/api/me");
      if (r.ok) return afterSignIn();
      if (r.status === 0) return afterSignIn(); // offline: keep the session, try later
      return; // 401 already sent them to sign in
    }
    // Remember where they were heading while they go off to Google/Facebook
    if (S.after) try { sessionStorage.setItem("bx:after", JSON.stringify(S.after)); } catch {}
    showSignin(loginErr ? (loginErr[1] === "cancelled" ? "Sign-in was cancelled." : "Sign-in didn't work. Please try again.") : "");
  }
  window.addEventListener("beforeunload", (e) => {
    if (S.role === "host" && S.ws) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
