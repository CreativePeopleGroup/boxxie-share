// Boxxie Share connection server (Cloudflare Worker + Durable Objects, free plan).
//
// The server never sees the film. It only:
//   - creates rooms with unguessable codes,
//   - lets the host approve or deny each viewer,
//   - passes small WebRTC setup messages between host and approved viewers,
//   - relays chat,
//   - rate-limits code guessing,
//   - hands out TURN relay credentials to people who are allowed in.

import { DurableObject } from "cloudflare:workers";
import { Directory, handleAccounts } from "./accounts.js";

export { Directory };

// No 0/O, 1/I/L — easy to read off a TV and type with a remote.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8; // 31^8 ≈ 852 billion combinations

const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // a room lasts at most 12 hours
const HOST_GRACE_MS = 3 * 60 * 1000; // room survives a host drop-out for 3 minutes
const DEFAULT_MAX_VIEWERS = 6; // direct streaming from home broadband
const MAX_PENDING = 10;
const MAX_NAME = 24;
const REMOTE_ACTIONS = new Set(["play", "back", "fwd", "faces:corner", "faces:mini", "faces:off"]);
const MAX_CHAT = 500;
const MAX_SIGNAL_BYTES = 64 * 1024;

// Rate limits (per IP address)
const JOIN_FAILS_ALLOWED = 8; // wrong codes per window
const JOIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const CREATES_ALLOWED = 20; // new rooms per window
const CREATE_WINDOW_MS = 60 * 60 * 1000;

// ---------- helpers ----------

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  let out = "";
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // reject bytes that would bias the distribution
      if (b < 256 - (256 % CODE_ALPHABET.length) && out.length < CODE_LENGTH) {
        out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
  }
  return out;
}

function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function randomId() {
  return randomToken(8);
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function normaliseCode(raw) {
  if (typeof raw !== "string") return null;
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== CODE_LENGTH) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

function cleanName(raw) {
  const n = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, MAX_NAME);
  return n || "Guest";
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function originAllowed(request, env) {
  const list = allowedOrigins(env);
  if (list.length === 0 || list.includes("*")) return true; // dev mode
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return list.includes(origin.replace(/\/$/, ""));
}

// Where sign-in may send people back to: only your own Boxxie Share website.
function redirectAllowed(env, target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(env.DEV === "1" && u.protocol === "http:")) return false;
  const list = allowedOrigins(env);
  if (list.length === 0 || list.includes("*")) return env.DEV === "1" || u.protocol === "https:";
  return list.includes(u.origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = allowedOrigins(env);
  const allow = list.length === 0 || list.includes("*") ? "*" : list.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

// Short-lived TURN credentials (Cloudflare Realtime TURN, 1,000 GB/month free).
// Without TURN keys configured we fall back to free STUN, which works for most home connections.
async function iceServers(env) {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stun;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 12 * 60 * 60 }),
      }
    );
    if (!res.ok) return stun;
    const data = await res.json();
    let servers = data.iceServers;
    if (servers && !Array.isArray(servers)) servers = [servers];
    if (!Array.isArray(servers) || servers.length === 0) return stun;
    return [...stun, ...servers];
  } catch {
    return stun;
  }
}

// Browsers can't read the HTTP status of a refused WebSocket, so we accept it,
// say why, and close straight away.
function refuseSocket(error) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ type: "refused", error }));
  pair[1].close(4401, error);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

