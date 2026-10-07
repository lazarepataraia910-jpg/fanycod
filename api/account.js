// CodeQuest-ის ანგარიშები: რეგისტრაცია, შესვლა, პაროლის აღდგენა და პროგრესის შენახვა.
// ბაზა — Upstash Redis: Vercel → Storage → Create Database → Upstash for Redis → Connect Project.
// ცვლადები Vercel თავად ამატებს: KV_REST_API_URL და KV_REST_API_TOKEN (ან UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
//
// ყველა მოთხოვნა: POST /api/account { action, ... }. სესიის ნიშანი (token) body-შია, არა cookie-ში, ამიტომ CSRF-ის საფრთხე
// არ არის და კომპიუტერის პროგრამაც (desktop/, /api/* საიტზე გადაეგზავნება) ზუსტად ისევე მუშაობს.
// უსაფრთხოება:
//   • პაროლი და აღდგენის კოდი ინახება მხოლოდ scrypt-ის ჰეშით (შემთხვევითი მარილით), სესიის ნიშანი — sha256-ით;
//   • შესვლის, რეგისტრაციისა და აღდგენის მცდელობები შეზღუდულია IP-ითა და სახელით;
//   • პაროლის შეცვლა ან აღდგენა ყველა ძველ სესიას აუქმებს (pwv — პაროლის ვერსია);
//   • შესვლისას პასუხი ერთნაირია, სახელი არ არსებობს თუ პაროლია არასწორი.
// მონაცემები:
//   user:<სახელი პატარა ასოებით> → { name, pw, rc, pwv, at }       პაროლის და აღდგენის კოდის ჰეშები
//   sess:<sha256(ნიშანი)>        → { u, v }  (ვადა 60 დღე)
//   prog:<სახელი> / progrev:<სახელი> → პროგრესი (gzip + base64) და მისი ვერსია (rev). ვერსიის შემოწმება ატომურია (Lua)
//   rl:<სახეობა>:<IP ან სახელი>  → მცდელობების მთვლელი
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

const DB_URL = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = String(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '');
const SESSION_SEC = 60 * 86400;
const MAX_DATA = 2 * 1024 * 1024;   // პროგრესის JSON (შეკუმშვამდე)
const NAME_RE = /^[A-Za-z0-9ა-ჰ_.-]{3,20}$/;
const RESERVED = ['admin', 'administrator', 'root', 'system', 'support', 'moderator', 'codequest', 'bit', 'ბიტი', 'glitch', 'გლიჩი'];
const RC_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // აღდგენის კოდი: I, O, 0, 1 არ არის, რომ არ აგერიოს

