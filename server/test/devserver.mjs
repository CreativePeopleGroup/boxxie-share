// Local test server: serves the web app AND runs the real Worker code with an in-memory
// Durable Objects stand-in. Lets you try everything on one computer without Cloudflare.
//   node --import ./test/register.mjs test/devserver.mjs [port]
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker, { Room, Limiter, Directory } from "../src/index.js";

const PORT = Number(process.argv[2] || 8788);
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

// ---- runtime stand-ins ----
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
class Storage {
  constructor() { this.map = new Map(); }
  async get(k) { const v = this.map.get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(k, v) { this.map.set(k, structuredClone(v)); }
  async delete(k) { this.map.delete(k); }
  async deleteAll() { this.map.clear(); }
  async setAlarm() {}
}
function namespace(Cls, env) {
  const objects = new Map();
  return {
    idFromName: (n) => n,
    get(id) {
      if (!objects.has(id)) {
        const sockets = [];
        const ctx = {
          storage: new Storage(),
          acceptWebSocket: (ws, tags = []) => { ws._do = obj; ws._tags = tags; sockets.push(ws); },
          getWebSockets: (tag) => sockets.filter((s) => !s._closed && (!tag || (s._tags || []).includes(tag))),
        };
        const obj = new Cls(ctx, env);
        objects.set(id, obj);
      }
      return objects.get(id);
    },
  };
}
class End {
  constructor() { this._closed = false; this._att = null; this.onmessage = null; this.onclose = null; this._buf = []; }
  accept() {}
  serializeAttachment(a) { this._att = structuredClone(a); }
  deserializeAttachment() { return this._att ? structuredClone(this._att) : null; }
  send(data) {
    if (this._closed) throw new Error("closed");
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer._isServer) peer._do?.webSocketMessage(peer, data);
      else if (peer.onmessage) peer.onmessage(data);
      else peer._buf.push(data);
    });
  }
  close(code, reason) {
    if (this._closed) return;
    this._closed = true;
    const peer = this.peer;
    queueMicrotask(() => {
      peer._closed = true;
      if (peer._isServer) peer._do?.webSocketClose(peer, code, reason, true);
      else peer.onclose?.(code, reason);
    });
  }
}
globalThis.WebSocketPair = class {
  constructor() {
    const c = new End(), s = new End();
    s._isServer = true; c.peer = s; s.peer = c;
    this[0] = c; this[1] = s;
  }
};
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ALLOWED_ORIGINS: BASE,
  DEV: "1",
  EMAIL_PROVIDER: "log",
  REPORT_EMAIL: "owner@example.com",
  ADMIN_TOKEN: "dev-admin-token",
  // Fake Google and Facebook (served below) so sign-in buttons can be tested end to end
  GOOGLE_CLIENT_ID: "dev", GOOGLE_CLIENT_SECRET: "dev",
  FACEBOOK_APP_ID: "dev", FACEBOOK_APP_SECRET: "dev",
  DEV_GOOGLE_AUTH: `${BASE}/mock/google/auth`, DEV_GOOGLE_TOKEN: `${BASE}/mock/google/token`, DEV_GOOGLE_USER: `${BASE}/mock/google/user`,
  DEV_FB_AUTH: `${BASE}/mock/fb/auth`, DEV_FB_TOKEN: `${BASE}/mock/fb/token`, DEV_FB_USER: `${BASE}/mock/fb/me`,
};
env.ROOM = namespace(Room, env);
env.LIMITER = namespace(Limiter, env);
env.DIRECTORY = namespace(Directory, env);

// ---- minimal WebSocket framing (RFC 6455) ----
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function bridge(socket, end) {
  let buf = Buffer.alloc(0);
  let open = true;
  const sendText = (t) => open && socket.write(frame(1, Buffer.from(t)));
  end.onmessage = sendText;
  end._buf.splice(0).forEach(sendText);
  end.onclose = (code = 1000) => {
    if (!open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    socket.write(frame(8, p));
    open = false;
    socket.end();
  };
  if (end._closed) end.onclose();
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 1) { try { end.send(data.toString()); } catch {} }
      else if (op === 8) { open = false; end.close(1000); socket.end(); }
      else if (op === 9) socket.write(frame(10, data));
    }
  });
  socket.on("close", () => { if (!end._closed) end.close(1001); open = false; });
  socket.on("error", () => {});
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".webm": "video/webm" };

function mockProvider(url, res) {
  const send = (code, obj, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
  const p = url.pathname;
  if (p === "/mock/google/auth" || p === "/mock/fb/auth") {
    const who = p.includes("google") ? "Gina Google" : "Faye Facebook";
    const back = `${url.searchParams.get("redirect_uri")}?code=ok&state=${url.searchParams.get("state")}`;
    return send(200, `<!doctype html><title>Pretend ${p.includes("google") ? "Google" : "Facebook"}</title><body style="font:18px sans-serif;padding:40px"><h1>Pretend sign-in</h1><a id="as" href="${back}">Continue as ${who}</a>`, "text/html");
  }
  if (p === "/mock/google/token" || p === "/mock/fb/token") return send(200, { access_token: "tok" });
  if (p === "/mock/google/user") return send(200, { sub: "g-1", email: "gina@example.com", email_verified: true, name: "Gina Google" });
  if (p === "/mock/fb/me") return send(200, { id: "f-1", name: "Faye Facebook", email: "faye@example.com" });
  return send(404, {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/mock/")) return mockProvider(url, res);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/dev/")) {
    // In production the website and server are on different sites, so browsers always send Origin.
    if (!/^\/auth\/(google|facebook)\//.test(url.pathname)) req.headers.origin = req.headers.origin || BASE;
    const body = req.method === "POST" ? await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }) : undefined;
    const r = await worker.fetch(new Request(url, { method: req.method, headers: { ...req.headers, "CF-Connecting-IP": req.headers["x-test-ip"] || req.socket.remoteAddress }, body }), env);
    if (r.status === 101 && r.webSocket) { res.writeHead(400); return res.end(); }
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(await r.text());
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  try {
    let data = await readFile(join(WEB, path));
    if (path.endsWith("config.js")) data = Buffer.from(data.toString().replace("__SERVER_URL__", `http://${req.headers.host}`));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.on("upgrade", async (req, socket) => {
  req.headers.origin = req.headers.origin || BASE;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await worker.fetch(new Request(url, { headers: { ...req.headers, "CF-Connecting-IP": req.headers["x-test-ip"] || req.socket.remoteAddress } }), env);
  if (r.status !== 101) {
    socket.end(`HTTP/1.1 ${r.status} Refused\r\n\r\n`);
    return;
  }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  bridge(socket, r.webSocket);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Boxxie Share test server: http://127.0.0.1:${PORT}`));