// ---------- Worker entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "boxxie-share" }, 200, request, env);
    }

    const isSocket = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
    const refuse = (error, status) => (isSocket ? refuseSocket(error) : json({ error }, status, request, env));

    const ip = clientIp(request);
    const limiter = env.LIMITER.get(env.LIMITER.idFromName(ip));
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));

    // Google/Facebook sign-in pages are opened directly by the browser (no Origin header);
    // they check the return address instead.
    const browserNav = /^\/auth\/(google|facebook)\/(start|callback)$/.test(url.pathname) || url.pathname === "/dev/mail" || url.pathname === "/admin/ban";
    if (!browserNav && !originAllowed(request, env)) return refuse("origin_not_allowed", 403);

    const accounts = await handleAccounts(request, env, {
      url,
      ip,
      limiter,
      serverBase: url.origin,
      redirectAllowed: (t) => redirectAllowed(env, t),
      json: (data, status) => json(data, status, request, env),
    });
    if (accounts) return accounts;

    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

    // Create a room → returns code + secret host token
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const me = await dir.whoami(bearer);
      if (!me) return json({ error: "signed_out" }, 401, request, env);
      const ok = await limiter.hit("create", CREATES_ALLOWED, CREATE_WINDOW_MS);
      if (!ok) return json({ error: "too_many_rooms" }, 429, request, env);

      let body = {};
      try {
        body = await request.json();
      } catch {}
      const maxViewers = Math.max(1, Math.min(Number(body.maxViewers) || DEFAULT_MAX_VIEWERS, 20));

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const room = env.ROOM.get(env.ROOM.idFromName(code));
        const hostToken = randomToken();
        const created = await room.init(code, await sha256(hostToken), maxViewers, cleanName(me.name), me.id);
        if (created) {
          return json({ code, hostToken, expiresAt: Date.now() + ROOM_TTL_MS }, 201, request, env);
        }
      }
      return json({ error: "try_again" }, 503, request, env);
    }

    // Host invites friends: /api/rooms/CODE/invite  { hostToken, friendIds: [...] }
    const inv = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invite$/);
    if (inv && request.method === "POST") {
      const me = await dir.whoami(bearer);
      if (!me) return json({ error: "signed_out" }, 401, request, env);
      const code = normaliseCode(decodeURIComponent(inv[1]));
      let body = {};
      try { body = await request.json(); } catch {}
      if (!code) return json({ error: "room_not_found" }, 404, request, env);
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const info = await room.hostInfo(await sha256(String(body.hostToken || "")));
      if (!info || info.hostUserId !== me.id) return json({ error: "not_host" }, 403, request, env);
      const ids = Array.isArray(body.friendIds) ? body.friendIds.map(String).slice(0, 20) : [];
      const sent = await dir.inviteToRoom(me.id, ids, { code, expiresAt: info.expiresAt });
      await room.addInvited(sent);
      return json({ invited: sent }, 200, request, env);
    }

    // WebSocket: /api/rooms/CODE/ws?ticket=…&role=host&token=… | role=viewer | role=companion&pin=…
    const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (m) {
      if (!isSocket) return json({ error: "websocket_required" }, 426, request, env);
      if (await limiter.blocked("joinfail", JOIN_FAILS_ALLOWED, JOIN_FAIL_WINDOW_MS)) {
        return refuse("too_many_attempts", 429);
      }
      // Everyone must be signed in: the app swaps its session for a one-use 60-second ticket.
      const who = await dir.useTicket(url.searchParams.get("ticket"));
      if (!who) return refuse("signed_out", 401);
      const code = normaliseCode(decodeURIComponent(m[1]));
      if (!code) {
        await limiter.hit("joinfail", JOIN_FAILS_ALLOWED, JOIN_FAIL_WINDOW_MS);
        return refuse("room_not_found", 404);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const exists = await room.isOpen();
      if (!exists) {
        await limiter.hit("joinfail", JOIN_FAILS_ALLOWED, JOIN_FAIL_WINDOW_MS);
        return refuse("room_not_found", 404);
      }
      if (url.searchParams.get("role") === "companion") {
        // A phone/tablet/laptop pairing with someone's TV, using the 6-digit pairing code.
        // It must be signed in to the same account as the TV.
        const ok = await room.checkCompanion(String(url.searchParams.get("pin") || ""), who.id);
        if (!ok) {
          await limiter.hit("joinfail", JOIN_FAILS_ALLOWED, JOIN_FAIL_WINDOW_MS);
          return refuse("wrong_pin", 403);
        }
      }
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "companion") {
        // Someone the host has blocked (or who blocked the host) can't ask to join.
        const hostUserId = await room.hostUser();
        if (hostUserId && (await dir.blockedEither(hostUserId, who.id))) return refuse("not_allowed", 403);
      }
      if (url.searchParams.get("role") === "host") {
        const tokenOk = await room.checkHost(await sha256(url.searchParams.get("token") || ""), who.id);
        if (!tokenOk) {
          await limiter.hit("joinfail", JOIN_FAILS_ALLOWED, JOIN_FAIL_WINDOW_MS);
          return refuse("not_host", 403);
        }
      }
      // Pass the signed-in person to the room. Set here by the Worker only, never by the browser.
      const h = new Headers(request.headers);
      h.set("X-Boxxie-User", JSON.stringify(who));
      return room.fetch(new Request(request, { headers: h }));
    }

    return json({ error: "not_found" }, 404, request, env);
  },
};

