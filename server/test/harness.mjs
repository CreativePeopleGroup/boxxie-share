// In-memory stand-in for the Cloudflare Workers runtime, so the real server code
// can be tested without network access. Run:  node --import ./test/register.mjs test/harness.mjs
import worker, { Room, Limiter, Directory } from "../src/index.js";

// ---- Response that allows status 101 (WebSocket upgrade) ----
const BaseResponse = globalThis.Response;
globalThis.Response = class extends BaseResponse {
  constructor(body, init = {}) {
    if (init.status === 101) {
      super(null, { status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

// ---- Durable Object plumbing ----
class Storage {
  constructor(owner) {
    this.map = new Map();
    this.owner = owner;
    this.alarmAt = null;
  }
  async get(k) {
    const v = this.map.get(k);
    return v === undefined ? undefined : structuredClone(v);
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
    this.alarmAt = null;
  }
  async setAlarm(t) {
    this.alarmAt = t;
  }
}

function namespace(Cls, env) {
  const objects = new Map();
  return {
    idFromName: (n) => n,
    get(id) {
      if (!objects.has(id)) {
        const sockets = [];
        const ctx = {
          storage: null,
          acceptWebSocket: (ws, tags = []) => {
            ws._do = obj;
            ws._tags = tags;
            sockets.push(ws);
          },
          getWebSockets: (tag) => sockets.filter((s) => !s._closed && (!tag || (s._tags || []).includes(tag))),
        };
        const obj = new Cls(ctx, env);
        ctx.storage = new Storage(obj);
        obj._ctx = ctx;
        objects.set(id, obj);
      }
      return objects.get(id);
    },
    objects,
  };
}

// ---- WebSocketPair ----
class End {
  constructor() {
    this._closed = false;
    this._attachment = null;
    this.listeners = { message: [], close: [] };
  }
  accept() {}
  serializeAttachment(a) {
    this._attachment = structuredClone(a);
  }
  deserializeAttachment() {
    return this._attachment ? structuredClone(this._attachment) : null;
  }
  send(data) {
    if (this._closed) throw new Error("closed");
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer._isServer) peer._do?.webSocketMessage(peer, data);
      else if (peer.listeners.message.length) peer.listeners.message.forEach((f) => f(data));
      else (peer._buffer ||= []).push(data);
    });
  }
  close(code, reason) {
    if (this._closed) return;
    this._closed = true;
    const peer = this.peer;
    queueMicrotask(() => {
      peer._closed = true;
      if (peer._isServer) peer._do?.webSocketClose(peer, code, reason, true);
      else peer.listeners.close.forEach((f) => f(code, reason));
    });
  }
}
globalThis.WebSocketPair = class {
  constructor() {
    const client = new End();
    const server = new End();
    server._isServer = true;
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
};

// ---- env + request helpers ----
const env = {
  ALLOWED_ORIGINS: "https://friends.example",
  DEV: "1",
  EMAIL_PROVIDER: "log",
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
  FACEBOOK_APP_ID: "fbid", FACEBOOK_APP_SECRET: "fbsecret",
  DEV_GOOGLE_TOKEN: "https://mock.google/token", DEV_GOOGLE_USER: "https://mock.google/user",
  DEV_FB_TOKEN: "https://mock.fb/token", DEV_FB_USER: "https://mock.fb/me",
};
env.ROOM = namespace(Room, env);
env.LIMITER = namespace(Limiter, env);
env.DIRECTORY = namespace(Directory, env);
const ORIGIN = { Origin: "https://friends.example", "CF-Connecting-IP": "203.0.113.5" };
const DIR = env.DIRECTORY.get("directory");

// Signed-in test people (made the same way a Google sign-in makes them)
const TOKENS = {};
async function tokenFor(name) {
  if (!TOKENS[name]) {
    const code = await DIR.finishOAuth({ provider: "google", subject: "sub-" + name, email: name.toLowerCase() + "@example.com", name });
    TOKENS[name] = (await DIR.exchange(code, "test")).token;
  }
  return TOKENS[name];
}

async function call(path, init = {}) {
  const headers = { ...ORIGIN, ...(init.headers || {}) };
  if (!("Authorization" in headers)) headers.Authorization = "Bearer " + (await tokenFor("Ricky"));
  if (headers.Authorization === null) delete headers.Authorization;
  return worker.fetch(new Request("https://server.test" + path, { ...init, headers }), env);
}
async function ticketFor(name) {
  const r = await call("/api/ticket", { method: "POST", headers: { Authorization: "Bearer " + (await tokenFor(name)) } });
  return (await r.json()).ticket;
}

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const type = (t) => (m) => m.type === t;

// Joins as the person named in the path (?name=…), the host (Ricky) otherwise, or `as`.
async function connect(path, extraHeaders = {}, as) {
  const m = path.match(/[?&]name=([^&]+)/);
  const who = as || (m ? decodeURIComponent(m[1]) : "Ricky");
  if (who !== "nobody") path += (path.includes("?") ? "&" : "?") + "ticket=" + (await ticketFor(who));
  const res = await call(path, { headers: { Upgrade: "websocket", ...extraHeaders } });
  if (res.status !== 101) throw new Error("HTTP " + res.status);
  const ws = res.webSocket;
  await new Promise((r) => setTimeout(r, 0));
  const first = ws._buffer && ws._buffer[0] && JSON.parse(ws._buffer[0]);
  if (first && first.type === "refused") throw new Error(first.error);
  const inbox = [];
  const waiters = [];
  ws.listeners.message.push((d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  for (const d of ws._buffer || []) ws.listeners.message[0](d);
  ws._buffer = [];
  ws.next = (pred, ms = 1000) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  ws.sendJ = (m) => ws.send(JSON.stringify(m));
  return ws;
}

// ================= scenario =================

// Origin check
const bad = await worker.fetch(
  new Request("https://server.test/api/rooms", { method: "POST", headers: { Origin: "https://evil.example" } }),
  env
);
ok(bad.status === 403, "requests from unknown websites are refused");

const r = await call("/api/rooms", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hostName: "Ricky", maxViewers: 2 }),
});
const room = await r.json();
ok(r.status === 201 && /^[A-HJKMNP-Z2-9]{8}$/.test(room.code) && room.hostToken.length === 64, `room created (${room.code})`);
const stored = await env.ROOM.get(room.code)._ctx.storage.get("meta");
ok(stored.hostHash !== room.hostToken && stored.hostHash.length === 64, "host secret stored only as a hash");

try {
  await connect(`/api/rooms/${room.code}/ws?role=host&token=nope`);
  ok(false, "fake host refused");
} catch (e) {
  ok(/not_host/.test(e.message), "fake host refused");
}

const host = await connect(`/api/rooms/${room.code}/ws?role=host&token=${room.hostToken}`);
const welcome = await host.next(type("welcome"));
ok(Array.isArray(welcome.iceServers), "host welcomed with ICE servers");

const v1 = await connect(`/api/rooms/${room.code.toLowerCase().slice(0, 4)}-${room.code.slice(4)}/ws?role=viewer&name=Sarah`);
const waiting = await v1.next(type("waiting"));
ok(!!waiting.id, "viewer held in waiting room (code typed lower-case with dash)");
const req = await host.next(type("join-request"));
ok(req.name === "Sarah", "host sees join request");

v1.sendJ({ type: "chat", text: "sneaky" });
v1.sendJ({ type: "signal", to: "host", data: { x: 1 } });

host.sendJ({ type: "approve", id: req.id });
const approved = await v1.next(type("approved"));
ok(Array.isArray(approved.iceServers), "viewer approved");
await host.next(type("viewer-ready"));

let leaked = false;
try {
  await host.next((m) => (m.type === "chat" && m.text === "sneaky") || (m.type === "signal" && m.data?.x === 1), 200);
  leaked = true;
} catch {}
ok(!leaked, "messages from a not-yet-approved viewer are ignored");

host.sendJ({ type: "signal", to: req.id, data: { sdp: "offer" } });
const s1 = await v1.next(type("signal"));
ok(s1.from === "host" && s1.data.sdp === "offer", "host → viewer signal");
v1.sendJ({ type: "signal", to: "host", data: { sdp: "answer" } });
const s2 = await host.next(type("signal"));
ok(s2.from === req.id && s2.data.sdp === "answer", "viewer → host signal");

const v2 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Dev`);
const w2 = await v2.next(type("waiting"));
const req2 = await host.next(type("join-request"));
host.sendJ({ type: "approve", id: req2.id });
await v2.next(type("approved"));
const peers = await v2.next((m) => m.type === "peers" && m.peers.length === 2);
ok(peers.peers.some((p) => p.id === "host") && peers.peers.some((p) => p.id === req.id), "viewer gets participant list for video calls");
v2.sendJ({ type: "signal", to: req.id, data: { cam: true } });
const s3 = await v1.next((m) => m.type === "signal" && m.from === w2.id);
ok(s3.data.cam === true, "viewer ↔ viewer signal (video call)");

v2.sendJ({ type: "chat", text: "  popcorn ready <b>  " });
const c1 = await host.next((m) => m.type === "chat" && !m.system);
const c2 = await v1.next((m) => m.type === "chat" && !m.system && m.name === "Dev");
ok(c1.text === "popcorn ready <b>" && c2.name === "Dev", "chat delivered to host and viewers");

const v3 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Extra`);
await v3.next(type("waiting"));
const req3 = await host.next(type("join-request"));
host.sendJ({ type: "approve", id: req3.id });
const full = await host.next(type("error"));
ok(full.error === "room_full", "viewer limit enforced");
host.sendJ({ type: "deny", id: req3.id });
const denied = await v3.next(type("denied"));
ok(denied.reason === "denied", "host can deny a request");

host.sendJ({ type: "lock", locked: true });
await host.next((m) => m.type === "roster" && m.locked === true);
const v4 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Late`);
const lockedMsg = await v4.next(type("denied"));
ok(lockedMsg.reason === "locked", "locked room refuses new viewers");

host.sendJ({ type: "kick", id: req2.id });
const kicked = await v2.next(type("denied"));
ok(kicked.reason === "removed", "host can remove a viewer");
const left = await host.next(type("viewer-left"));
ok(left.id === req2.id, "host told viewer was removed");

// Host drops and reconnects with the same secret
host.close();
await v1.next(type("host-away"));
const host2 = await connect(`/api/rooms/${room.code}/ws?role=host&token=${room.hostToken}`);
await host2.next(type("welcome"));
const back = await v1.next(type("host-back"));
const ready = await host2.next(type("viewer-ready"));
ok(!!back && ready.id === req.id, "host can reconnect and viewers resume");

host2.sendJ({ type: "end" });
const closed = await v1.next(type("room-closed"));
ok(closed.reason === "ended", "ending the room disconnects everyone");
try {
  await connect(`/api/rooms/${room.code}/ws?role=viewer&name=After`);
  ok(false, "ended code no longer works");
} catch (e) {
  ok(/room_not_found/.test(e.message), "ended code no longer works");
}
const r2 = await env.ROOM.get(room.code).init(room.code, "x", 2, "Thief");
ok(r2 === false, "an ended code can't be reused for a new room");

let blockedAt = null;
for (let i = 0; i < 12; i++) {
  try {
    await connect(`/api/rooms/ZZZZZZZ${"23456789ABCD"[i]}/ws?role=viewer&name=x`);
  } catch (e) {
    if (/too_many_attempts/.test(e.message) && blockedAt === null) blockedAt = i + 1;
  }
}
ok(blockedAt !== null && blockedAt <= 10, `guessing codes is blocked after a few tries (blocked at attempt ${blockedAt})`);

let creates = 0;
for (let i = 0; i < 25; i++) {
  const res = await call("/api/rooms", { method: "POST", body: "{}", headers: { "CF-Connecting-IP": "198.51.100.9" } });
  if (res.status === 201) creates++;
}
ok(creates === 20, `room creation is rate-limited (${creates}/25 allowed)`);

// Codes look random and never use confusable characters
const codes = new Set();
for (let i = 0; i < 2000; i++) {
  const res = await call("/api/rooms", { method: "POST", body: "{}", headers: { "CF-Connecting-IP": "10.0.0." + (i % 250) + "." + Math.floor(i / 250) } });
  const j = await res.json();
  if (j.code) codes.add(j.code);
}
ok(codes.size > 1900 && [...codes].every((c) => !/[01OIL]/.test(c)), `codes are unique and readable (${codes.size} unique)`);

// ---------- pairing a phone with a TV ----------
{
  const H2 = { "CF-Connecting-IP": "192.0.2.77" };
  const rr = await call("/api/rooms", { method: "POST", headers: H2, body: JSON.stringify({ hostName: "Ricky", maxViewers: 2 }) });
  const rm = await rr.json();
  const h = await connect(`/api/rooms/${rm.code}/ws?role=host&token=${rm.hostToken}`, H2);
  await h.next(type("welcome"));
  const tv = await connect(`/api/rooms/${rm.code}/ws?role=viewer&name=Sarah`, H2);
  await tv.next(type("waiting"));
  const jr = await h.next(type("join-request"));
  h.sendJ({ type: "approve", id: jr.id });
  await tv.next(type("approved"));
  await h.next(type("viewer-ready"));

  const pending = await connect(`/api/rooms/${rm.code}/ws?role=viewer&name=Pending`, H2);
  await pending.next(type("waiting"));
  const pendReq = await h.next(type("join-request"));
  pending.sendJ({ type: "companion-code" });
  let leakedPin = false;
  try { await pending.next(type("companion-code"), 200); leakedPin = true; } catch {}
  ok(!leakedPin, "someone not yet let in can't get a pairing code");

  tv.sendJ({ type: "companion-code" });
  const pc = await tv.next(type("companion-code"));
  ok(/^\d{6}$/.test(pc.pin), `TV viewer gets a 6-digit pairing code (${pc.pin})`);
  tv.sendJ({ type: "companion-code" });
  const pc2 = await tv.next(type("companion-code"));
  ok(pc2.pin === pc.pin, "asking again gives the same code");

  try {
    await connect(`/api/rooms/${rm.code}/ws?role=companion&pin=${pc.pin === "000000" ? "111111" : "000000"}`, H2, "Sarah");
    ok(false, "wrong pairing code refused");
  } catch (e) { ok(/wrong_pin/.test(e.message), "wrong pairing code refused"); }

  const phone = await connect(`/api/rooms/${rm.code}/ws?role=companion&pin=${pc.pin}`, H2, "Sarah");
  const ap = await phone.next(type("approved"));
  ok(ap.companion === true && ap.ownerName === "Sarah", "phone joins straight in as Sarah's camera and mic, no approval needed");
  const vr = await h.next((m) => m.type === "viewer-ready" && m.companionOf);
  ok(vr.companionOf === jr.id, "host is told it's Sarah's paired phone (so no film is sent to it)");
  const paired = await tv.next(type("paired"));
  ok(!!paired.id, "Sarah's TV is told her phone is paired");
  const peersOnPhone = await phone.next((m) => m.type === "peers" && m.peers.some((p) => p.id === jr.id));
  ok(peersOnPhone.peers.some((p) => p.id === "host"), "phone can video-call everyone in the room");
  phone.sendJ({ type: "chat", text: "hi from my phone" });
  const ch = await h.next((m) => m.type === "chat" && m.text === "hi from my phone");
  ok(ch.name === "Sarah", "phone chats as Sarah");

  // Room allows 2: Sarah's TV + one more. Sarah's phone must not take the second place.
  h.sendJ({ type: "approve", id: pendReq.id });
  let full = false;
  try { await h.next((m) => m.type === "error" && m.error === "room_full", 300); full = true; } catch {}
  const pendOk = await pending.next(type("approved")).then(() => true, () => false);
  ok(!full && pendOk, "paired phone doesn't use up a place in the room");

  const hostPin = (h.sendJ({ type: "companion-code" }), await h.next(type("companion-code"))).pin;
  const hostPhone = await connect(`/api/rooms/${rm.code}/ws?role=companion&pin=${hostPin}`, H2);
  const hap = await hostPhone.next(type("approved"));
  ok(hap.companion && hap.ownerName === "Ricky", "host can pair their own phone too");
  hostPhone.sendJ({ type: "remote", action: "play" });
  ok((await h.next(type("remote"))).action === "play", "host's paired phone works as the film remote");
  phone.sendJ({ type: "remote", action: "faces:mini" });
  ok((await tv.next(type("remote"))).action === "faces:mini", "Sarah's phone sets the faces on her own TV");
  let strayRemote = false;
  pending.sendJ({ type: "remote", action: "play" });
  phone.sendJ({ type: "remote", action: "rm -rf" });
  try { await h.next(type("remote"), 200); strayRemote = true; } catch {}
  ok(!strayRemote, "only a paired phone can send remote presses, and only known ones");

  const phone2 = await connect(`/api/rooms/${rm.code}/ws?role=companion&pin=${pc.pin}`, H2, "Sarah");
  await phone2.next(type("approved"));
  const replaced = await phone.next(type("room-closed"));
  ok(replaced.reason === "paired-elsewhere", "pairing a new device replaces the old one");

  h.sendJ({ type: "kick", id: jr.id });
  await tv.next(type("denied"));
  const gone = await phone2.next(type("room-closed"));
  ok(gone.reason === "paired-left", "removing Sarah also disconnects her paired phone");
  try {
    await connect(`/api/rooms/${rm.code}/ws?role=companion&pin=${pc.pin}`, H2, "Sarah");
    ok(false, "old pairing code stops working");
  } catch (e) { ok(/wrong_pin/.test(e.message), "old pairing code stops working"); }
}

// ---------- accounts: Google, Facebook, email, TV sign-in, friends, invites ----------
{
  ORIGIN["CF-Connecting-IP"] = "192.0.2.150"; // fresh address: earlier tests tripped the guessing block on purpose
  // Pretend to be Google and Facebook
  const realFetch = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input instanceof Request ? input.url : input);
    const j = (o, st = 200) => new BaseResponse(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("https://mock.google/token")) {
      const b = new URLSearchParams(String(init.body));
      seen.googleVerifier = b.get("code_verifier");
      return b.get("code") === "good" ? j({ access_token: "gat" }) : j({ error: "bad" }, 400);
    }
    if (u.startsWith("https://mock.google/user")) return j({ sub: "g-777", email: "gina@example.com", email_verified: true, name: "Gina", picture: "https://img.example/gina.png" });
    if (u.startsWith("https://mock.fb/token")) return j({ access_token: "fat" });
    if (u.startsWith("https://mock.fb/me")) {
      seen.fbProof = new URL(u).searchParams.get("appsecret_proof");
      return j({ id: "fb-42", name: "Faye", email: "faye@example.com", picture: { data: { url: "https://img.example/faye.png", is_silhouette: false } } });
    }
    return realFetch(input, init);
  };
  const nav = (path) => worker.fetch(new Request("https://server.test" + path, { headers: { "CF-Connecting-IP": "198.51.100.200" } }), env);
  const post = (path, bodyObj, token, ip = "198.51.100.201") =>
    worker.fetch(new Request("https://server.test" + path, { method: "POST", headers: { ...ORIGIN, "CF-Connecting-IP": ip, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(bodyObj || {}) }), env);
  const RET = "https://friends.example/";

  // Signed out = nothing works
  const noAuth = await call("/api/rooms", { method: "POST", headers: { Authorization: null }, body: "{}" });
  ok(noAuth.status === 401, "can't open a room without signing in");
  const rq = await (await call("/api/rooms", { method: "POST", body: "{}" })).json();
  try { await connect(`/api/rooms/${rq.code}/ws?role=viewer&name=Sarah`, {}, "nobody"); ok(false, "can't join without signing in"); }
  catch (e) { ok(/signed_out/.test(e.message), "can't join a room without signing in"); }
  const tk = await ticketFor("Sarah");
  const used1 = await call(`/api/rooms/${rq.code}/ws?role=viewer&ticket=${tk}`, { headers: { Upgrade: "websocket" } });
  const used2 = await call(`/api/rooms/${rq.code}/ws?role=viewer&ticket=${tk}`, { headers: { Upgrade: "websocket" } });
  await new Promise((r) => setTimeout(r, 0));
  const second = used2.webSocket._buffer && JSON.parse(used2.webSocket._buffer[0]);
  ok(used1.status === 101 && second && second.type === "refused" && second.error === "signed_out", "a join pass only works once");

  // Google
  const evil = await nav("/auth/google/start?return=" + encodeURIComponent("https://evil.example/"));
  ok(evil.status === 400, "sign-in refuses to send people to other websites");
  const gs = await nav("/auth/google/start?return=" + encodeURIComponent(RET));
  const gloc = new URL(gs.headers.get("Location"));
  ok(gs.status === 302 && gloc.host === "accounts.google.com" && gloc.searchParams.get("code_challenge_method") === "S256" && !!gloc.searchParams.get("state"), "Google sign-in starts with a one-time state and PKCE");
  const gcb = await nav(`/auth/google/callback?state=${gloc.searchParams.get("state")}&code=good`);
  const back = gcb.headers.get("Location") || "";
  ok(gcb.status === 302 && back.startsWith(RET + "#login=") && !!seen.googleVerifier, "Google sends people back to the app with a one-time code");
  const replay = await nav(`/auth/google/callback?state=${gloc.searchParams.get("state")}&code=good`);
  ok(replay.status === 400, "a Google sign-in link can't be replayed");
  const ex = await (await post("/auth/exchange", { code: back.split("#login=")[1] })).json();
  ok(!!ex.token && ex.user.name === "Gina" && ex.user.photo === "https://img.example/gina.png", "the code becomes a signed-in session with name and photo");
  const ex2 = await post("/auth/exchange", { code: back.split("#login=")[1] });
  ok(ex2.status === 400, "the hand-off code only works once");
  const ginaMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + ex.token } })).json();
  ok(ginaMe.user.email === "gina@example.com", "signed-in person can see their account");

  // Facebook
  const fs = await nav("/auth/facebook/start?return=" + encodeURIComponent(RET));
  const floc = new URL(fs.headers.get("Location"));
  ok(fs.status === 302 && floc.host === "www.facebook.com" && floc.pathname.includes("/v26.0/"), "Facebook sign-in starts (Graph API v26)");
  const fcb = await nav(`/auth/facebook/callback?state=${floc.searchParams.get("state")}&code=ok`);
  const fex = await (await post("/auth/exchange", { code: (fcb.headers.get("Location") || "").split("#login=")[1] })).json();
  ok(fex.user && fex.user.name === "Faye" && /^[0-9a-f]{64}$/.test(seen.fbProof || ""), "Facebook sign-in works and signs its requests");

  // Email code + link
  const ms = await post("/auth/email/start", { email: "Gina@Example.com", return: RET });
  ok(ms.status === 200, "email sign-in sends a code");
  const mail = await (await worker.fetch(new Request("https://server.test/dev/mail?to=gina@example.com"), env)).json();
  const mcode = (mail.subject || "").match(/(\d{6})/)[1];
  const wrong = await (await post("/auth/email/verify", { email: "gina@example.com", code: mcode === "000000" ? "111111" : "000000" })).json();
  ok(wrong.error === "wrong_code", "a wrong email code is refused");
  const mv = await (await post("/auth/email/verify", { email: "gina@example.com", code: mcode })).json();
  ok(mv.token && mv.user.id === ex.user.id, "same email by Google or email link = the same account");
  const again = await (await post("/auth/email/verify", { email: "gina@example.com", code: mcode })).json();
  ok(again.error === "expired", "an email code only works once");
  await post("/auth/email/start", { email: "linky@example.com", return: RET });
  const lmail = await (await worker.fetch(new Request("https://server.test/dev/mail?to=linky@example.com"), env)).json();
  const ltoken = lmail.text.match(/#magic=([0-9a-f]+)/)[1];
  const lv = await (await post("/auth/email/verify", { token: ltoken })).json();
  ok(!!lv.token && lv.user.name === "Linky", "the emailed link signs you in too (name taken from the email)");
  for (let i = 0; i < 3; i++) await post("/auth/email/start", { email: "spam@example.com", return: RET }, null, "198.51.100." + (10 + i));
  const spam = await post("/auth/email/start", { email: "spam@example.com", return: RET }, null, "198.51.100.20");
  ok(spam.status === 429, "an address can't be flooded with sign-in emails");

  // TV sign-in by QR (device flow)
  const ds = await (await post("/auth/device/start", {})).json();
  ok(/^[0-9a-f]{48}$/.test(ds.deviceCode) && /^[B-DF-HJ-NP-TV-XZ2-9]{8}$/.test(ds.userCode), "TV gets a sign-in code to show as a QR");
  ok((await (await post("/auth/device/poll", { deviceCode: ds.deviceCode })).json()).pending === true, "TV waits until a phone approves");
  const sarahTok = await tokenFor("Sarah");
  const di = await post("/auth/device/info", { userCode: ds.userCode }, sarahTok);
  ok(di.status === 200, "phone sees which device is asking");
  await post("/auth/device/approve", { userCode: ds.userCode }, sarahTok);
  const dp = await (await post("/auth/device/poll", { deviceCode: ds.deviceCode })).json();
  ok(dp.token && dp.user.name === "Sarah", "TV is signed in as Sarah after she approves on her phone");
  ok((await (await post("/auth/device/poll", { deviceCode: ds.deviceCode })).json()).error === "expired", "the TV code can't be used again");
  const notSignedIn = await post("/auth/device/approve", { userCode: "BCDFGHJK" });
  ok(notSignedIn.status === 401, "only a signed-in phone can approve a TV");

  // Friends
  const rickyTok = await tokenFor("Ricky");
  const devTok = await tokenFor("Dev");
  const add = await (await post("/api/friends/add", { email: "sarah@example.com", return: RET }, rickyTok)).json();
  ok(add.status === "requested", "add a friend by email");
  const sMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + sarahTok } })).json();
  const ricky = sMe.friends.find((f) => f.name === "Ricky");
  ok(ricky && ricky.status === "incoming", "they see the friend request");
  await post("/api/friends/respond", { id: ricky.id, accept: true }, sarahTok);
  const rMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + rickyTok } })).json();
  const sarahF = rMe.friends.find((f) => f.name === "Sarah");
  ok(sarahF && sarahF.status === "friends", "accepting makes you friends on both sides");
  const unknown = await (await post("/api/friends/add", { email: "newbie@example.com", return: RET }, rickyTok)).json();
  ok(unknown.status === "requested", "adding someone without an account gives the same answer (emails can't be probed)");
  const inviteMail = await (await worker.fetch(new Request("https://server.test/dev/mail?to=newbie@example.com"), env)).json();
  ok(/Ricky/.test(inviteMail.subject || ""), "they get an invitation email");
  await post("/auth/email/start", { email: "newbie@example.com", return: RET }, null, "198.51.100.77");
  const nm = await (await worker.fetch(new Request("https://server.test/dev/mail?to=newbie@example.com"), env)).json();
  const nv = await (await post("/auth/email/verify", { email: "newbie@example.com", code: nm.subject.match(/(\d{6})/)[1] }, null, "198.51.100.78")).json();
  const nMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + nv.token } })).json();
  ok(nMe.friends.some((f) => f.name === "Ricky" && f.status === "incoming"), "when they sign up, Ricky's request is waiting");

  // Room invites
  const room = await (await call("/api/rooms", { method: "POST", headers: { Authorization: "Bearer " + rickyTok }, body: JSON.stringify({ maxViewers: 4 }) })).json();
  const host = await connect(`/api/rooms/${room.code}/ws?role=host&token=${room.hostToken}`);
  await host.next(type("welcome"));
  const inboxRes = await call("/api/me/ws", { headers: { Upgrade: "websocket", Authorization: "Bearer " + sarahTok } });
  const inbox = inboxRes.webSocket;
  const live = [];
  inbox.listeners.message.push((d) => live.push(JSON.parse(d)));
  const devMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + devTok } })).json();
  const invr = await (await post(`/api/rooms/${room.code}/invite`, { hostToken: room.hostToken, friendIds: [sarahF.id, devMe.user.id] }, rickyTok)).json();
  ok(invr.invited.length === 1 && invr.invited[0] === sarahF.id, "you can only invite people who are your friends");
  await new Promise((r) => setTimeout(r, 5));
  ok(live.some((m) => m.type === "invite" && m.invite.code === room.code && m.invite.from.name === "Ricky"), "invited friend gets a live invite on their home screen");
  const sMe2 = await (await call("/api/me", { headers: { Authorization: "Bearer " + sarahTok } })).json();
  ok(sMe2.invites.some((i) => i.code === room.code), "the invite is waiting if they open the app later");
  const sv = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Sarah`);
  const sa = await sv.next((m) => m.type === "approved" || m.type === "waiting");
  const sa2 = sa.type === "waiting" ? await sv.next(type("approved"), 300).catch(() => null) : sa;
  ok(!!sa2 && sa2.type === "approved", "invited friends go straight in");
  const dv = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Dev`);
  await dv.next(type("waiting"));
  const djr = await host.next(type("join-request"));
  ok(djr.name === "Dev", "people who weren't invited still need 'Let in'");
  const fakeInvite = await post(`/api/rooms/${room.code}/invite`, { hostToken: room.hostToken, friendIds: [] }, devTok);
  ok(fakeInvite.status === 403, "only the host can send invites for a room");

  // Names come from accounts, not from what the browser claims
  const liar = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Sarah`, {}, "Dev");
  await liar.next(type("waiting"));
  const ljr = await host.next(type("join-request"));
  ok(ljr.name === "Dev", "a viewer can't pretend to be someone else");

  // Host controls need the host's account too
  try { await connect(`/api/rooms/${room.code}/ws?role=host&token=${room.hostToken}`, {}, "Dev"); ok(false, "host account check"); }
  catch (e) { ok(/not_host/.test(e.message), "a stolen host link doesn't work from someone else's account"); }

  // Paired phone must be signed in to the same account as the TV
  sv.sendJ({ type: "companion-code" });
  const spin = (await sv.next(type("companion-code"))).pin;
  try { await connect(`/api/rooms/${room.code}/ws?role=companion&pin=${spin}`, {}, "Dev"); ok(false, "pair as other account"); }
  catch (e) { ok(/wrong_pin/.test(e.message), "someone else's phone can't pair as your TV's camera"); }
  const sphone = await connect(`/api/rooms/${room.code}/ws?role=companion&pin=${spin}`, {}, "Sarah");
  ok((await sphone.next(type("approved"))).companion === true, "your own phone pairs fine");

  // Boxxie codes: sign in with your own code, no email
  const prv = await (await call("/auth/providers", { headers: { Authorization: null } })).json();
  ok(prv.code === true, "Boxxie code sign-in is on by default");
  const noName = await post("/auth/code/create", { name: "" }, null, "198.51.100.120");
  ok(noName.status === 400, "a new account needs a name");
  const acc = await (await post("/auth/code/create", { name: "Priya" }, null, "198.51.100.121")).json();
  ok(/^BOXX(-[B-DF-HJ-NP-TV-XZ2-9]{4}){3}$/.test(acc.code) && acc.token && acc.user.name === "Priya", `new account gets its own sign-in code (${acc.code})`);
  const accMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + acc.token } })).json();
  ok(/^[B-DF-HJ-NP-TV-XZ2-9]{8}$/.test(accMe.user.friendCode) && accMe.user.hasCode, "and a friend code to share");
  const cBack = await (await post("/auth/code/signin", { code: acc.code.toLowerCase().replace(/-/g, " ") }, null, "198.51.100.122")).json();
  ok(cBack.token && cBack.user.id === acc.user.id, "signing in with the code works on another device (spaces and lower case are fine)");
  const wrongc = await post("/auth/code/signin", { code: "BOXX-BBBB-CCCC-DDDD" }, null, "198.51.100.123");
  ok(wrongc.status === 400, "a wrong code is refused");
  for (let i = 0; i < 8; i++) await post("/auth/code/signin", { code: "BOXX-BBBB-CCCC-DDD" + "FGHJKLMN"[i] }, null, "198.51.100.124");
  const flood = await post("/auth/code/signin", { code: acc.code }, null, "198.51.100.124");
  ok(flood.status === 429, "guessing codes gets blocked after a few tries");
  const newCode = (await (await post("/api/me/code/reset", {}, acc.token)).json()).code;
  const oldTry = await post("/auth/code/signin", { code: acc.code }, null, "198.51.100.125");
  const newTry = await (await post("/auth/code/signin", { code: newCode }, null, "198.51.100.125")).json();
  ok(oldTry.status === 400 && newTry.token, "getting a new code stops the old one working");
  const acc2 = await (await post("/auth/code/create", { name: "Omar" }, null, "198.51.100.126")).json();
  const fadd = await (await post("/api/friends/add", { code: accMe.user.friendCode.toLowerCase() }, acc2.token)).json();
  const pMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + acc.token } })).json();
  ok(fadd.status === "requested" && pMe.friends.some((f) => f.name === "Omar" && f.status === "incoming"), "friends add each other by friend code");
  const badF = await post("/api/friends/add", { code: "ZZZZZZZZ" }, acc2.token);
  ok(badF.status === 400, "an unknown friend code says so");
  for (let i = 0; i < 5; i++) await post("/auth/code/create", { name: "Spam" + i }, null, "198.51.100.127");
  const tooMany = await post("/auth/code/create", { name: "Spam6" }, null, "198.51.100.127");
  ok(tooMany.status === 429, "one connection can't make lots of accounts");

  // Authenticator app (Google Authenticator) as an extra lock
  const { totpAt: tAt } = await import("../src/accounts.js");
  const setup = await (await post("/api/me/totp/setup", {}, acc2.token)).json();
  ok(/^otpauth:\/\/totp\/Boxxie%20Share/.test(setup.uri) && setup.secret.length >= 32, "Boxxie Share gives a QR code for Google Authenticator");
  const step = Math.floor(Date.now() / 30000);
  const badConfirm = await post("/api/me/totp/confirm", { code: "000000" === (await tAt(setup.secret, step)) ? "111111" : "000000" }, acc2.token);
  ok(badConfirm.status === 400, "the wrong number doesn't switch it on");
  const conf = await post("/api/me/totp/confirm", { code: await tAt(setup.secret, step - 1) }, acc2.token);
  ok(conf.status === 200, "the number from the app switches the extra lock on");
  const o1 = await (await post("/auth/code/signin", { code: acc2.code }, null, "198.51.100.130")).json();
  ok(o1.needOtp === true && !o1.token, "with the lock on, the Boxxie code alone isn't enough");
  const o2 = await post("/auth/code/signin", { code: acc2.code, otp: "123456" === (await tAt(setup.secret, step)) ? "654321" : "123456" }, null, "198.51.100.131");
  ok(o2.status === 400, "a wrong authenticator number is refused");
  const o3 = await (await post("/auth/code/signin", { code: acc2.code, otp: await tAt(setup.secret, step) }, null, "198.51.100.132")).json();
  ok(!!o3.token, "Boxxie code plus the authenticator number signs in");
  const o4 = await post("/auth/code/signin", { code: acc2.code, otp: await tAt(setup.secret, step) }, null, "198.51.100.133");
  ok(o4.status === 400, "the same authenticator number can't be used twice");
  const acc2Me = await (await call("/api/me", { headers: { Authorization: "Bearer " + acc2.token } })).json();
  ok(acc2Me.user.totp === true, "the account shows the extra lock is on");

  // App review account: fixed code, no email sent
  env.REVIEW_EMAIL = "review@example.com";
  env.REVIEW_CODE = "246810";
  const rvs = await post("/auth/email/start", { email: "review@example.com", return: RET }, null, "198.51.100.90");
  const rvMail = await (await worker.fetch(new Request("https://server.test/dev/mail?to=review@example.com"), env)).json();
  const rvv = await (await post("/auth/email/verify", { email: "review@example.com", code: "246810" }, null, "198.51.100.91")).json();
  ok(rvs.status === 200 && !rvMail.subject && rvv.token, "the app-review account signs in with its fixed code, without an email");
  const other = await (await post("/auth/email/verify", { email: "someone@example.com", code: "246810" }, null, "198.51.100.92")).json();
  ok(!other.token, "the review code doesn't work for anyone else");
  delete env.REVIEW_EMAIL; delete env.REVIEW_CODE;

  // Block and report (Google Play / App Store rules for chat and video apps)
  env.REPORT_EMAIL = "owner@example.com";
  env.ADMIN_TOKEN = "admin-secret-for-tests";
  const ginaTok = await tokenFor("Gina");
  const halTok = await tokenFor("Hal");
  const ginaId = (await (await call("/api/me", { headers: { Authorization: "Bearer " + ginaTok } })).json()).user.id;
  const halId = (await (await call("/api/me", { headers: { Authorization: "Bearer " + halTok } })).json()).user.id;
  await post("/api/friends/add", { email: "gina@example.com", return: RET }, halTok);
  await post("/api/friends/respond", { id: halId, accept: true }, ginaTok);
  const gRoom = await (await call("/api/rooms", { method: "POST", headers: { Authorization: "Bearer " + ginaTok }, body: JSON.stringify({ maxViewers: 4 }) })).json();
  const gHost = await connect(`/api/rooms/${gRoom.code}/ws?role=host&token=${gRoom.hostToken}`, {}, "Gina");
  await gHost.next(type("welcome"));
  const halIn = await connect(`/api/rooms/${gRoom.code}/ws?role=viewer`, {}, "Hal");
  const hjr = await gHost.next(type("join-request"));
  gHost.sendJ({ type: "approve", id: hjr.id });
  await halIn.next(type("approved"));
  halIn.sendJ({ type: "chat", text: "rude message" });
  const rude = await gHost.next((m) => m.type === "chat" && m.text === "rude message");
  ok(rude.userId === halId, "chat messages say which account sent them (so they can be blocked and reported)");
  const peersMsg = await halIn.next((m) => m.type === "peers");
  ok(peersMsg.peers.some((p) => p.host && p.userId === ginaId), "people in the room can see who to block or report");
  const rep = await post("/api/report", { userId: halId, room: gRoom.code, reason: "harassment", details: "kept being rude", messages: ["rude message"], block: true }, ginaTok);
  ok(rep.status === 200, "you can report someone");
  const gMe = await (await call("/api/me", { headers: { Authorization: "Bearer " + ginaTok } })).json();
  ok(gMe.blocked.some((b) => b.id === halId) && !gMe.friends.some((f) => f.id === halId), "reporting with 'also block' blocks them and removes the friendship");
  const ownerMail = await (await worker.fetch(new Request("https://server.test/dev/mail?to=owner@example.com"), env)).json();
  ok(/harassment/.test(ownerMail.subject || "") && /rude message/.test(ownerMail.text || ""), "the app owner is emailed the report straight away");
  await post("/api/friends/add", { email: "gina@example.com", return: RET }, halTok);
  const gMe2 = await (await call("/api/me", { headers: { Authorization: "Bearer " + ginaTok } })).json();
  ok(!gMe2.friends.some((f) => f.id === halId), "a blocked person can't send you friend requests");
  try { await connect(`/api/rooms/${gRoom.code}/ws?role=viewer`, {}, "Hal"); ok(false, "blocked join"); }
  catch (e) { ok(/not_allowed/.test(e.message), "a blocked person can't ask to join your rooms"); }
  await post("/api/blocks/remove", { id: halId }, ginaTok);
  const gMe3 = await (await call("/api/me", { headers: { Authorization: "Bearer " + ginaTok } })).json();
  ok(!gMe3.blocked.length, "you can unblock someone");
  const banUrl = new URL((ownerMail.text.match(/Ban this account: (\S+)/) || [])[1]);
  const badBan = await worker.fetch(new Request(`https://server.test/admin/ban?user=${halId}&sig=00`, { headers: ORIGIN }), env);
  ok(badBan.status === 403, "ban links can't be forged");
  const banPage = await worker.fetch(new Request("https://server.test" + banUrl.pathname + banUrl.search, { headers: ORIGIN }), env);
  ok(banPage.status === 200 && /Ban this account/.test(await banPage.text()), "the report email's ban link asks before banning");
  await worker.fetch(new Request("https://server.test" + banUrl.pathname + banUrl.search, { method: "POST", headers: ORIGIN }), env);
  const halAfter = await call("/api/me", { headers: { Authorization: "Bearer " + halTok } });
  ok(halAfter.status === 401, "a banned account is signed out everywhere");

  // Delete account
  const fayeTok = fex.token;
  await post("/api/friends/add", { email: "sarah@example.com", return: RET }, fayeTok);
  const del = await post("/api/me/delete", {}, fayeTok);
  const gone = await call("/api/me", { headers: { Authorization: "Bearer " + fayeTok } });
  const sMe3 = await (await call("/api/me", { headers: { Authorization: "Bearer " + sarahTok } })).json();
  ok(del.status === 200 && gone.status === 401 && !sMe3.friends.some((f) => f.name === "Faye"), "deleting an account removes it and its friend requests");
  const fs2 = await nav("/auth/facebook/start?return=" + encodeURIComponent(RET));
  const fl2 = new URL(fs2.headers.get("Location"));
  const fcb2 = await nav(`/auth/facebook/callback?state=${fl2.searchParams.get("state")}&code=ok`);
  const fex2 = await (await post("/auth/exchange", { code: (fcb2.headers.get("Location") || "").split("#login=")[1] })).json();
  ok(fex2.user && fex2.user.id !== fex.user.id, "signing in again after deleting starts a fresh account");

  // Sign out
  await post("/auth/signout", {}, ex.token);
  const after = await call("/api/me", { headers: { Authorization: "Bearer " + ex.token } });
  ok(after.status === 401, "signing out ends the session");
  globalThis.fetch = realFetch;
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