class Fail extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/* ---------- Upstash Redis REST ---------- */
async function db(cmd) {
  const r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({ error: 'bad_json' }));
  if (!r.ok || j.error) throw new Error('db: ' + (j.error || r.status));
  return j.result;
}
async function dbPipe(cmds) {
  const r = await fetch(DB_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error('db pipeline: ' + r.status);
  return j.map(x => { if (x.error) throw new Error('db: ' + x.error); return x.result; });
}
// ვერსიის შემოწმება და შენახვა ერთ ნაბიჯში: თუ სხვა მოწყობილობამ უკვე შეინახა (ვერსია შეიცვალა), არაფერი იწერება
const CAS = "local r = redis.call('GET', KEYS[1]) or '0'\n" +
  "if r ~= ARGV[1] then return {0, r} end\n" +
  "redis.call('SET', KEYS[1], ARGV[2])\nredis.call('SET', KEYS[2], ARGV[3])\nreturn {1, ARGV[2]}";

/* ---------- ჰეშები ---------- */
const scrypt = (s, salt) => new Promise((ok, no) => crypto.scrypt(String(s).normalize('NFC'), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));
const DUMMY = crypto.randomBytes(16);
async function hashSecret(s) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('base64') + '$' + (await scrypt(s, salt)).toString('base64');
}
async function checkSecret(s, stored) {
  const [v, salt, h] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !h) { await scrypt(s, DUMMY); return false; }   // იგივე დრო, რომ არ ჩანდეს, სახელი არსებობს თუ არა
  const k = await scrypt(s, Buffer.from(salt, 'base64')), want = Buffer.from(h, 'base64');
  return want.length === k.length && crypto.timingSafeEqual(k, want);
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function newRecovery() {
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += RC_ABC[b[i] % 32];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
const normRecovery = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- მომხმარებელი და სესია ---------- */
const keyOf = name => String(name).normalize('NFC').toLowerCase();
async function getUser(u) { const s = await db(['GET', 'user:' + u]); return s ? JSON.parse(s) : null; }
const putUser = (u, user) => db(['SET', 'user:' + u, JSON.stringify(user)]);
async function newSession(u, pwv) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db(['SET', 'sess:' + sha(token), JSON.stringify({ u, v: pwv }), 'EX', SESSION_SEC]);
  return token;
}
async function session(token, refresh) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 100) throw new Fail(401, 'no_session');
  const raw = await db(['GET', 'sess:' + sha(token)]);
  const s = raw ? JSON.parse(raw) : null, user = s && await getUser(s.u);
  if (!user || user.pwv !== s.v) throw new Fail(401, 'no_session');
  if (refresh) await db(['EXPIRE', 'sess:' + sha(token), SESSION_SEC]);
  return { u: s.u, user };
}
// მცდელობების ლიმიტი: max მცდელობა sec წამში
async function limit(kind, id, max, sec) {
  const k = 'rl:' + kind + ':' + sha(id).slice(0, 32);
  const [, n] = await dbPipe([['SET', k, 0, 'EX', sec, 'NX'], ['INCR', k]]);
  if (n > max) throw new Fail(429, 'rate_limited');
}
function checkName(name) {
  // ქართული მთავრული (ᲐᲑᲒ) მხედრულად: სახელი ერთნაირად უნდა ჩაიწეროს ნებისმიერი კლავიატურით
  name = String(name || '').normalize('NFC').trim().replace(/[\u1C90-\u1CBF]/g, c => c.toLowerCase());
  if (!NAME_RE.test(name)) throw new Fail(400, 'name_format');
  if (RESERVED.includes(keyOf(name))) throw new Fail(400, 'name_reserved');
  return name;
}
function checkPass(pass, name) {
  pass = String(pass || '');
  if (pass.length < 8) throw new Fail(400, 'pass_short');
  if (pass.length > 100) throw new Fail(400, 'pass_long');
  if (name && keyOf(pass) === keyOf(name)) throw new Fail(400, 'pass_name');
  return pass;
}

/* ---------- პროგრესი ---------- */
const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const unpack = s => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8'));
async function loadProgress(u) {
  const [rev, data] = await dbPipe([['GET', 'progrev:' + u], ['GET', 'prog:' + u]]);
  return { rev: +rev || 0, data: data ? unpack(data) : null };
}

