// Boxxie Share accounts: sign in with Google, Facebook or an emailed link/code.
// TVs (and the Android app) sign in by scanning a QR code with a signed-in phone,
// because Google and Facebook block their sign-in pages inside apps.
//
// Everything is stored in one Durable Object ("Directory") using the free-plan storage.
// Secrets (session tokens, sign-in links, codes) are only ever stored as SHA-256 hashes.

import { DurableObject } from "cloudflare:workers";

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 60 * DAY;
const TICKET_TTL = 60 * 1000; // one-use pass to open a room connection
const STATE_TTL = 10 * 60 * 1000; // Google/Facebook round trip
const HANDOFF_TTL = 2 * 60 * 1000; // one-use code passed back to the web app after Google/Facebook
const MAGIC_TTL = 15 * 60 * 1000; // emailed link + 6-digit code
const DEVICE_TTL = 10 * 60 * 1000; // TV sign-in by QR
const MAX_NAME = 40;
const DEVICE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // no vowels → no accidental words

// ---------- small helpers ----------
const enc = new TextEncoder();
export function randomHex(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(text));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}
function randomDigits(n) {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 10 ** n).padStart(n, "0");
}
function randomFrom(alphabet, n) {
  const out = [];
  const b = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(b);
    for (const x of b) if (x < 256 - (256 % alphabet.length) && out.length < n) out.push(alphabet[x % alphabet.length]);
  }
  return out.join("");
}
export function cleanEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[a-z]{2,24}$/.test(s) ? s : null;
}
function cleanDisplayName(n, fallback = "Friend") {
  const s = String(n || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, MAX_NAME);
  return s || fallback;
}
function cleanPhoto(u) {
  try {
    const url = new URL(String(u || ""));
    return url.protocol === "https:" ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
async function adminSig(env, userId) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.ADMIN_TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("ban:" + userId));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// "BOXX-7F3K-9QPL-22MD" → "7F3K9QPL22MD" (spaces, dashes, lower case and the BOXX prefix are all fine)
function normaliseSigninCode(c) {
  let s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 16 && s.startsWith("BOXX")) s = s.slice(4);
  return /^[B-DF-HJ-NP-TV-XZ2-9]{12}$/.test(s) ? s : null;
}
// ---------- authenticator apps (TOTP, RFC 6238: Google Authenticator, Microsoft, Apple Passwords) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(str) {
  const out = [];
  let bits = 0, val = 0;
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totpAt(secret, counter) {
  const key = await crypto.subtle.importKey("raw", unbase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, "0");
}
// Returns the matching time step (so it can't be used twice), or null. Allows 30 s either side.
export async function totpCheck(secret, code, now = Date.now()) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if ((await totpAt(secret, step + d)) === c) return step + d;
  return null;
}
export { totpAt };

function normaliseFriendCode(c) {
  const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[B-DF-HJ-NP-TV-XZ2-9]{8}$/.test(s) ? s : null;
}
function publicUser(u) {
  return u ? { id: u.id, name: u.name, photo: u.photo || null } : null;
}

// Which sign-in options are switched on (by setting their keys as Worker secrets/vars)
export function providers(env) {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    facebook: !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET),
    email: !!(env.EMAIL_PROVIDER && (env.EMAIL_PROVIDER === "log" ? env.DEV === "1" : env.EMAIL_API_KEY && env.EMAIL_FROM)),
    code: env.CODE_SIGNIN !== "0", // Boxxie codes: no outside service needed
  };
}

// Provider endpoints (overridable only in local development, for the test suite)
function endpoints(env) {
  const dev = env.DEV === "1";
  const v = env.FACEBOOK_GRAPH_VERSION || "v26.0";
  return {
    googleAuth: (dev && env.DEV_GOOGLE_AUTH) || "https://accounts.google.com/o/oauth2/v2/auth",
    googleToken: (dev && env.DEV_GOOGLE_TOKEN) || "https://oauth2.googleapis.com/token",
    googleUser: (dev && env.DEV_GOOGLE_USER) || "https://openidconnect.googleapis.com/v1/userinfo",
    fbAuth: (dev && env.DEV_FB_AUTH) || `https://www.facebook.com/${v}/dialog/oauth`,
    fbToken: (dev && env.DEV_FB_TOKEN) || `https://graph.facebook.com/${v}/oauth/access_token`,
    fbUser: (dev && env.DEV_FB_USER) || `https://graph.facebook.com/${v}/me`,
  };
}