// ---------- Rate limiter (one object per IP) ----------

export class Limiter extends DurableObject {
  async _load(key, windowMs) {
    const now = Date.now();
    const list = ((await this.ctx.storage.get(key)) || []).filter((t) => now - t < windowMs);
    return list;
  }
  async hit(key, allowed, windowMs) {
    const list = await this._load(key, windowMs);
    if (list.length >= allowed) {
      await this.ctx.storage.put(key, list);
      return false;
    }
    list.push(Date.now());
    await this.ctx.storage.put(key, list);
    await this.ctx.storage.setAlarm(Date.now() + windowMs + 1000);
    return true;
  }
  async blocked(key, allowed, windowMs) {
    const list = await this._load(key, windowMs);
    return list.length >= allowed;
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

// ---------- Room (one object per code) ----------
//
// Each socket carries an attachment: { id, role: "host"|"viewer", name, state: "pending"|"approved" }
// Uses WebSocket hibernation so idle rooms cost nothing on the free plan.

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async init(code, hostHash, maxViewers, hostName, hostUserId) {
    const existing = await this.ctx.storage.get("meta");
    if (existing) return false; // code collision → caller picks another
    const meta = {
      code,
      hostHash,
      maxViewers,
      hostName,
      hostUserId: hostUserId || null,
      invited: [],
      locked: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
      closed: false,
    };
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    return true;
  }

  async _meta() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta || meta.closed || Date.now() > meta.expiresAt) return null;
    return meta;
  }

  async isOpen() {
    return !!(await this._meta());
  }

  async checkHost(hash, userId) {
    const meta = await this._meta();
    return !!meta && timingSafeEqual(meta.hostHash, hash) && (!meta.hostUserId || meta.hostUserId === userId);
  }
  async hostUser() {
    const meta = await this._meta();
    return meta ? meta.hostUserId || null : null;
  }
  async hostInfo(hash) {
    const meta = await this._meta();
    if (!meta || !timingSafeEqual(meta.hostHash, hash)) return null;
    return { hostUserId: meta.hostUserId, expiresAt: meta.expiresAt };
  }
  // People the host invited go straight in (the invite is the host's "let in")
  async addInvited(userIds) {
    const meta = await this._meta();
    if (!meta) return false;
    meta.invited = [...new Set([...(meta.invited || []), ...userIds])].slice(-100);
    await this.ctx.storage.put("meta", meta);
    for (const s of this._pending()) if (s.a.userId && meta.invited.includes(s.a.userId)) await this._approve(meta, s);
    return true;
  }
  async _approve(meta, t) {
    if (this._watchers().length >= meta.maxViewers) {
      const host = this._host();
      if (host) this._send(host.ws, { type: "error", error: "room_full" });
      return false;
    }
    t.ws.serializeAttachment({ ...t.a, state: "approved" });
    this._send(t.ws, { type: "approved", iceServers: await iceServers(this.env) });
    const host = this._host();
    if (host) this._send(host.ws, { type: "viewer-ready", id: t.a.id, name: t.a.name });
    this._broadcastChat({ system: true, text: `${t.a.name} joined` });
    await this._pushRoster(meta);
    return true;
  }

  // ---- pairing a phone with a TV (the phone becomes that TV's camera + mic) ----
  _ownerOnline(owner) {
    if (owner === "host") return !!this._host();
    const o = this._byId(owner);
    return !!o && o.a.role === "viewer" && o.a.state === "approved" && !o.a.companionOf;
  }
  _ownerUserId(meta, owner) {
    if (owner === "host") return meta.hostUserId;
    const o = this._byId(owner);
    return o ? o.a.userId : null;
  }
  async checkCompanion(pin, userId) {
    const meta = await this._meta();
    if (!meta || !/^\d{6}$/.test(pin)) return false;
    const entry = (meta.companions || {})[pin];
    if (!entry || !this._ownerOnline(entry.owner)) return false;
    const ownerUser = this._ownerUserId(meta, entry.owner);
    return !ownerUser || ownerUser === userId; // your phone must be signed in to your account
  }
  async _companionPin(meta, owner, name) {
    meta.companions = meta.companions || {};
    for (const [pin, e] of Object.entries(meta.companions)) if (e.owner === owner) return pin;
    let pin;
    do {
      const b = new Uint32Array(1);
      crypto.getRandomValues(b);
      pin = String(b[0] % 1000000).padStart(6, "0");
    } while (meta.companions[pin]);
    meta.companions[pin] = { owner, name };
    await this.ctx.storage.put("meta", meta);
    return pin;
  }
  async _dropCompanions(meta, owner) {
    for (const s of this._sockets()) {
      if (s.a.companionOf === owner) {
        this._send(s.ws, { type: "room-closed", reason: "paired-left" });
        s.ws.serializeAttachment({ ...s.a, role: "gone" });
        try { s.ws.close(4004, "paired-left"); } catch {}
      }
    }
    if (meta.companions) {
      for (const [pin, e] of Object.entries(meta.companions)) if (e.owner === owner) delete meta.companions[pin];
      await this.ctx.storage.put("meta", meta);
    }
  }

  _sockets() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, a: ws.deserializeAttachment() || {} }));
  }
  _host() {
    return this._sockets().find((s) => s.a.role === "host");
  }
  _approved() {
    return this._sockets().filter((s) => s.a.role === "viewer" && s.a.state === "approved");
  }
  _watchers() {
    return this._approved().filter((s) => !s.a.companionOf); // paired phones don't count towards the limit
  }
  _pending() {
    return this._sockets().filter((s) => s.a.role === "viewer" && s.a.state === "pending");
  }
  _send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }
  _byId(id) {
    return this._sockets().find((s) => s.a.id === id);
  }

  _roster() {
    return {
      type: "roster",
      viewers: this._approved().map((s) => ({ id: s.a.id, name: s.a.name, photo: s.a.photo || null, userId: s.a.userId || null, companionOf: s.a.companionOf || null })),
      pending: this._pending().map((s) => ({ id: s.a.id, name: s.a.name, photo: s.a.photo || null })),
    };
  }

  async _pushRoster(meta) {
    const host = this._host();
    if (host) this._send(host.ws, { ...this._roster(), locked: meta.locked, maxViewers: meta.maxViewers });
    // Approved viewers get the full participant list so they can set up video calls with each other.
    const everyone = [
      ...(host ? [{ id: "host", name: meta.hostName, photo: host.a.photo || null, userId: host.a.userId || null, host: true }] : []),
      ...this._approved().map((s) => ({ id: s.a.id, name: s.a.name, photo: s.a.photo || null, userId: s.a.userId || null, companionOf: s.a.companionOf || null })),
    ];
    for (const v of this._approved()) {
      this._send(v.ws, { type: "peers", you: v.a.id, peers: everyone.filter((p) => p.id !== v.a.id) });
    }
  }

  async fetch(request) {
    const meta = await this._meta();
    if (!meta) return new Response("room closed", { status: 404 });
    const url = new URL(request.url);
    let who = null;
    try { who = JSON.parse(request.headers.get("X-Boxxie-User") || "null"); } catch {}
    const roleParam = url.searchParams.get("role");
    const role = roleParam === "host" ? "host" : roleParam === "companion" ? "companion" : "viewer";

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (role === "host") {
      // Only one host connection; a reconnect replaces the old one.
      const old = this._host();
      if (old) {
        old.ws.serializeAttachment({ ...old.a, role: "replaced" });
        try {
          old.ws.close(4000, "replaced");
        } catch {}
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: "host", role: "host", name: meta.hostName, state: "approved", userId: who && who.id, photo: who && who.photo });
      if (meta.hostGoneAt) {
        delete meta.hostGoneAt;
        await this.ctx.storage.put("meta", meta);
        await this.ctx.storage.setAlarm(meta.expiresAt);
      }
      this._send(server, { type: "welcome", role: "host", code: meta.code, iceServers: await iceServers(this.env) });
      await this._pushRoster(meta);
      // Tell already-approved viewers the host is back so they can renegotiate.
      for (const v of this._approved()) this._send(v.ws, { type: "host-back" });
      const host = this._host();
      if (host) for (const v of this._approved()) this._send(host.ws, { type: "viewer-ready", id: v.a.id, name: v.a.name, companionOf: v.a.companionOf || null });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === "companion") {
      const entry = (meta.companions || {})[String(url.searchParams.get("pin") || "")];
      if (!entry || !this._ownerOnline(entry.owner)) return new Response("not paired", { status: 404 });
      // One paired device per person: a new pairing replaces the old one.
      for (const s of this._sockets()) {
        if (s.a.companionOf === entry.owner) {
          this._send(s.ws, { type: "room-closed", reason: "paired-elsewhere" });
          s.ws.serializeAttachment({ ...s.a, role: "gone" });
          try { s.ws.close(4004, "replaced"); } catch {}
        }
      }
      this.ctx.acceptWebSocket(server);
      const id = randomId();
      server.serializeAttachment({ id, role: "viewer", name: entry.name, state: "approved", companionOf: entry.owner, userId: who && who.id });
      this._send(server, { type: "approved", companion: true, ownerName: entry.name, ownerId: entry.owner, iceServers: await iceServers(this.env) });
      const h = this._host();
      if (h) this._send(h.ws, { type: "viewer-ready", id, name: entry.name, companionOf: entry.owner });
      const ownerSock = entry.owner === "host" ? h : this._byId(entry.owner);
      if (ownerSock) this._send(ownerSock.ws, { type: "paired", id });
      await this._pushRoster(meta);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Viewer
    this.ctx.acceptWebSocket(server);
    const id = randomId();
    const name = cleanName(who ? who.name : url.searchParams.get("name"));

    if (meta.locked) {
      this._send(server, { type: "denied", reason: "locked" });
      server.close(4003, "locked");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this._pending().length >= MAX_PENDING) {
      this._send(server, { type: "denied", reason: "busy" });
      server.close(4003, "busy");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.serializeAttachment({ id, role: "viewer", name, state: "pending", userId: who && who.id, photo: who && who.photo });
    this._send(server, { type: "waiting", id, hostName: meta.hostName });
    // Invited friends skip the queue
    if (who && (meta.invited || []).includes(who.id)) {
      const me = this._byId(id);
      if (me) await this._approve(meta, me);
      return new Response(null, { status: 101, webSocket: client });
    }
    const host = this._host();
    if (host) this._send(host.ws, { type: "join-request", id, name, photo: who && who.photo });
    await this._pushRoster(meta);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const meta = await this._meta();
    if (!meta) {
      try {
        ws.close(4004, "closed");
      } catch {}
      return;
    }
    if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() || {};

    if (msg.type === "ping") return this._send(ws, { type: "pong" });

    // Host or an approved watcher (not a paired phone) asks for a pairing code for their phone.
    if (msg.type === "companion-code" && (a.role === "host" || (a.role === "viewer" && a.state === "approved" && !a.companionOf))) {
      const pin = await this._companionPin(meta, a.id, a.name);
      return this._send(ws, { type: "companion-code", pin });
    }

    // ----- host-only actions -----
    if (a.role === "host") {
      switch (msg.type) {
        case "approve": {
          const t = this._byId(msg.id);
          if (!t || t.a.state !== "pending") return;
          await this._approve(meta, t);
          return;
        }
        case "deny":
        case "kick": {
          const t = this._byId(msg.id);
          if (!t || t.a.role !== "viewer") return;
          this._send(t.ws, { type: "denied", reason: msg.type === "kick" ? "removed" : "denied" });
          t.ws.serializeAttachment({ ...t.a, role: "gone" });
          try {
            t.ws.close(4003, msg.type);
          } catch {}
          if (msg.type === "kick") this._send(ws, { type: "viewer-left", id: t.a.id });
          if (!t.a.companionOf) await this._dropCompanions(meta, t.a.id);
          return this._pushRoster(meta);
        }
        case "lock": {
          meta.locked = !!msg.locked;
          await this.ctx.storage.put("meta", meta);
          return this._pushRoster(meta);
        }
        case "end": {
          return this._close("ended");
        }
        case "signal": {
          const t = this._byId(msg.to);
          if (!t || t.a.role !== "viewer" || t.a.state !== "approved") return;
          return this._send(t.ws, { type: "signal", from: "host", data: msg.data });
        }
        case "chat":
          return this._broadcastChat({ name: a.name, text: msg.text, host: true, userId: a.userId });
      }
      return;
    }

    // ----- viewer actions (approved only) -----
    if (a.role === "viewer" && a.state === "approved") {
      const host = this._host();
      switch (msg.type) {
        case "signal": {
          // To the host, or to another approved viewer (for video calls).
          if (msg.to === "host" || !msg.to) {
            if (host) this._send(host.ws, { type: "signal", from: a.id, data: msg.data });
            return;
          }
          const t = this._byId(msg.to);
          if (t && t.a.role === "viewer" && t.a.state === "approved" && t.a.id !== a.id) {
            this._send(t.ws, { type: "signal", from: a.id, data: msg.data });
          }
          return;
        }
        case "chat":
          return this._broadcastChat({ name: a.name, text: msg.text, userId: a.userId });
        case "request-stream":
          if (host) this._send(host.ws, { type: "viewer-ready", id: a.id, name: a.name, companionOf: a.companionOf || null });
          return;
        case "remote": {
          // A paired phone works as the remote for its own TV or computer.
          if (!a.companionOf || !REMOTE_ACTIONS.has(msg.action)) return;
          const owner = a.companionOf === "host" ? host : this._byId(a.companionOf);
          if (owner) this._send(owner.ws, { type: "remote", action: msg.action });
          return;
        }
      }
    }
  }

  _broadcastChat({ name, text, host, system, userId }) {
    const clean = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX_CHAT);
    if (!clean) return;
    const msg = { type: "chat", name: name || "", text: clean, host: !!host, system: !!system, userId: userId || null, at: Date.now() };
    const h = this._host();
    if (h) this._send(h.ws, msg);
    for (const v of this._approved()) this._send(v.ws, msg);
  }

  async webSocketClose(ws) {
    await this._left(ws);
  }
  async webSocketError(ws) {
    await this._left(ws);
  }

  async _left(ws) {
    const a = ws.deserializeAttachment() || {};
    const meta = await this.ctx.storage.get("meta");
    if (!meta || meta.closed) return;
    if (a.role === "host") {
      // Give the host a few minutes to reconnect (e.g. TV Wi-Fi blip).
      meta.hostGoneAt = Date.now();
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
      for (const v of this._approved()) this._send(v.ws, { type: "host-away" });
    } else if (a.role === "viewer") {
      const host = this._host();
      if (host) this._send(host.ws, { type: "viewer-left", id: a.id });
      if (a.state === "approved" && !a.companionOf) this._broadcastChat({ system: true, text: `${a.name} left` });
      // the closing socket may still be listed; push roster after it is gone
      ws.serializeAttachment({ ...a, role: "gone" });
      if (a.state === "approved" && !a.companionOf) await this._dropCompanions(meta, a.id);
      await this._pushRoster(meta);
    }
  }

  async alarm() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return;
    const now = Date.now();
    if (now >= meta.expiresAt) return this._close("expired");
    if (meta.hostGoneAt && !this._host() && now - meta.hostGoneAt >= HOST_GRACE_MS) {
      return this._close("host-left");
    }
    await this.ctx.storage.setAlarm(meta.hostGoneAt ? meta.hostGoneAt + HOST_GRACE_MS : meta.expiresAt);
  }

  async _close(reason) {
    for (const s of this._sockets()) {
      this._send(s.ws, { type: "room-closed", reason });
      try {
        s.ws.close(4004, reason);
      } catch {}
    }
    // Keep a tombstone until expiry so the code can't be reused by someone else.
    const meta = await this.ctx.storage.get("meta");
    await this.ctx.storage.deleteAll();
    if (meta && Date.now() < meta.expiresAt) {
      await this.ctx.storage.put("meta", { code: meta.code, closed: true, expiresAt: meta.expiresAt });
      await this.ctx.storage.setAlarm(meta.expiresAt);
    }
  }
}
