// End-to-end check of the connection server. Run `npm run dev` in one terminal, then `npm test`.
import WebSocket from "ws";

const BASE = process.env.SERVER || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

function connect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + path);
    const inbox = [];
    const waiters = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    ws.next = (pred, ms = 4000) =>
      new Promise((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const t = setTimeout(() => rej(new Error("timeout")), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
      });
    ws.sendJ = (m) => ws.send(JSON.stringify(m));
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => reject(new Error("HTTP " + res.statusCode)));
    ws.on("error", reject);
  });
}

const type = (t) => (m) => m.type === t;

const r = await fetch(BASE + "/api/rooms", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hostName: "Ricky", maxViewers: 2 }),
});
const room = await r.json();
ok(r.status === 201 && /^[A-Z2-9]{8}$/.test(room.code) && room.hostToken.length === 64, `room created (${room.code})`);

// Wrong host token is refused
try {
  await connect(`/api/rooms/${room.code}/ws?role=host&token=nope`);
  ok(false, "fake host refused");
} catch (e) {
  ok(/403/.test(e.message), "fake host refused");
}

const host = await connect(`/api/rooms/${room.code}/ws?role=host&token=${room.hostToken}`);
const welcome = await host.next(type("welcome"));
ok(Array.isArray(welcome.iceServers), "host welcomed with ICE servers");

// Viewer joins with code typed in lower case with a dash
const v1 = await connect(`/api/rooms/${room.code.toLowerCase().slice(0, 4)}-${room.code.slice(4)}/ws?role=viewer&name=Sarah`);
const waiting = await v1.next(type("waiting"));
ok(!!waiting.id, "viewer is held in the waiting room");
const req = await host.next(type("join-request"));
ok(req.name === "Sarah", "host sees join request");

// Pending viewer cannot chat or signal
v1.sendJ({ type: "chat", text: "sneaky" });
v1.sendJ({ type: "signal", data: { x: 1 } });

host.sendJ({ type: "approve", id: req.id });
const approved = await v1.next(type("approved"));
ok(Array.isArray(approved.iceServers), "viewer approved");
await host.next(type("viewer-ready"));

let leaked = false;
try {
  await host.next((m) => m.type === "chat" && m.text === "sneaky", 500);
  leaked = true;
} catch {}
ok(!leaked, "pending viewer's messages were ignored");

// Signalling host → viewer and back
host.sendJ({ type: "signal", to: req.id, data: { sdp: "offer" } });
const s1 = await v1.next(type("signal"));
ok(s1.from === "host" && s1.data.sdp === "offer", "host → viewer signal");
v1.sendJ({ type: "signal", to: "host", data: { sdp: "answer" } });
const s2 = await host.next(type("signal"));
ok(s2.from === req.id && s2.data.sdp === "answer", "viewer → host signal");

// Second viewer, approved, then viewer ↔ viewer (video call) signalling
const v2 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Dev`);
const w2 = await v2.next(type("waiting"));
const req2 = await host.next(type("join-request"));
host.sendJ({ type: "approve", id: req2.id });
await v2.next(type("approved"));
const peers = await v2.next((m) => m.type === "peers" && m.peers.length === 2);
ok(peers.peers.some((p) => p.id === "host") && peers.peers.some((p) => p.id === req.id), "viewer gets participant list");
v2.sendJ({ type: "signal", to: req.id, data: { cam: true } });
const s3 = await v1.next((m) => m.type === "signal" && m.from === w2.id);
ok(s3.data.cam === true, "viewer ↔ viewer signal (video call)");

// Chat reaches everyone
v2.sendJ({ type: "chat", text: "  popcorn ready <b>  " });
const c1 = await host.next((m) => m.type === "chat" && !m.system);
const c2 = await v1.next((m) => m.type === "chat" && !m.system && m.name === "Dev");
ok(c1.text === "popcorn ready <b>" && c2.name === "Dev", "chat delivered to host and viewers");

// Room is full at 2 viewers
const v3 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Extra`);
await v3.next(type("waiting"));
const req3 = await host.next(type("join-request"));
host.sendJ({ type: "approve", id: req3.id });
const full = await host.next(type("error"));
ok(full.error === "room_full", "viewer limit enforced");
host.sendJ({ type: "deny", id: req3.id });
const denied = await v3.next(type("denied"));
ok(denied.reason === "denied", "host can deny");

// Lock
host.sendJ({ type: "lock", locked: true });
await host.next((m) => m.type === "roster" && m.locked === true);
const v4 = await connect(`/api/rooms/${room.code}/ws?role=viewer&name=Late`);
const lockedMsg = await v4.next(type("denied"));
ok(lockedMsg.reason === "locked", "locked room refuses new viewers");

// Kick
host.sendJ({ type: "kick", id: req2.id });
const kicked = await v2.next(type("denied"));
ok(kicked.reason === "removed", "host can remove a viewer");

// End room
host.sendJ({ type: "end" });
const closed = await v1.next(type("room-closed"));
ok(closed.reason === "ended", "ending the room disconnects everyone");
try {
  await connect(`/api/rooms/${room.code}/ws?role=viewer&name=After`);
  ok(false, "ended code no longer works");
} catch (e) {
  ok(/404/.test(e.message), "ended code no longer works");
}

// Brute-force protection: wrong codes get blocked
let blocked = false;
for (let i = 0; i < 12; i++) {
  try {
    await connect(`/api/rooms/ZZZZZZZ${"23456789ABCD"[i]}/ws?role=viewer&name=x`);
  } catch (e) {
    if (/429/.test(e.message)) blocked = true;
  }
}
ok(blocked, "repeated wrong codes are rate-limited");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