/* ---------- მოქმედებები ---------- */
const actions = {
  async register(b, ip) {
    const name = checkName(b.name), pass = checkPass(b.password, name), u = keyOf(name);
    await limit('reg', ip, 40, 3600);   // სკოლაში ბევრი ბავშვი ერთი IP-დან რეგისტრირდება
    const recovery = newRecovery();
    const user = { name, pw: await hashSecret(pass), rc: await hashSecret(normRecovery(recovery)), pwv: 1, at: Date.now() };
    if (await db(['SET', 'user:' + u, JSON.stringify(user), 'NX']) !== 'OK') throw new Fail(409, 'name_taken');
    return { name, token: await newSession(u, 1), recovery, rev: 0 };
  },
  async login(b, ip) {
    const name = String(b.name || '').normalize('NFC').trim(), u = keyOf(name);
    if (!name || name.length > 40) throw new Fail(401, 'bad_login');
    await limit('login-ip', ip, 120, 900);
    await limit('login-name', u, 10, 900);
    const user = await getUser(u);
    const good = await checkSecret(String(b.password || ''), user && user.pw);
    if (!user || !good) throw new Fail(401, 'bad_login');
    const p = await db(['GET', 'progrev:' + u]);
    return { name: user.name, token: await newSession(u, user.pwv), rev: +p || 0 };
  },
  async reset(b, ip) {
    const name = String(b.name || '').normalize('NFC').trim(), u = keyOf(name);
    await limit('reset-ip', ip, 30, 3600);
    await limit('reset-name', u, 5, 3600);
    const pass = checkPass(b.password, name);
    const user = name.length <= 40 ? await getUser(u) : null;
    const good = await checkSecret(normRecovery(b.recovery), user && user.rc);
    if (!user || !good) throw new Fail(401, 'bad_recovery');
    const recovery = newRecovery();
    Object.assign(user, { pw: await hashSecret(pass), rc: await hashSecret(normRecovery(recovery)), pwv: user.pwv + 1 });
    await putUser(u, user);
    const p = await db(['GET', 'progrev:' + u]);
    return { name: user.name, token: await newSession(u, user.pwv), recovery, rev: +p || 0 };
  },
  async me(b) {
    const { u, user } = await session(b.token, true);
    const p = await db(['GET', 'progrev:' + u]);
    return { name: user.name, rev: +p || 0 };
  },
  async load(b) {
    const { u, user } = await session(b.token, true);
    return Object.assign({ name: user.name }, await loadProgress(u));
  },
  async save(b) {
    const { u } = await session(b.token);
    const d = b.data;
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.levels !== 'object') throw new Fail(400, 'bad_request');
    if (JSON.stringify(d).length > MAX_DATA) throw new Fail(413, 'too_big');
    const base = String(Math.max(0, Math.floor(+b.rev || 0))), next = String(+base + 1);
    const [okFlag] = await db(['EVAL', CAS, 2, 'progrev:' + u, 'prog:' + u, base, next, pack(d)]);
    if (okFlag === 1) return { rev: +next };
    const now = await loadProgress(u);   // სხვა მოწყობილობამ უფრო ახალი შეინახა — თამაში გააერთიანებს და თავიდან შეინახავს
    throw Object.assign(new Fail(409, 'conflict'), { extra: { rev: now.rev, data: now.data } });
  },
  async logout(b) {
    if (typeof b.token === 'string' && b.token.length <= 100) await db(['DEL', 'sess:' + sha(b.token)]);
    return {};
  },
  async password(b, ip) {
    const { u, user } = await session(b.token);
    await limit('pass-name', u, 10, 900);
    if (!await checkSecret(String(b.password || ''), user.pw)) throw new Fail(401, 'bad_pass');
    const pass = checkPass(b.newPassword, user.name);
    Object.assign(user, { pw: await hashSecret(pass), pwv: user.pwv + 1 });   // სხვა მოწყობილობებზე სესიები უქმდება
    await putUser(u, user);
    await db(['DEL', 'sess:' + sha(b.token)]);
    return { token: await newSession(u, user.pwv) };
  },
  async delete(b) {
    const { u, user } = await session(b.token);
    await limit('del-name', u, 10, 900);
    if (!await checkSecret(String(b.password || ''), user.pw)) throw new Fail(401, 'bad_pass');
    await dbPipe([['DEL', 'user:' + u], ['DEL', 'prog:' + u], ['DEL', 'progrev:' + u], ['DEL', 'sess:' + sha(b.token)]]);
    return {};
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!DB_URL || !DB_TOKEN) return res.status(503).json({ ok: false, error: 'no_db' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const act = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
  if (!act) return res.status(400).json({ ok: false, error: 'bad_request' });
  const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  try {
    return res.status(200).json(Object.assign({ ok: true }, await act(body, ip)));
  } catch (e) {
    if (e instanceof Fail) return res.status(e.status).json(Object.assign({ ok: false, error: e.code }, e.extra || {}));
    console.error('account', body.action, e && e.message);
    return res.status(500).json({ ok: false, error: 'server' });
  }
};