// ---------- email ----------
async function sendEmail(env, dir, { to, subject, text, html }) {
  if (env.EMAIL_PROVIDER === "log" && env.DEV === "1") {
    await dir.devStoreMail(to, { subject, text });
    return true;
  }
  const fromRaw = String(env.EMAIL_FROM || "");
  const m = fromRaw.match(/^(.*)<([^>]+)>$/);
  const fromName = (m ? m[1] : "Boxxie Share").trim() || "Boxxie Share";
  const fromEmail = (m ? m[2] : fromRaw).trim();
  let res;
  if (env.EMAIL_PROVIDER === "brevo") {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.EMAIL_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
  } else if (env.EMAIL_PROVIDER === "resend") {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [to], subject, text, html }),
    });
  } else {
    return false;
  }
  return res.ok;
}
function emailHtml(title, lines, button) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html><body style="margin:0;background:#142130;font-family:Arial,Helvetica,sans-serif;color:#f6f1ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#1b2b3d;border-radius:14px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<div style="font-size:22px;font-weight:bold;margin:0 0 4px"><span style="color:#f6aea0">b</span><span style="color:#59c0d0">o</span><span style="color:#00b2c9">xx</span><span style="color:#59c0d0">i</span><span style="color:#00afb5">e</span> <span style="font-weight:normal">share</span></div>
<h1 style="font-size:20px;margin:18px 0 12px">${esc(title)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5;color:#b0bfd1;margin:0 0 12px">${l}</p>`).join("")}
${button ? `<p style="margin:20px 0"><a href="${esc(button.href)}" style="background:#e97684;color:#2a0f14;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">${esc(button.label)}</a></p>` : ""}
<p style="font-size:12px;color:#8193a8;margin:18px 0 0">If you didn't ask for this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

// ---------- the Directory (one object holds all accounts) ----------
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  // --- tiny key/value helpers with expiry ---
  async _get(key) {
    const v = await this.ctx.storage.get(key);
    if (v && v.expires && v.expires < Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return v || null;
  }
  async _take(key) {
    const v = await this._get(key);
    if (v) await this.ctx.storage.delete(key);
    return v;
  }

  // --- users ---
  async _user(id) {
    return (await this.ctx.storage.get(`user:${id}`)) || null;
  }
  async _saveUser(u) {
    await this.ctx.storage.put(`user:${u.id}`, u);
  }
  // Find or create the account for a verified sign-in. Same verified email → same account.
  async _upsertIdentity({ provider, subject, email, name, photo }) {
    const identKey = `ident:${provider}:${subject}`;
    let id = await this.ctx.storage.get(identKey);
    if (!id && email) id = await this.ctx.storage.get(`email:${email}`);
    let user = id ? await this._user(id) : null;
    if (!user) {
      user = { id: randomHex(12), email: email || null, name: cleanDisplayName(name, email ? email.split("@")[0] : "Friend"), photo: cleanPhoto(photo), created: Date.now() };
      if (email) await this.ctx.storage.put(`email:${email}`, user.id);
      // Friend requests that were sent to this email before they had an account
      if (email) {
        const waiting = (await this.ctx.storage.get(`pendingByEmail:${email}`)) || [];
        for (const fromId of waiting) await this._setFriend(fromId, user.id, "pending", fromId);
        await this.ctx.storage.delete(`pendingByEmail:${email}`);
      }
    } else {
      if (!user.photo && photo) user.photo = cleanPhoto(photo);
      if (!user.email && email) {
        const taken = await this.ctx.storage.get(`email:${email}`);
        if (!taken) {
          user.email = email;
          await this.ctx.storage.put(`email:${email}`, user.id);
        }
      }
    }
    user.idents = [...new Set([...(user.idents || []), identKey])];
    await this._saveUser(user);
    await this.ctx.storage.put(identKey, user.id);
    return user;
  }

  // --- Boxxie codes: your own sign-in code, no email or outside service needed ---
  async createCodeAccount(name, label) {
    const user = { id: randomHex(12), email: null, name: cleanDisplayName(name, "Friend"), photo: null, created: Date.now(), idents: [] };
    await this._saveUser(user);
    const code = await this._newSigninCode(user);
    await this._friendCode(user);
    return { token: await this._newSession(user.id, label), user: publicUser(user), code };
  }
  async _newSigninCode(user) {
    if (user.codeHash) await this.ctx.storage.delete(`signin:${user.codeHash}`);
    const raw = randomFrom(DEVICE_ALPHABET, 12);
    user.codeHash = await sha256("signin:" + raw);
    await this.ctx.storage.put(`signin:${user.codeHash}`, user.id);
    await this._saveUser(user);
    return `BOXX-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  }
  async signInWithCode(code, label, otp) {
    const raw = normaliseSigninCode(code);
    if (!raw) return { error: "wrong_code" };
    const id = await this.ctx.storage.get(`signin:${await sha256("signin:" + raw)}`);
    const user = id ? await this._user(id) : null;
    if (!user || user.banned) return { error: "wrong_code" };
    if (user.totp) {
      // Extra lock switched on: the code from their authenticator app is needed too.
      if (!otp) return { needOtp: true };
      const now = Date.now();
      const fails = (user.otpFails || []).filter((t) => now - t < 15 * 60 * 1000);
      if (fails.length >= 10) return { error: "too_many_attempts" };
      const step = await totpCheck(user.totp, otp, now);
      if (step === null || step <= (user.totpLast || 0)) {
        user.otpFails = [...fails, now];
        await this._saveUser(user);
        return { error: "wrong_otp" };
      }
      user.totpLast = step;
      user.otpFails = [];
      await this._saveUser(user);
    }
    return { token: await this._newSession(user.id, label), user: publicUser(user) };
  }
  async totpSetup(userId) {
    const u = await this._user(userId);
    if (!u) return null;
    const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
    await this.ctx.storage.put(`totppending:${userId}`, { secret, expires: Date.now() + 15 * 60 * 1000 });
    const label = encodeURIComponent(`Boxxie Share:${u.name}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Boxxie%20Share&algorithm=SHA1&digits=6&period=30` };
  }
  async totpConfirm(userId, code) {
    const u = await this._user(userId);
    const pend = await this._get(`totppending:${userId}`);
    if (!u || !pend) return { error: "expired" };
    const step = await totpCheck(pend.secret, code);
    if (step === null) return { error: "wrong_otp" };
    u.totp = pend.secret;
    u.totpLast = step;
    await this._saveUser(u);
    await this.ctx.storage.delete(`totppending:${userId}`);
    return { ok: true };
  }
  async totpDisable(userId, code) {
    const u = await this._user(userId);
    if (!u || !u.totp) return { ok: true };
    if ((await totpCheck(u.totp, code)) === null) return { error: "wrong_otp" };
    delete u.totp;
    delete u.totpLast;
    await this._saveUser(u);
    return { ok: true };
  }
  async resetSigninCode(userId) {
    const u = await this._user(userId);
    return u ? this._newSigninCode(u) : null;
  }
  async _friendCode(user) {
    if (user.friendCode) return user.friendCode;
    let c;
    do c = randomFrom(DEVICE_ALPHABET, 8);
    while (await this.ctx.storage.get(`friendcode:${c}`));
    user.friendCode = c;
    await this.ctx.storage.put(`friendcode:${c}`, user.id);
    await this._saveUser(user);
    return c;
  }

  // --- sessions ---
  async _newSession(userId, label) {
    const token = randomHex(32);
    await this.ctx.storage.put(`sess:${await sha256(token)}`, { userId, label: String(label || "").slice(0, 60), created: Date.now(), expires: Date.now() + SESSION_TTL });
    return token;
  }
  async whoami(token) {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const s = await this._get(`sess:${await sha256(token)}`);
    if (!s) return null;
    const u = await this._user(s.userId);
    if (!u || u.banned) return null; // banned accounts can't do anything
    return u;
  }
  async signOut(token) {
    if (token) await this.ctx.storage.delete(`sess:${await sha256(token)}`);
    return true;
  }

  // --- Google / Facebook round trip ---
  async newState(provider, returnTo, verifier) {
    const state = randomHex(16);
    await this.ctx.storage.put(`state:${state}`, { provider, returnTo, verifier, expires: Date.now() + STATE_TTL });
    return state;
  }
  async takeState(state) {
    if (!/^[0-9a-f]{32}$/.test(String(state || ""))) return null;
    return this._take(`state:${state}`);
  }
  async finishOAuth(identity) {
    const user = await this._upsertIdentity(identity);
    const code = randomHex(24);
    await this.ctx.storage.put(`handoff:${await sha256(code)}`, { userId: user.id, expires: Date.now() + HANDOFF_TTL });
    return code;
  }
  async exchange(code, label) {
    if (!/^[0-9a-f]{48}$/.test(String(code || ""))) return null;
    const h = await this._take(`handoff:${await sha256(code)}`);
    if (!h) return null;
    return { token: await this._newSession(h.userId, label), user: publicUser(await this._user(h.userId)) };
  }

  // --- email link + code ---
  async startMagic(email, returnTo, fixedCode) {
    // At most 3 emails per address per 15 minutes
    const key = `mailrate:${email}`;
    const now = Date.now();
    const sent = ((await this.ctx.storage.get(key)) || []).filter((t) => now - t < MAGIC_TTL);
    if (sent.length >= 3) return { limited: true };
    sent.push(now);
    await this.ctx.storage.put(key, sent);
    const token = randomHex(24);
    const code = fixedCode || randomDigits(6);
    const rec = { email, codeHash: await sha256(`${email}:${code}`), tries: 0, expires: now + MAGIC_TTL, tokenHash: await sha256(token) };
    await this.ctx.storage.put(`magic:${rec.tokenHash}`, rec);
    await this.ctx.storage.put(`magiccode:${email}`, rec);
    return { token, code };
  }
  async verifyMagic({ token, email, code }, label) {
    let rec = null;
    if (token && /^[0-9a-f]{48}$/.test(String(token))) {
      rec = await this._get(`magic:${await sha256(token)}`);
    } else if (email && /^\d{6}$/.test(String(code || ""))) {
      rec = await this._get(`magiccode:${email}`);
      if (rec) {
        rec.tries = (rec.tries || 0) + 1;
        if (rec.tries > 5) {
          await this.ctx.storage.delete(`magiccode:${email}`);
          await this.ctx.storage.delete(`magic:${rec.tokenHash}`);
          return { error: "too_many_tries" };
        }
        await this.ctx.storage.put(`magiccode:${email}`, rec);
        if (rec.codeHash !== (await sha256(`${email}:${code}`))) return { error: "wrong_code" };
      }
    }
    if (!rec) return { error: "expired" };
    await this.ctx.storage.delete(`magic:${rec.tokenHash}`);
    await this.ctx.storage.delete(`magiccode:${rec.email}`);
    const local = rec.email.split("@")[0].split("+")[0].replace(/[._-]+/g, " ").trim();
    const nice = local.replace(/\b\w/g, (c) => c.toUpperCase()) || "Friend";
    const user = await this._upsertIdentity({ provider: "email", subject: rec.email, email: rec.email, name: nice });
    return { token: await this._newSession(user.id, label), user: publicUser(user) };
  }

  // --- TV sign-in by QR ---
  async deviceStart(label) {
    const deviceCode = randomHex(24);
    let userCode;
    do userCode = randomFrom(DEVICE_ALPHABET, 8);
    while (await this._get(`devuser:${userCode}`));
    const rec = { deviceHash: await sha256(deviceCode), userCode, label: String(label || "TV").slice(0, 60), userId: null, expires: Date.now() + DEVICE_TTL };
    await this.ctx.storage.put(`device:${rec.deviceHash}`, rec);
    await this.ctx.storage.put(`devuser:${userCode}`, { deviceHash: rec.deviceHash, label: rec.label, expires: rec.expires });
    return { deviceCode, userCode, expiresIn: DEVICE_TTL / 1000 };
  }
  async deviceInfo(userCode) {
    const d = await this._get(`devuser:${String(userCode || "").toUpperCase()}`);
    return d ? { label: d.label } : null;
  }
  async deviceApprove(userCode, userId) {
    const code = String(userCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const d = await this._take(`devuser:${code}`);
    if (!d) return false;
    const rec = await this._get(`device:${d.deviceHash}`);
    if (!rec) return false;
    rec.userId = userId;
    await this.ctx.storage.put(`device:${d.deviceHash}`, rec);
    return true;
  }
  async devicePoll(deviceCode) {
    if (!/^[0-9a-f]{48}$/.test(String(deviceCode || ""))) return { error: "expired" };
    const key = `device:${await sha256(deviceCode)}`;
    const rec = await this._get(key);
    if (!rec) return { error: "expired" };
    if (!rec.userId) return { pending: true };
    await this.ctx.storage.delete(key);
    return { token: await this._newSession(rec.userId, rec.label), user: publicUser(await this._user(rec.userId)) };
  }

  // --- tickets: a 60-second, one-use pass to open a room connection ---
  async newTicket(userId) {
    const t = randomHex(24);
    await this.ctx.storage.put(`ticket:${await sha256(t)}`, { userId, expires: Date.now() + TICKET_TTL });
    return t;
  }
  async useTicket(t) {
    if (!/^[0-9a-f]{48}$/.test(String(t || ""))) return null;
    const rec = await this._take(`ticket:${await sha256(t)}`);
    return rec ? publicUser(await this._user(rec.userId)) : null;
  }

  // --- profile ---
  async rename(userId, name) {
    const u = await this._user(userId);
    if (!u) return null;
    u.name = cleanDisplayName(name, u.name);
    await this._saveUser(u);
    return publicUser(u);
  }

  // --- delete an account and everything about it ---
  async deleteUser(userId) {
    const u = await this._user(userId);
    if (!u) return false;
    const m = await this._friendsMap(userId);
    for (const other of Object.keys(m)) {
      const mo = await this._friendsMap(other);
      delete mo[userId];
      await this.ctx.storage.put(`friends:${other}`, mo);
      this._notify(other, { type: "friends-changed" });
    }
    for (const k of u.idents || []) await this.ctx.storage.delete(k);
    if (u.email) {
      await this.ctx.storage.delete(`email:${u.email}`);
      await this.ctx.storage.delete(`pendingByEmail:${u.email}`);
    }
    await this.ctx.storage.delete(`friends:${userId}`);
    await this.ctx.storage.delete(`blocks:${userId}`);
    if (u.codeHash) await this.ctx.storage.delete(`signin:${u.codeHash}`);
    if (u.friendCode) await this.ctx.storage.delete(`friendcode:${u.friendCode}`);
    await this.ctx.storage.delete(`invites:${userId}`);
    await this.ctx.storage.delete(`user:${userId}`); // sessions stop working: they point at a missing account
    for (const ws of this.ctx.getWebSockets(userId)) try { ws.close(4001, "deleted"); } catch {}
    return true;
  }

  // --- friends ---
  // friends:<id> = { otherId: { status: "friends" | "outgoing" | "incoming", since } }
  async _friendsMap(id) {
    return (await this.ctx.storage.get(`friends:${id}`)) || {};
  }
  async _setFriend(a, b, status, requester) {
    if (a === b) return;
    const ma = await this._friendsMap(a);
    const mb = await this._friendsMap(b);
    if (status === "pending") {
      if (ma[b] && ma[b].status === "friends") return;
      if (ma[b] && ma[b].status === "incoming") {
        // they had already asked us → now friends
        ma[b] = { status: "friends", since: Date.now() };
        mb[a] = { status: "friends", since: Date.now() };
      } else {
        ma[b] = { status: requester === a ? "outgoing" : "incoming", since: Date.now() };
        mb[a] = { status: requester === a ? "incoming" : "outgoing", since: Date.now() };
      }
    } else if (status === "friends") {
      ma[b] = { status: "friends", since: Date.now() };
      mb[a] = { status: "friends", since: Date.now() };
    } else {
      delete ma[b];
      delete mb[a];
    }
    await this.ctx.storage.put(`friends:${a}`, ma);
    await this.ctx.storage.put(`friends:${b}`, mb);
    this._notify(a, { type: "friends-changed" });
    this._notify(b, { type: "friends-changed" });
  }
  // --- blocking: no friend requests, invites, room joins or chat between you ---
  // blocks:<id> = { otherId: { at, name } }
  async _blocks(id) {
    return (await this.ctx.storage.get(`blocks:${id}`)) || {};
  }
  async block(userId, otherId) {
    if (!otherId || otherId === userId) return false;
    const other = await this._user(otherId);
    if (!other) return false;
    const b = await this._blocks(userId);
    b[otherId] = { at: Date.now(), name: other.name };
    await this.ctx.storage.put(`blocks:${userId}`, b);
    await this._setFriend(userId, otherId, "remove");
    // drop any room invites between you
    for (const [a, z] of [[userId, otherId], [otherId, userId]]) {
      const list = ((await this.ctx.storage.get(`invites:${a}`)) || []).filter((i) => !(i.from && i.from.id === z));
      await this.ctx.storage.put(`invites:${a}`, list);
    }
    this._notify(userId, { type: "friends-changed" });
    return true;
  }
  async unblock(userId, otherId) {
    const b = await this._blocks(userId);
    delete b[otherId];
    await this.ctx.storage.put(`blocks:${userId}`, b);
    this._notify(userId, { type: "friends-changed" });
    return true;
  }
  async blockedEither(a, b) {
    if (!a || !b || a === b) return false;
    return !!((await this._blocks(a))[b] || (await this._blocks(b))[a]);
  }

  // --- reports: saved, and emailed to the app owner for a timely response ---
  async report(reporterId, { userId, room, reason, details, messages }) {
    const now = Date.now();
    const rk = `reportrate:${reporterId}`;
    const recent = ((await this.ctx.storage.get(rk)) || []).filter((t) => now - t < DAY);
    if (recent.length >= 20) return { error: "too_many" };
    recent.push(now);
    await this.ctx.storage.put(rk, recent);
    const reporter = await this._user(reporterId);
    const target = userId ? await this._user(userId) : null;
    const rep = {
      id: randomHex(8),
      at: now,
      reporter: reporter ? { id: reporter.id, name: reporter.name, email: reporter.email || null } : { id: reporterId },
      target: target ? { id: target.id, name: target.name, email: target.email || null } : null,
      room: String(room || "").slice(0, 16),
      reason: String(reason || "other").slice(0, 40),
      details: String(details || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 2000),
      messages: (Array.isArray(messages) ? messages : []).slice(-20).map((m) => String(m).slice(0, 500)),
      status: "open",
    };
    await this.ctx.storage.put(`report:${now}:${rep.id}`, rep);
    return { report: rep };
  }
  async listReports(limit = 50) {
    const all = await this.ctx.storage.list({ prefix: "report:", reverse: true, limit });
    return [...all.values()];
  }
  async ban(userId, banned) {
    const u = await this._user(userId);
    if (!u) return false;
    u.banned = !!banned;
    await this._saveUser(u);
    if (u.banned) for (const ws of this.ctx.getWebSockets(userId)) try { ws.close(4001, "banned"); } catch {}
    return true;
  }

  async _friendRate(userId) {
    const rk = `friendrate:${userId}`;
    const now = Date.now();
    const recent = ((await this.ctx.storage.get(rk)) || []).filter((t) => now - t < DAY);
    if (recent.length >= 30) return false;
    recent.push(now);
    await this.ctx.storage.put(rk, recent);
    return true;
  }
  async addFriendByCode(userId, code) {
    const me = await this._user(userId);
    if (!me) return { error: "no_user" };
    const c = normaliseFriendCode(code);
    if (!c) return { error: "bad_code" };
    if (!(await this._friendRate(userId))) return { error: "too_many" };
    const otherId = await this.ctx.storage.get(`friendcode:${c}`);
    if (!otherId) return { error: "no_such_code" };
    if (otherId === userId) return { error: "self" };
    if (await this.blockedEither(userId, otherId)) return { status: "outgoing" };
    await this._setFriend(userId, otherId, "pending", userId);
    const m = await this._friendsMap(userId);
    return { status: m[otherId] ? m[otherId].status : "outgoing" };
  }

  async addFriend(userId, email) {
    const me = await this._user(userId);
    if (!me) return { error: "no_user" };
    if (me.email && me.email === email) return { error: "self" };
    // limit: 30 requests a day per person
    const rk = `friendrate:${userId}`;
    const now = Date.now();
    const recent = ((await this.ctx.storage.get(rk)) || []).filter((t) => now - t < DAY);
    if (recent.length >= 30) return { error: "too_many" };
    recent.push(now);
    await this.ctx.storage.put(rk, recent);
    const otherId = await this.ctx.storage.get(`email:${email}`);
    // Blocked either way: reply as if it worked, but don't send anything.
    if (otherId && (await this.blockedEither(userId, otherId))) return { status: "outgoing", hadAccount: true };
    if (otherId) {
      await this._setFriend(userId, otherId, "pending", userId);
      const m = await this._friendsMap(userId);
      return { status: m[otherId] ? m[otherId].status : "outgoing", hadAccount: true };
    }
    const waiting = (await this.ctx.storage.get(`pendingByEmail:${email}`)) || [];
    if (!waiting.includes(userId)) waiting.push(userId);
    await this.ctx.storage.put(`pendingByEmail:${email}`, waiting.slice(-50));
    return { status: "invited", hadAccount: false, fromName: me.name };
  }
  async respondFriend(userId, otherId, accept) {
    const m = await this._friendsMap(userId);
    if (!m[otherId] || m[otherId].status !== "incoming") return false;
    await this._setFriend(userId, otherId, accept ? "friends" : "remove");
    return true;
  }
  async removeFriend(userId, otherId) {
    await this._setFriend(userId, otherId, "remove");
    return true;
  }
  async areFriends(a, b) {
    const m = await this._friendsMap(a);
    return !!(m[b] && m[b].status === "friends");
  }
  async me(userId) {
    const u = await this._user(userId);
    if (!u) return null;
    const m = await this._friendsMap(userId);
    const friends = [];
    for (const [id, f] of Object.entries(m)) {
      const o = await this._user(id);
      if (o) friends.push({ ...publicUser(o), status: f.status });
    }
    friends.sort((x, y) => (x.status === y.status ? x.name.localeCompare(y.name) : x.status === "incoming" ? -1 : y.status === "incoming" ? 1 : x.status === "friends" ? -1 : 1));
    const invites = ((await this.ctx.storage.get(`invites:${userId}`)) || []).filter((i) => i.expires > Date.now());
    const blocked = Object.entries(await this._blocks(userId)).map(([id, b]) => ({ id, name: b.name }));
    const friendCode = await this._friendCode(u);
    return { user: { ...publicUser(u), email: u.email, friendCode, hasCode: !!u.codeHash, totp: !!u.totp }, friends, invites, blocked };
  }

  // --- room invites ---
  async inviteToRoom(fromId, toIds, room) {
    const from = await this._user(fromId);
    if (!from) return [];
    const sent = [];
    for (const to of toIds.slice(0, 20)) {
      if (!(await this.areFriends(fromId, to)) || (await this.blockedEither(fromId, to))) continue;
      const list = ((await this.ctx.storage.get(`invites:${to}`)) || []).filter((i) => i.expires > Date.now() && i.code !== room.code);
      const inv = { code: room.code, from: publicUser(from), expires: room.expiresAt, at: Date.now() };
      list.unshift(inv);
      await this.ctx.storage.put(`invites:${to}`, list.slice(0, 10));
      this._notify(to, { type: "invite", invite: inv });
      sent.push(to);
    }
    return sent;
  }
  async dropInvite(userId, code) {
    const list = ((await this.ctx.storage.get(`invites:${userId}`)) || []).filter((i) => i.code !== code && i.expires > Date.now());
    await this.ctx.storage.put(`invites:${userId}`, list);
    return true;
  }

  // --- live notifications (the home screen stays connected while open) ---
  async fetch(request) {
    const userId = request.headers.get("X-Boxxie-User-Id");
    if (!userId) return new Response("no", { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].serializeAttachment({ userId });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  _notify(userId, msg) {
    for (const ws of this.ctx.getWebSockets(userId)) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
  async webSocketMessage(ws, raw) {
    if (raw === '{"type":"ping"}') try { ws.send('{"type":"pong"}'); } catch {}
  }
  async webSocketClose() {}

  // --- development only: read back the last email "sent" ---
  async devStoreMail(to, mail) {
    await this.ctx.storage.put(`devmail:${to}`, mail);
  }
  async devReadMail(to) {
    return (await this.ctx.storage.get(`devmail:${to}`)) || null;
  }
}

// ---------- HTTP routes for accounts ----------
// Returns a Response, or null when the path isn't an accounts route.
export async function handleAccounts(request, env, ctx) {
  const { url, json, redirectAllowed, limiter, ip, serverBase } = ctx;
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
  const p = url.pathname;
  const body = async () => {
    try {
      return await request.json();
    } catch {
      return {};
    }
  };
  const bearer = () => (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const requireUser = async () => dir.whoami(bearer());
  const label = () => String(request.headers.get("User-Agent") || "").slice(0, 60);
  const E = endpoints(env);
  const prov = providers(env);

  if (p === "/auth/providers" && request.method === "GET") return json(prov, 200);

  // ----- Google -----
  if (p === "/auth/google/start" && request.method === "GET") {
    if (!prov.google) return json({ error: "not_configured" }, 404);
    const ret = url.searchParams.get("return") || "";
    if (!redirectAllowed(ret)) return json({ error: "bad_return" }, 400);
    const { verifier, challenge } = await pkce();
    const state = await dir.newState("google", ret, verifier);
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${serverBase}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return Response.redirect(`${E.googleAuth}?${q}`, 302);
  }
  if (p === "/auth/google/callback" && request.method === "GET") {
    const st = await dir.takeState(url.searchParams.get("state"));
    if (!st || st.provider !== "google") return json({ error: "expired" }, 400);
    const back = (frag) => Response.redirect(`${st.returnTo.split("#")[0]}#${frag}`, 302);
    const code = url.searchParams.get("code");
    if (!code) return back("login_error=cancelled");
    const tok = await fetch(E.googleToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${serverBase}/auth/google/callback`, grant_type: "authorization_code", code_verifier: st.verifier,
      }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!tok || !tok.access_token) return back("login_error=google");
    const info = await fetch(E.googleUser, { headers: { Authorization: `Bearer ${tok.access_token}` } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!info || !info.sub) return back("login_error=google");
    const email = info.email_verified ? cleanEmail(info.email) : null;
    const handoff = await dir.finishOAuth({ provider: "google", subject: String(info.sub), email, name: info.name, photo: info.picture });
    return back(`login=${handoff}`);
  }

  // ----- Facebook -----
  if (p === "/auth/facebook/start" && request.method === "GET") {
    if (!prov.facebook) return json({ error: "not_configured" }, 404);
    const ret = url.searchParams.get("return") || "";
    if (!redirectAllowed(ret)) return json({ error: "bad_return" }, 400);
    const state = await dir.newState("facebook", ret, null);
    const q = new URLSearchParams({
      client_id: env.FACEBOOK_APP_ID, redirect_uri: `${serverBase}/auth/facebook/callback`,
      state, response_type: "code", scope: "public_profile,email",
    });
    return Response.redirect(`${E.fbAuth}?${q}`, 302);
  }
  if (p === "/auth/facebook/callback" && request.method === "GET") {
    const st = await dir.takeState(url.searchParams.get("state"));
    if (!st || st.provider !== "facebook") return json({ error: "expired" }, 400);
    const back = (frag) => Response.redirect(`${st.returnTo.split("#")[0]}#${frag}`, 302);
    const code = url.searchParams.get("code");
    if (!code) return back("login_error=cancelled");
    const tq = new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: `${serverBase}/auth/facebook/callback`, code });
    const tok = await fetch(`${E.fbToken}?${tq}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!tok || !tok.access_token) return back("login_error=facebook");
    const proof = await hmacHex(env.FACEBOOK_APP_SECRET, tok.access_token);
    const uq = new URLSearchParams({ fields: "id,name,email,picture.width(200).height(200)", access_token: tok.access_token, appsecret_proof: proof });
    const info = await fetch(`${E.fbUser}?${uq}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!info || !info.id) return back("login_error=facebook");
    const photo = info.picture && info.picture.data && !info.picture.data.is_silhouette ? info.picture.data.url : null;
    const handoff = await dir.finishOAuth({ provider: "facebook", subject: String(info.id), email: cleanEmail(info.email), name: info.name, photo });
    return back(`login=${handoff}`);
  }

  // ----- hand-off after Google/Facebook → a session for the app -----
  if (p === "/auth/exchange" && request.method === "POST") {
    const b = await body();
    const r = await dir.exchange(b.code, label());
    if (!r) {
      await limiter.hit("joinfail", 8, 15 * 60 * 1000);
      return json({ error: "expired" }, 400);
    }
    return json(r, 200);
  }

  // ----- email link + code -----
  if (p === "/auth/email/start" && request.method === "POST") {
    if (!prov.email) return json({ error: "not_configured" }, 404);
    if (!(await limiter.hit("mail", 10, 60 * 60 * 1000))) return json({ error: "too_many" }, 429);
    const b = await body();
    const email = cleanEmail(b.email);
    if (!email) return json({ error: "bad_email" }, 400);
    const ret = String(b.return || "");
    if (!redirectAllowed(ret)) return json({ error: "bad_return" }, 400);
    // App store reviewers can't read our emails: an optional review account signs in with a
    // fixed 6-digit code (Worker secrets REVIEW_EMAIL and REVIEW_CODE). Off unless both are set.
    const review = env.REVIEW_EMAIL && /^\d{6}$/.test(String(env.REVIEW_CODE || "")) && email === cleanEmail(env.REVIEW_EMAIL);
    const r = await dir.startMagic(email, ret, review ? String(env.REVIEW_CODE) : undefined);
    if (r.limited) return json({ error: "too_many" }, 429);
    if (review) return json({ ok: true }, 200);
    const link = `${ret.split("#")[0]}#magic=${r.token}`;
    const ok = await sendEmail(env, dir, {
      to: email,
      subject: `Your Boxxie Share sign-in code: ${r.code}`,
      text: `Sign in to Boxxie Share\n\nYour code is ${r.code}\n\nOr open this link: ${link}\n\nIt works for 15 minutes. If you didn't ask for this, ignore this email.`,
      html: emailHtml("Sign in to Boxxie Share", [`Your code is <b style="color:#efcb99;font-size:20px;letter-spacing:2px">${r.code}</b>`, "Or press the button. It works for 15 minutes."], { href: link, label: "Sign in" }),
    });
    if (!ok) return json({ error: "email_failed" }, 502);
    return json({ ok: true }, 200);
  }
  // ----- Boxxie codes -----
  if (p === "/auth/code/create" && request.method === "POST") {
    if (!prov.code) return json({ error: "not_configured" }, 404);
    const name = String((await body()).name || "").trim();
    if (!name) return json({ error: "need_name" }, 400);
    if (!(await limiter.hit("signup", 5, 60 * 60 * 1000))) return json({ error: "too_many" }, 429);
    return json(await dir.createCodeAccount(name, label()), 200);
  }
  if (p === "/auth/code/signin" && request.method === "POST") {
    if (!prov.code) return json({ error: "not_configured" }, 404);
    if (await limiter.blocked("joinfail", 8, 15 * 60 * 1000)) return json({ error: "too_many_attempts" }, 429);
    const b = await body();
    const r = await dir.signInWithCode(b.code, label(), b.otp);
    if (r.needOtp) return json(r, 200);
    if (r.error) {
      await limiter.hit("joinfail", 8, 15 * 60 * 1000);
      return json(r, 400);
    }
    return json(r, 200);
  }
  if (p === "/auth/email/verify" && request.method === "POST") {
    const b = await body();
    const r = await dir.verifyMagic({ token: b.token, email: cleanEmail(b.email), code: String(b.code || "") }, label());
    if (r.error) {
      await limiter.hit("joinfail", 8, 15 * 60 * 1000);
      return json(r, 400);
    }
    return json(r, 200);
  }

  // ----- TV sign-in by QR -----
  if (p === "/auth/device/start" && request.method === "POST") {
    if (!(await limiter.hit("device", 20, 60 * 60 * 1000))) return json({ error: "too_many" }, 429);
    return json(await dir.deviceStart(label() || "TV"), 200);
  }
  if (p === "/auth/device/poll" && request.method === "POST") {
    const b = await body();
    return json(await dir.devicePoll(b.deviceCode), 200);
  }
  if (p === "/auth/device/info" && request.method === "POST") {
    const u = await requireUser();
    if (!u) return json({ error: "signed_out" }, 401);
    const b = await body();
    const info = await dir.deviceInfo(String(b.userCode || "").replace(/[^A-Za-z0-9]/g, ""));
    if (!info) {
      await limiter.hit("joinfail", 8, 15 * 60 * 1000);
      return json({ error: "expired" }, 404);
    }
    return json(info, 200);
  }
  if (p === "/auth/device/approve" && request.method === "POST") {
    const u = await requireUser();
    if (!u) return json({ error: "signed_out" }, 401);
    const b = await body();
    const ok = await dir.deviceApprove(b.userCode, u.id);
    if (!ok) {
      await limiter.hit("joinfail", 8, 15 * 60 * 1000);
      return json({ error: "expired" }, 404);
    }
    return json({ ok: true }, 200);
  }

  if (p === "/auth/signout" && request.method === "POST") {
    await dir.signOut(bearer());
    return json({ ok: true }, 200);
  }

  // ----- signed-in API -----
  // Live notifications socket: browsers can't send headers on a WebSocket, so it uses a one-use ticket.
  if (p === "/api/me/ws" && url.searchParams.get("ticket")) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return json({ error: "websocket_required" }, 426);
    const tu = await dir.useTicket(url.searchParams.get("ticket"));
    if (!tu) return json({ error: "signed_out" }, 401);
    const h = new Headers(request.headers);
    h.set("X-Boxxie-User-Id", tu.id);
    return dir.fetch(new Request(request, { headers: h }));
  }

  if (p.startsWith("/api/me") || p.startsWith("/api/friends") || p.startsWith("/api/blocks") || p === "/api/report" || p === "/api/ticket") {
    const u = await requireUser();
    if (!u) return json({ error: "signed_out" }, 401);

    if (p === "/api/me" && request.method === "GET") return json(await dir.me(u.id), 200);
    if (p === "/api/me/name" && request.method === "POST") return json({ user: await dir.rename(u.id, (await body()).name) }, 200);
    if (p === "/api/ticket" && request.method === "POST") return json({ ticket: await dir.newTicket(u.id) }, 200);
    if (p === "/api/me/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return json({ error: "websocket_required" }, 426);
      const h = new Headers(request.headers);
      h.set("X-Boxxie-User-Id", u.id);
      return dir.fetch(new Request(request, { headers: h }));
    }
    if (p === "/api/me/delete" && request.method === "POST") {
      await dir.deleteUser(u.id);
      return json({ ok: true }, 200);
    }
    if (p === "/api/me/totp/setup" && request.method === "POST") return json(await dir.totpSetup(u.id), 200);
    if (p === "/api/me/totp/confirm" && request.method === "POST") {
      const r = await dir.totpConfirm(u.id, String((await body()).code || ""));
      return json(r, r.error ? 400 : 200);
    }
    if (p === "/api/me/totp/disable" && request.method === "POST") {
      const r = await dir.totpDisable(u.id, String((await body()).code || ""));
      return json(r, r.error ? 400 : 200);
    }
    if (p === "/api/me/code/reset" && request.method === "POST") {
      return json({ code: await dir.resetSigninCode(u.id) }, 200);
    }
    if (p === "/api/me/invites/dismiss" && request.method === "POST") {
      await dir.dropInvite(u.id, String((await body()).code || ""));
      return json({ ok: true }, 200);
    }
    if (p === "/api/friends/add" && request.method === "POST") {
      const b = await body();
      if (b.code) {
        const r = await dir.addFriendByCode(u.id, b.code);
        if (r.error) return json(r, r.error === "too_many" ? 429 : 400);
        return json({ status: r.status === "friends" ? "friends" : "requested" }, 200);
      }
      const email = cleanEmail(b.email);
      if (!email) return json({ error: "bad_email" }, 400);
      const r = await dir.addFriend(u.id, email);
      if (r.error) return json(r, r.error === "too_many" ? 429 : 400);
      // No account yet: email them an invitation (if email sending is set up)
      if (!r.hadAccount && prov.email) {
        const ret = String(b.return || "");
        if (redirectAllowed(ret)) {
          await sendEmail(env, dir, {
            to: email,
            subject: `${r.fromName} wants to watch films with you on Boxxie Share`,
            text: `${r.fromName} added you as a friend on Boxxie Share.\n\nSign in with this email address to accept: ${ret.split("#")[0]}`,
            html: emailHtml(`${r.fromName} added you on Boxxie Share`, ["Boxxie Share lets friends watch films together and talk on video while they watch.", "Sign in with this email address and you'll see the friend request."], { href: ret.split("#")[0], label: "Open Boxxie Share" }),
          }).catch(() => {});
        }
      }
      // Same reply whether or not they already have an account, so emails can't be checked one by one.
      return json({ status: r.status === "friends" ? "friends" : "requested" }, 200);
    }
    if (p === "/api/friends/respond" && request.method === "POST") {
      const b = await body();
      return json({ ok: await dir.respondFriend(u.id, String(b.id || ""), !!b.accept) }, 200);
    }
    if (p === "/api/blocks/add" && request.method === "POST") {
      return json({ ok: await dir.block(u.id, String((await body()).id || "")) }, 200);
    }
    if (p === "/api/blocks/remove" && request.method === "POST") {
      return json({ ok: await dir.unblock(u.id, String((await body()).id || "")) }, 200);
    }
    if (p === "/api/report" && request.method === "POST") {
      const b = await body();
      const r = await dir.report(u.id, { userId: b.userId ? String(b.userId) : null, room: b.room, reason: b.reason, details: b.details, messages: b.messages });
      if (r.error) return json(r, 429);
      if (b.block && b.userId) await dir.block(u.id, String(b.userId));
      // Email the person running this copy of Boxxie Share so they can act quickly.
      const to = cleanEmail(env.REPORT_EMAIL || env.CONTACT_EMAIL);
      if (to && prov.email) {
        const rep = r.report;
        const banLink = env.ADMIN_TOKEN && rep.target ? `${serverBase}/admin/ban?user=${encodeURIComponent(rep.target.id)}&sig=${await adminSig(env, rep.target.id)}` : null;
        const lines = [
          `<b>Reason:</b> ${escHtml(rep.reason)}`,
          `<b>Reported:</b> ${rep.target ? escHtml(`${rep.target.name} (${rep.target.email || "no email"}, id ${rep.target.id})`) : "not a specific person"}`,
          `<b>By:</b> ${escHtml(`${rep.reporter.name || ""} (${rep.reporter.email || "no email"})`)}`,
          `<b>Room:</b> ${escHtml(rep.room || "-")}`,
          `<b>Details:</b> ${escHtml(rep.details || "-")}`,
          ...(rep.messages.length ? [`<b>Their recent messages:</b><br>${rep.messages.map(escHtml).join("<br>")}`] : []),
        ];
        await sendEmail(env, dir, {
          to,
          subject: `Boxxie Share report: ${rep.reason}${rep.target ? " about " + rep.target.name : ""}`,
          text: lines.join("\n").replace(/<[^>]+>/g, "") + (banLink ? `\n\nBan this account: ${banLink}` : ""),
          html: emailHtml("Someone sent a report", lines, banLink ? { href: banLink, label: "Review and ban this account" } : null),
        }).catch(() => {});
      }
      return json({ ok: true }, 200);
    }
    if (p === "/api/friends/remove" && request.method === "POST") {
      return json({ ok: await dir.removeFriend(u.id, String((await body()).id || "")) }, 200);
    }
    return json({ error: "not_found" }, 404);
  }

  // Owner-only: ban an account from a report email. The link is signed with ADMIN_TOKEN.
  if (p === "/admin/ban" && env.ADMIN_TOKEN) {
    const userId = String(url.searchParams.get("user") || "");
    const sig = String(url.searchParams.get("sig") || "");
    const good = userId && timingSafeEq(sig, await adminSig(env, userId));
    if (!good) return new Response("Not allowed", { status: 403 });
    const html = (msg, form) => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:17px system-ui;background:#0b1118;color:#f6f1ea;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:28em;padding:24px"><h2>Boxxie Share</h2><p>${msg}</p>${form || ""}</div>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
    if (request.method === "POST") {
      const ok = await dir.ban(userId, true);
      return html(ok ? "Done. That account is banned and has been signed out everywhere." : "That account no longer exists.");
    }
    return html(`Ban account <b>${escHtml(userId)}</b>? They'll be signed out everywhere and can't sign in again.`, `<form method="post"><button style="font:inherit;font-weight:700;background:#e5484d;color:#fff;border:0;border-radius:10px;padding:12px 22px">Ban this account</button></form>`);
  }

  // dev helper for the test suite
  if (p === "/dev/mail" && env.DEV === "1") {
    return json((await dir.devReadMail(cleanEmail(url.searchParams.get("to")))) || {}, 200);
  }
  return null;
}
