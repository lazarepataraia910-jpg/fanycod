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
//   sum:<სახელი>                 → მოკლე შეჯამება მასწავლებლისა და რეიტინგისთვის { name, xp, done, stars, course, next, courses, wk, wkBase, at }
//   cls:<კოდი> → { name, owner, ownerName, at }; clsm:<კოდი> — მოსწავლეები (set); uown:/uin:<სახელი> — ჩემი / ნაწევრები კლასები (set)
//   stat:lv                      → ანონიმური სტატისტიკა (hash): <ლეველი>|n — მცდელობა, |f — შეცდომები, |d — გავლა
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

/* ---------- კლასები, შეჯამება და სტატისტიკა ---------- */
// ISO კვირა (UTC), მაგ. 2026-W41 — კლასის რეიტინგი ამ კვირის XP-ს ითვლის
function weekId(t) {
  const d = new Date(t || Date.now());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
  const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4));
  return y + '-W' + String(1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getUTCDay() + 6) % 7) / 7)).padStart(2, '0');
}
function newCode(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += RC_ABC[b[i] % 32];
  return s;
}
const normCode = s => { const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-HJ-NP-Z2-9]{6}$/.test(c) ? c : ''; };
const cleanText = (s, n) => String(s || '').normalize('NFC').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
// მოსწავლის შეჯამებას თამაში ითვლის; აქ მხოლოდ ტიპები და ზომა მოწმდება
function cleanSummary(s) {
  if (!s || typeof s !== 'object') return null;
  const courses = {};
  Object.keys(s.courses || {}).slice(0, 40).forEach(k => { if (/^[a-z]{1,10}$/.test(k)) courses[k] = int(s.courses[k], 1000); });
  return { xp: int(s.xp, 1e8), done: int(s.done, 1e5), stars: int(s.stars, 3e5), streak: int(s.streak, 1e5),
    course: /^[a-z]{1,10}$/.test(s.course) ? s.course : '', next: /^[a-z0-9-]{1,40}$/.test(s.next) ? s.next : '', courses };
}
async function saveSummary(u, name, s) {
  const clean = cleanSummary(s);
  if (!clean) return;
  const prev = JSON.parse((await db(['GET', 'sum:' + u])) || 'null'), wk = weekId();
  // კვირის საწყისი XP: ამ კვირის პირველ შენახვაზე — ბოლოს შენახული XP (ამ კვირაში მოგებული XP რეიტინგში ჩაითვლება)
  const wkBase = prev && prev.wk === wk ? prev.wkBase : prev ? Math.min(prev.xp, clean.xp) : clean.xp;
  await db(['SET', 'sum:' + u, JSON.stringify(Object.assign(clean, { name, wk, wkBase, at: Date.now() }))]);
}
async function getClass(code) { const s = code && await db(['GET', 'cls:' + code]); return s ? JSON.parse(s) : null; }
async function dropClass(code, owner) {
  const members = (await db(['SMEMBERS', 'clsm:' + code])) || [];
  await dbPipe(members.map(m => ['SREM', 'uin:' + m, code]).concat([['DEL', 'cls:' + code], ['DEL', 'clsm:' + code], ['SREM', 'uown:' + owner, code]]));
}
// მფლობელის კოდი (Vercel-ის OWNER_KEYS, იგივე, რაც license.js-ში) — ანონიმური სტატისტიკის სანახავად
function isOwnerKey(key) {
  const h = crypto.createHash('sha256').update(String(key)).digest();
  return String(process.env.OWNER_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length >= 12)
    .some(k => crypto.timingSafeEqual(crypto.createHash('sha256').update(k).digest(), h));
}

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
    const { u, user } = await session(b.token);
    const d = b.data;
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.levels !== 'object') throw new Fail(400, 'bad_request');
    if (JSON.stringify(d).length > MAX_DATA) throw new Fail(413, 'too_big');
    const base = String(Math.max(0, Math.floor(+b.rev || 0))), next = String(+base + 1);
    const [okFlag] = await db(['EVAL', CAS, 2, 'progrev:' + u, 'prog:' + u, base, next, pack(d)]);
    if (okFlag === 1) {
      if (b.summary) await saveSummary(u, user.name, b.summary);   // მხოლოდ მაშინ, როცა XP ან ლეველები შეიცვალა
      return { rev: +next };
    }
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
    const [own, inn] = await dbPipe([['SMEMBERS', 'uown:' + u], ['SMEMBERS', 'uin:' + u]]);
    for (const code of own || []) await dropClass(code, u);   // მასწავლებლის კლასებიც იშლება
    await dbPipe((inn || []).map(code => ['SREM', 'clsm:' + code, u]).concat([['DEL', 'user:' + u], ['DEL', 'prog:' + u], ['DEL', 'progrev:' + u], ['DEL', 'sum:' + u],
      ['DEL', 'uin:' + u], ['DEL', 'uown:' + u], ['DEL', 'sess:' + sha(b.token)]]));
    return {};
  },
  /* ---- კლასები: მასწავლებელი ქმნის, მოსწავლე 6-ასოიანი კოდით უერთდება ---- */
  async classCreate(b) {
    const { u, user } = await session(b.token);
    const name = cleanText(b.name, 40) || 'ჩემი კლასი';
    if (await db(['SCARD', 'uown:' + u]) >= 10) throw new Fail(400, 'class_limit');
    for (let i = 0; i < 5; i++) {
      const code = newCode(6);
      if (await db(['SET', 'cls:' + code, JSON.stringify({ name, owner: u, ownerName: user.name, at: Date.now() }), 'NX']) === 'OK') {
        await db(['SADD', 'uown:' + u, code]);
        return { code, name };
      }
    }
    throw new Fail(500, 'server');
  },
  async classJoin(b) {
    const { u } = await session(b.token);
    await limit('join', u, 30, 3600);   // კოდის გამოცნობის წინააღმდეგ
    const code = normCode(b.code), c = await getClass(code);
    if (!c) throw new Fail(404, 'class_none');
    if (c.owner === u) throw new Fail(400, 'class_own');
    const [n, mine, already] = await dbPipe([['SCARD', 'clsm:' + code], ['SCARD', 'uin:' + u], ['SISMEMBER', 'uin:' + u, code]]);
    if (!already && n >= 100) throw new Fail(400, 'class_full');
    if (!already && mine >= 5) throw new Fail(400, 'class_limit');
    await dbPipe([['SADD', 'clsm:' + code, u], ['SADD', 'uin:' + u, code]]);
    return { code, name: c.name, teacher: c.ownerName };
  },
  async classLeave(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code);
    if (code) await dbPipe([['SREM', 'clsm:' + code, u], ['SREM', 'uin:' + u, code]]);
    return {};
  },
  async classes(b) {
    const { u } = await session(b.token);
    const [own, inn] = (await dbPipe([['SMEMBERS', 'uown:' + u], ['SMEMBERS', 'uin:' + u]])).map(x => x || []);
    const all = own.concat(inn), meta = all.length ? await dbPipe(all.map(c => ['GET', 'cls:' + c])) : [];
    const cnt = own.length ? await dbPipe(own.map(c => ['SCARD', 'clsm:' + c])) : [];
    const out = { own: [], in: [] }, gone = [];
    all.forEach((code, i) => {
      const c = meta[i] ? JSON.parse(meta[i]) : null;
      if (!c) gone.push([i < own.length ? 'uown:' + u : 'uin:' + u, code]);
      else if (i < own.length) out.own.push({ code, name: c.name, count: cnt[i] || 0 });
      else out.in.push({ code, name: c.name, teacher: c.ownerName });
    });
    if (gone.length) await dbPipe(gone.map(([k, code]) => ['SREM', k, code]));   // მასწავლებელმა კლასი წაშალა
    return out;
  },
  // მასწავლებელი ხედავს დეტალებს, მოსწავლე — მხოლოდ სახელებს და XP-ს (კვირის რეიტინგი)
  async classView(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code), c = await getClass(code);
    if (!c) throw new Fail(404, 'class_none');
    const owner = c.owner === u;
    if (!owner && !(await db(['SISMEMBER', 'clsm:' + code, u]))) throw new Fail(403, 'class_none');
    const members = (await db(['SMEMBERS', 'clsm:' + code])) || [];
    const sums = members.length ? await dbPipe(members.map(m => ['GET', 'sum:' + m])) : [];
    const wk = weekId();
    const rows = members.map((m, i) => {
      const s = sums[i] ? JSON.parse(sums[i]) : {}, week = s.wk === wk ? Math.max(0, (s.xp || 0) - (s.wkBase || 0)) : 0;
      return owner ? { id: m, name: s.name || m, week, xp: s.xp || 0, done: s.done || 0, stars: s.stars || 0, streak: s.streak || 0, course: s.course || '', next: s.next || '', courses: s.courses || {}, at: s.at || 0 }
        : { name: s.name || m, week, xp: s.xp || 0, me: m === u };
    });
    return { code, name: c.name, teacher: c.ownerName, owner, rows };
  },
  async classKick(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code), c = await getClass(code), m = keyOf(String(b.member || ''));
    if (!c || c.owner !== u) throw new Fail(403, 'class_none');
    await dbPipe([['SREM', 'clsm:' + code, m], ['SREM', 'uin:' + m, code]]);
    return {};
  },
  async classDelete(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code), c = await getClass(code);
    if (!c || c.owner !== u) throw new Fail(403, 'class_none');
    await dropClass(code, u);
    return {};
  },
  /* ---- ანონიმური სტატისტიკა: სად ჭედავენ მოთამაშეები (ანგარიშის და სახელის გარეშე) ---- */
  async stat(b, ip) {
    await limit('stat', ip, 600, 3600);
    const cmds = [];
    (Array.isArray(b.events) ? b.events.slice(0, 30) : []).forEach(e => {
      const id = Array.isArray(e) ? String(e[0] || '') : '';
      if (!/^[a-z0-9-]{1,40}$/.test(id)) return;
      cmds.push(['HINCRBY', 'stat:lv', id + '|n', 1]);
      if (int(e[1], 50)) cmds.push(['HINCRBY', 'stat:lv', id + '|f', int(e[1], 50)]);
      if (e[2]) cmds.push(['HINCRBY', 'stat:lv', id + '|d', 1]);
    });
    if (cmds.length) await dbPipe(cmds);
    return {};
  },
  // მხოლოდ საიტის მფლობელისთვის (OWNER_KEYS): ლეველები, რომლებზეც ყველაზე ხშირად ჩერდებიან
  async report(b, ip) {
    await limit('report', ip, 30, 3600);
    if (!isOwnerKey(String(b.key || '').trim())) throw new Fail(403, 'not_owner');
    const flat = (await db(['HGETALL', 'stat:lv'])) || [], lv = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const [id, k] = String(flat[i]).split('|');
      (lv[id] = lv[id] || { id, n: 0, f: 0, d: 0 })[k] = +flat[i + 1] || 0;
    }
    const all = Object.values(lv), quit = r => (r.n - r.d) / r.n;
    return { levels: all.length, plays: all.reduce((a, r) => a + r.n, 0), rows: all.filter(r => r.n >= 3).sort((a, z) => quit(z) - quit(a) || z.f / z.n - a.f / a.n).slice(0, 40) };
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
