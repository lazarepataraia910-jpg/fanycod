// CodeQuest-ის ანგარიშები: რეგისტრაცია, შესვლა, პაროლის აღდგენა და პროგრესის შენახვა.
// ბაზა — Upstash Redis: Vercel → Storage → Create Database → Upstash for Redis → Connect Project.
// ცვლადები Vercel თავად ამატებს: KV_REST_API_URL და KV_REST_API_TOKEN (ან UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
//
// Pro: proActivate — ლიცენზია ანგარიშს ებმება (იხ. „Pro: ანგარიშზე მიბმული“).
// ყველა მოთხოვნა: POST /api/account { action, ... }. ვებზე სესიის ნიშანი HttpOnly cookie-შია (SameSite=Strict + Origin-ის შემოწმება — CSRF-ის წინააღმდეგ);
// კომპიუტერის პროგრამა (Origin-ის გარეშე) ნიშანს body-ში აგზავნის. ძველი კომენტარი: სესიის ნიშანი (token) body-შია, არა cookie-ში, ამიტომ CSRF-ის საფრთხე
// არ არის და კომპიუტერის პროგრამაც (desktop/, /api/* საიტზე გადაეგზავნება) ზუსტად ისევე მუშაობს.
// უსაფრთხოება:
//   • პაროლი და აღდგენის კოდი ინახება მხოლოდ scrypt-ის ჰეშით (შემთხვევითი მარილით), სესიის ნიშანი — sha256-ით;
//   • შესვლის, რეგისტრაციისა და აღდგენის მცდელობები შეზღუდულია IP-ითა და სახელით;
//   • პაროლის შეცვლა ან აღდგენა ყველა ძველ სესიას აუქმებს (pwv — პაროლის ვერსია);
//   • შესვლისას პასუხი ერთნაირია, სახელი არ არსებობს თუ პაროლია არასწორი.
// მონაცემები:
//   user:<სახელი პატარა ასოებით> → { name, pw, rc?, pwv, at, email?, ev? }  პაროლის (და ძველი ანგარიშების აღდგენის კოდის) ჰეშები; ev — ელფოსტის დადასტურების დრო
//   ev:<sha256(კოდი)> → { u, e } (7 დღე) ელფოსტის დადასტურება; pr:<sha256(კოდი)> → { u, v } (1 სთ, ერთჯერადი) პაროლის აღდგენის ბმული
//   emailu:<ელფოსტა>             → დადასტურებული ანგარიშები ამ ელფოსტით (set; მშობელს რამდენიმე შვილის ანგარიში შეიძლება ჰქონდეს)
//   sess:<sha256(ნიშანი)>        → { u, v }  (ვადა 60 დღე)
//   prog:<სახელი> / progrev:<სახელი> → პროგრესი (gzip + base64) და მისი ვერსია (rev). ვერსიის შემოწმება ატომურია (Lua)
//   rl:<სახეობა>:<IP ან სახელი>  → მცდელობების მთვლელი
//   sum:<სახელი>                 → მოკლე შეჯამება მასწავლებლისა და რეიტინგისთვის { name, xp, done, stars, course, next, courses, wk, wkBase, at }
//   cls:<კოდი> → { name, owner, ownerName, at }; clsm:<კოდი> — მოსწავლეები (set); uown:/uin:<სახელი> — ჩემი / ნაწევრები კლასები (set)
//   stat:lv                      → ანონიმური სტატისტიკა (hash): <ლეველი>|n — მცდელობა, |f — შეცდომები, |d — გავლა; q-<ქვესთი>|n — მიეცა, |d — შესრულდა
//   live:<ID> / livekey:<ID>     → ცოცხალი გაკვეთილი { lang, code, files, dirs, ver, run, end, cls, teacher } და მასწავლებლის გასაღების ჰეში (4 სთ)
//
// ცოცხალი გაკვეთილი: მასწავლებელი თავის დაფას liveSet-ით აგზავნის, მოსწავლეები კი წამში ერთხელ კითხულობენ GET /api/account?live=ID&t=<წამი>.
// პასუხი Vercel-ის CDN-ში 1 წამით ინახება, ამიტომ 30 მოსწავლე ბაზას წამში მხოლოდ ერთხელ მიმართავს.
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
const LIVE_SEC = 4 * 3600, LIVE_MAX = 20000;   // გაკვეთილის ხანგრძლივობა და დაფის კოდის მაქსიმალური ზომა

/* ---------- ვინ შეიძლება მოგვმართოს (CORS) და IP-ზე ზოგადი ლიმიტი ---------- */
// ბრაუზერიდან — მხოლოდ ჩვენი საიტი (და ლოკალური ტესტი). Origin-ის გარეშე მოდის კომპიუტერის პროგრამა (Electron-ის proxy) და სერვერები.
// ქვიშის ყუთის iframe-ები (მოსწავლის / მასწავლებლის კოდი) Origin: null-ს აგზავნიან — უარი.
const SITE = 'https://codequest-lazare.vercel.app';
const ORIGINS = [SITE].concat(String(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const originOk = o => ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o);
// Origin იგივე ჰოსტია, რომელსაც მოთხოვნა მიმართავს (მაგ. codequest-git-main-lazare.vercel.app) — სხვა საიტი ამას ვერ გააყალბებს
const sameHost = (req, o) => { try { return new URL(o).host === String(req.headers['x-forwarded-host'] || req.headers.host || ''); } catch (e) { return false; } };
// ერთ სერვერულ ასლზე: IP-დან წუთში მაქსიმუმ 600 მოთხოვნა (ბაზის ბრძანებების გარეშე, რომ შეტევამ ლიმიტი არ ამოწუროს)
const HITS = new Map();
function burst(ip) {
  const now = Date.now();
  let h = HITS.get(ip);
  if (!h || now - h.t > 60000) { if (HITS.size > 5000) HITS.clear(); h = { t: now, n: 0 }; HITS.set(ip, h); }
  return ++h.n > 600;
}
const clientIp = req => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();

/* ---------- სესია ვებზე: HttpOnly cookie (JavaScript-ს ტოკენი აღარ ხელეწიფება, XSS ვერ მოიპარავს) ---------- */
// კომპიუტერის პროგრამა (Origin-ის გარეშე) ტოკენს ისევ JSON-ში იღებს.
const COOKIE = 'cq_s';
function readCookie(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)cq_s=([A-Za-z0-9_-]{30,100})(?:;|$)/);
  return m ? m[1] : '';
}
function setCookie(req, res, token) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || '')) && req.headers['x-forwarded-proto'] !== 'https';
  res.setHeader('Set-Cookie', COOKIE + '=' + (token || '') + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + (token ? SESSION_SEC : 0) + (local ? '' : '; Secure'));
}

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
// დაფის განახლება მხოლოდ მასწავლებლის გასაღებით (ერთ ნაბიჯში)
const LIVE_SET = "-- live\nif redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end\n" +
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])\nredis.call('EXPIRE', KEYS[2], ARGV[3])\nreturn 1";

/* ---------- ჰეშები ---------- */
// s2 — OWASP-ის რეკომენდაცია (N=2^14, r=8, p=5 ≈ N=2^17, p=1); s1 — ძველი ჰეშები, შესვლისას s2-ად გადაიწერება
const SCRYPT = { s1: { N: 16384, r: 8, p: 1 }, s2: { N: 16384, r: 8, p: 5 } };
const scrypt = (s, salt, v = 's2') => new Promise((ok, no) => crypto.scrypt(String(s).normalize('NFC'), salt, 32, SCRYPT[v], (e, k) => (e ? no(e) : ok(k))));
const DUMMY = crypto.randomBytes(16);
async function hashSecret(s) {
  const salt = crypto.randomBytes(16);
  return 's2$' + salt.toString('base64') + '$' + (await scrypt(s, salt)).toString('base64');
}
const oldHash = stored => String(stored || '').startsWith('s1$');
async function checkSecret(s, stored) {
  const [v, salt, h] = String(stored || '').split('$');
  if (!SCRYPT[v] || !salt || !h) { await scrypt(s, DUMMY); return false; }   // იგივე დრო, რომ არ ჩანდეს, სახელი არსებობს თუ არა
  const k = await scrypt(s, Buffer.from(salt, 'base64'), v), want = Buffer.from(h, 'base64');
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
const normLive = s => (/^[A-HJ-NP-Z2-9]{10}$/.test(String(s || '')) ? String(s) : '');
// დაფის მდგომარეობა: ენა, კოდი, ფაილები, ვერსია (ver — ყოველ ცვლილებაზე), გაშვება (run — ყოველ ▶-ზე)
function liveState(id, b, base) {
  return { id, lang: /^[a-z]{1,10}$/.test(b.lang) ? b.lang : base.lang || 'js', code: String(b.src == null ? base.code || '' : b.src).slice(0, LIVE_MAX),
    files: liveFiles(b.files), dirs: liveDirs(b.dirs), ver: int(b.ver, 1e9), run: int(b.run, 1e9), end: !!b.end, cls: base.cls || '', teacher: base.teacher || '', at: Date.now() };
}
// დაფის ფაილები { გზა: ტექსტი }: 20-მდე, გზა 200 სიმბოლომდე, ჯამში LIVE_MAX-მდე (რაც არ ეტევა, არ ინახება). code — მთავარი ფაილი ძველი ვერსიებისთვის
function liveFiles(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = [];
  let left = LIVE_MAX;
  for (const [k, v] of Object.entries(f)) {
    if (out.length >= 20 || typeof v !== 'string' || !k || k.length > 200 || v.length > left) continue;
    left -= v.length;
    out.push([k, v]);
  }
  return out.length ? Object.fromEntries(out) : null;
}
// ცარიელი საქაღალდეები: 20-მდე გზა, თითო 200 სიმბოლომდე
function liveDirs(d) {
  return Array.isArray(d) ? [...new Set(d.filter(x => typeof x === 'string' && x && x.length <= 200))].slice(0, 20) : [];
}
// კლასის ხედი: full — მასწავლებლის / მფლობელის დეტალები, თორემ მხოლოდ სახელი და XP (მოსწავლის რეიტინგი)
async function classDetail(code, c, full, u) {
  const members = (await db(['SMEMBERS', 'clsm:' + code])) || [];
  const sums = members.length ? await dbPipe(members.map(m => ['GET', 'sum:' + m])) : [];
  const wk = weekId();
  const rows = members.map((m, i) => {
    const s = sums[i] ? JSON.parse(sums[i]) : {}, week = s.wk === wk ? Math.max(0, (s.xp || 0) - (s.wkBase || 0)) : 0;
    return full ? { id: m, name: s.name || m, week, xp: s.xp || 0, done: s.done || 0, stars: s.stars || 0, streak: s.streak || 0, course: s.course || '', next: s.next || '', courses: s.courses || {}, at: s.at || 0 }
      : { name: s.name || m, week, xp: s.xp || 0, me: m === u };
  });
  return { code, name: c.name, teacher: c.ownerName, owner: full, rows, live: c.live || '', at: c.at || 0 };
}
// ყველა გასაღები პრეფიქსით (SCAN — ბაზას არ ბლოკავს)
async function scanKeys(prefix) {
  const out = [];
  let cur = '0', guard = 0;
  do {
    const [next, keys] = await db(['SCAN', cur, 'MATCH', prefix + '*', 'COUNT', '1000']);
    cur = String(next);
    (keys || []).forEach(k => { if (k.startsWith(prefix)) out.push(k); });
  } while (cur !== '0' && ++guard < 1000);
  return out;
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

/* ---------- Pro: ანგარიშზე მიბმული ---------- */
// Pro-ს ყიდვას და გააქტიურებას ანგარიში სჭირდება. ლიცენზიის კოდი ერთ ანგარიშს ებმება: prokey:<sha256(კოდი)> → ანგარიში
// (მფლობელის კოდები, OWNER_KEYS — გამონაკლისი, ნებისმიერ ანგარიშზე მუშაობს). ანგარიშზე ინახება user.pro = { kh, at, owner }.
// თამაშს ვაძლევთ ხელმოწერილ ნიშანს: base64url({ v: 2, u: ანგარიში, kh, iat }) + '.' + ECDSA P-256 (PRO_PRIVATE_KEY);
// თამაში მას PRO.pub-ით ამოწმებს და მხოლოდ იმავე ანგარიშით შესულს უღებს Pro-ს. კლასები სერვერზე user.pro-ს ამოწმებს.
const DODO = { live: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' };
let proKey = null;
function signPro(u, kh) {
  const pk = String(process.env.PRO_PRIVATE_KEY || '').replace(/\s+/g, '');
  if (!pk) return null;
  proKey = proKey || crypto.createPrivateKey({ key: Buffer.from(pk, 'base64'), format: 'der', type: 'pkcs8' });
  const payload = Buffer.from(JSON.stringify({ v: 2, u, kh: String(kh).slice(0, 16), iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  return payload + '.' + crypto.sign('sha256', Buffer.from(payload), { key: proKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
const proToken = (u, user) => (user && user.pro ? signPro(u, user.pro.kh) || undefined : undefined);
// ლიცენზიის კოდის შემოწმება Dodo Payments-თან (DODO_MODE=live — ნამდვილი გადახდები)
async function dodoValid(key) {
  let r;
  try {
    r = await fetch((DODO[process.env.DODO_MODE] || DODO.test) + '/licenses/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ license_key: key }), signal: AbortSignal.timeout(10000) });
  } catch (e) { throw new Fail(502, 'pro_upstream'); }
  if (r.status === 400 || r.status === 404 || r.status === 422) return false;
  if (!r.ok) throw new Fail(502, 'pro_upstream');
  const d = await r.json().catch(() => ({}));
  return d.valid === true;
}
function needPro(user) { if (!user || !user.pro) throw new Fail(403, 'pro_required'); }

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
// ყველაზე გავრცელებული პაროლები — ჯერ მათ ცდიან; ასევე 4-ზე ნაკლები განსხვავებული სიმბოლო (11111111, abababab)
const WEAK = new Set(['12345678', '123456789', '1234567890', '12341234', '11223344', '12121212', '123123123', '87654321', '98765432', '00000000', '11111111',
  'password', 'password1', 'passw0rd', 'qwerty12', 'qwerty123', 'qwertyui', 'asdfghjk', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx', 'qazwsxed', 'abc12345', 'abcd1234',
  'iloveyou', 'sunshine', 'princess', 'football', 'superman', 'batman123', 'minecraft', 'codequest', 'codequest1', 'paroli12', 'paroli123', 'parolparol',
  'georgia1', 'sakartvelo', 'tbilisi1', 'bit12345', 'glitch123']);
function checkPass(pass, name) {
  pass = String(pass || '');
  if (pass.length < 8) throw new Fail(400, 'pass_short');
  if (pass.length > 100) throw new Fail(400, 'pass_long');
  if (!/\p{L}/u.test(pass) || !/\d/.test(pass)) throw new Fail(400, 'pass_weak');   // ახალ პაროლს ასოც და ციფრიც სჭირდება (ძველით შესვლას არ ეხება)
  if (name && keyOf(pass) === keyOf(name)) throw new Fail(400, 'pass_name');
  if (WEAK.has(keyOf(pass)) || new Set(keyOf(pass)).size < 4) throw new Fail(400, 'pass_common');
  return pass;
}

/* ---------- ელფოსტა: დადასტურება და პაროლის აღდგენა ბმულით ---------- */
// წერილები ჩვენი დომენიდან (MAIL_FROM) Resend-ით იგზავნება: Vercel-ში საჭიროა RESEND_API_KEY, Resend-ში კი დადასტურებული codequest.space.
// დადასტურების ბმული მხოლოდ შესულ ანგარიშზე მუშაობს: შეცდომით ჩაწერილი (სხვისი) ელფოსტის მფლობელი ბმულით ანგარიშს ვერ დაეპატრონება.
const APP = String(process.env.APP_URL || 'https://codequest.space').replace(/\/+$/, '');
const MAIL_FROM = process.env.MAIL_FROM || 'CodeQuest <no-reply@codequest.space>';
const MAIL_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';   // ტესტებში — ლოკალური მოკი
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i, LINK_SEC = 3600, VERIFY_SEC = 7 * 86400, CODE_RE = /^[A-Za-z0-9_-]{20,100}$/;
function checkEmail(e) {
  e = String(e || '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new Fail(400, 'email_format');
  return e;
}
const maskEmail = e => { const [a, d] = String(e || '').split('@'); return a && d ? a[0] + '***@' + d : ''; };
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const newLinkCode = () => crypto.randomBytes(24).toString('base64url');
async function sendMail(to, subject, lines, link, button) {
  if (!process.env.RESEND_API_KEY) throw new Fail(503, 'no_mail');
  const text = lines.join('\n\n') + '\n\n' + link + '\n\n— CodeQuest · ' + APP;
  const html = '<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:520px">' + lines.map(l => '<p>' + escHtml(l) + '</p>').join('') +
    '<p><a href="' + escHtml(link) + '" style="display:inline-block;background:#3d5afe;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">' + escHtml(button) + '</a></p>' +
    '<p style="font-size:13px;color:#666">ღილაკი არ მუშაობს? ჩააკოპირე ბმული ბრაუზერში:<br>' + escHtml(link) + '</p><p style="font-size:13px;color:#666">— CodeQuest · ' + escHtml(APP) + '</p></div>';
  const r = await fetch(MAIL_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }) });
  if (!r.ok) { console.error('mail', r.status, (await r.text().catch(() => '')).slice(0, 300)); throw new Fail(502, 'mail_failed'); }
}
async function sendVerify(u, user) {
  const code = newLinkCode();
  await db(['SET', 'ev:' + sha(code), JSON.stringify({ u, e: user.email }), 'EX', VERIFY_SEC]);
  await sendMail(user.email, 'CodeQuest: დაადასტურე ელფოსტა', ['გამარჯობა, ' + user.name + '!',
    'ეს ელფოსტა CodeQuest-ის ანგარიშს „' + user.name + '“ მიება. დაადასტურე, რომ შენია: თუ პაროლი დაგავიწყდება, აღდგენის ბმულს აქ მიიღებ.',
    'ბმული 7 დღე მოქმედებს. თუ ამ მოწყობილობაზე თამაშში არ ხარ შესული, გვერდი სახელსა და პაროლს გკითხავს.', 'თუ ეს შენ არ გაგიკეთებია, უბრალოდ წაშალე წერილი.'],
    APP + '/account.html?verify=' + code, 'ელფოსტის დადასტურება');
}
// სახელი + პაროლი (შესვლა და account.html-ის ელფოსტის დადასტურება სესიის გარეშე) — იგივე ლიმიტებით
async function byPassword(b, ip) {
  const name = String(b.name || '').normalize('NFC').trim(), u = keyOf(name);
  if (!name || name.length > 40) throw new Fail(401, 'bad_login');
  await limit('login-ip', ip, 120, 900);
  await limit('login-name', u, 10, 900);
  const user = await getUser(u);
  const good = await checkSecret(String(b.password || ''), user && user.pw);
  if (!user || !good) throw new Fail(401, 'bad_login');
  if (oldHash(user.pw)) { user.pw = await hashSecret(String(b.password)); await putUser(u, user); }   // ძველი (s1) ჰეში — უფრო ძლიერად
  return { u, user };
}

/* ---------- პროგრესი ---------- */
const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const unpack = s => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8'));
async function loadProgress(u) {
  const [rev, data] = await dbPipe([['GET', 'progrev:' + u], ['GET', 'prog:' + u]]);
  return { rev: +rev || 0, data: data ? unpack(data) : null };
}

/* ---------- სკოლის (/learn) პროგრესი ---------- */
// done: { id: დღე }, quiz: { id: საუკეთესო % }, marks: { id: { on, at, t } }, notes: { id: { t, at, h } }; id — კურსი/მოდული/თავი
const SCHOOL_MAX = 400000, SCH_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){2}$/, SCH_DAY = /^\d{4}-\d{2}-\d{2}$/;
// მოწყობილობიდან მოსულს არ ვენდობით: მხოლოდ ცნობილი ველები, სწორი id-ები და შეზღუდული ზომა
function cleanSchool(s) {
  const out = { done: {}, quiz: {}, marks: {}, notes: {} };
  const each = (o, max, fn) => { if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).slice(0, max).forEach(k => { if (k.length <= 120 && SCH_ID.test(k)) fn(k, o[k]); }); };
  if (!s || typeof s !== 'object') return out;
  each(s.done, 12000, (k, v) => { if (typeof v === 'string' && SCH_DAY.test(v)) out.done[k] = v; });
  each(s.quiz, 3000, (k, v) => { const p = int(v, 100); if (p) out.quiz[k] = p; });
  each(s.marks, 500, (k, v) => { if (v && typeof v === 'object') out.marks[k] = { on: v.on ? 1 : 0, at: int(v.at, 9e15), t: String(v.t || '').slice(0, 120) }; });
  each(s.notes, 200, (k, v) => { if (v && typeof v === 'object') out.notes[k] = { t: String(v.t || '').slice(0, 1000), at: int(v.at, 9e15), h: String(v.h || '').slice(0, 120) }; });
  return out;
}
// გაერთიანება (იგივე წესი: school/learn.js → merge): დასრულებული რჩება დასრულებული, ქვიზიდან — საუკეთესო, სანიშნე და შენიშვნა — ბოლოს შეცვლილი
function mergeSchool(a, b) {
  const m = { done: {}, quiz: {}, marks: {}, notes: {} };
  for (const s of [a, b]) {
    if (!s) continue;
    for (const k of Object.keys(s.done || {})) if (!m.done[k] || s.done[k] < m.done[k]) m.done[k] = s.done[k];
    for (const k of Object.keys(s.quiz || {})) m.quiz[k] = Math.max(m.quiz[k] || 0, s.quiz[k]);
    for (const f of ['marks', 'notes']) for (const k of Object.keys(s[f] || {})) if (!m[f][k] || s[f][k].at > m[f][k].at) m[f][k] = s[f][k];
  }
  return m;
}

/* ---------- მოქმედებები ---------- */
const actions = {
  // რეგისტრაცია: ანგარიში ჯერ არ იქმნება — მხოლოდ წერილი. ანგარიში ჩნდება წერილის ბმულზე დაჭერისას (confirmReg)
  async register(b, ip) {
    const name = checkName(b.name), pass = checkPass(b.password, name), u = keyOf(name), email = checkEmail(b.email);
    if (!process.env.RESEND_API_KEY) throw new Fail(503, 'no_mail');
    await limit('reg', ip, 40, 3600);   // სკოლაში ბევრი ბავშვი ერთი IP-დან რეგისტრირდება
    if (await getUser(u)) throw new Fail(409, 'name_taken');
    await limit('mail', email, 6, 3600);
    const code = newLinkCode();
    await db(['SET', 'reg:' + sha(code), JSON.stringify({ name, pw: await hashSecret(pass), email }), 'EX', VERIFY_SEC]);
    await sendMail(email, 'CodeQuest: დაადასტურე ელფოსტა', ['გამარჯობა, ' + name + '!',
      'ვიღაცამ, იმედია შენ, CodeQuest-ზე ანგარიში „' + name + '“ ამ ელფოსტით დაარეგისტრირა. ანგარიში შეიქმნება, როცა ღილაკს დააჭერ.',
      'ბმული 7 დღე მოქმედებს.', 'თუ ეს შენ არ გაგიკეთებია, უბრალოდ წაშალე წერილი: ანგარიში არ შეიქმნება.'],
      APP + '/account.html?join=' + code, 'დადასტურება და ანგარიშის შექმნა');
    return { pending: true, name, em: maskEmail(email) };
  },
  // წერილის ბმული: ელფოსტა დადასტურდა — ანგარიში ახლა იქმნება (უკვე დადასტურებული ელფოსტით). სესია არ იქმნება: შესვლა თამაშში
  async confirmReg(b, ip) {
    await limit('join-ip', ip, 30, 3600);
    const code = String(b.code || '');
    const raw = CODE_RE.test(code) ? await db(['GET', 'reg:' + sha(code)]) : null, t = raw ? JSON.parse(raw) : null;
    if (!t) throw new Fail(400, 'bad_link');
    const u = keyOf(t.name), user = { name: t.name, pw: t.pw, pwv: 1, at: Date.now(), email: t.email, ev: Date.now() };
    if (await db(['SET', 'user:' + u, JSON.stringify(user), 'NX']) !== 'OK') {
      const had = await getUser(u);
      if (had && had.email === t.email && had.pw === t.pw) return { name: t.name };   // ბმულს მეორედ დააჭირა
      throw new Fail(409, 'name_taken');
    }
    await db(['SADD', 'emailu:' + t.email, u]);   // reg: ვადამდე რჩება — მეორე დაჭერაზე იგივე პასუხი
    return { name: t.name };
  },
  async login(b, ip) {
    const { u, user } = await byPassword(b, ip);
    const p = await db(['GET', 'progrev:' + u]);
    // mo — წერილები ჩართულია (RESEND_API_KEY): მის გარეშე თამაში ელფოსტას შესვლისას არ ითხოვს
    return { name: user.name, token: await newSession(u, user.pwv), rev: +p || 0, em: maskEmail(user.email), ev: !!user.ev, mo: !!process.env.RESEND_API_KEY };
  },
  // დაგავიწყდა პაროლი: სახელით ან ელფოსტით. ბმული მიდის მხოლოდ დადასტურებულ ელფოსტაზე; პასუხი ყოველთვის ერთნაირია (არ ჩანს, არსებობს თუ არა ანგარიში)
  async forgot(b, ip) {
    if (!process.env.RESEND_API_KEY) throw new Fail(503, 'no_mail');
    const who = String(b.who || '').normalize('NFC').trim();
    if (!who || who.length > 254) throw new Fail(400, 'bad_request');
    await limit('forgot-ip', ip, 10, 3600);
    await limit('forgot', keyOf(who), 3, 3600);
    const us = who.includes('@') ? (await db(['SMEMBERS', 'emailu:' + checkEmail(who)])) || [] : [keyOf(who)];
    for (const u of us.slice(0, 5)) {
      const user = await getUser(u);
      if (!user || !user.email || !user.ev) continue;
      try { await limit('mail', user.email, 6, 3600); } catch (e) { continue; }   // ერთ ყუთში საათში მაქსიმუმ 6 წერილი
      const code = newLinkCode();
      await db(['SET', 'pr:' + sha(code), JSON.stringify({ u, v: user.pwv }), 'EX', LINK_SEC]);
      await sendMail(user.email, 'CodeQuest: პაროლის აღდგენა', ['გამარჯობა, ' + user.name + '!',
        'ვიღაცამ, იმედია შენ, CodeQuest-ის ანგარიშის „' + user.name + '“ პაროლის აღდგენა მოითხოვა. ახალი პაროლის დასაყენებლად დააჭირე ღილაკს.',
        'ბმული 1 საათი მოქმედებს და მხოლოდ ერთხელ მუშაობს.', 'თუ ეს შენ არ მოგითხოვია, უბრალოდ წაშალე წერილი: პაროლი არ შეიცვლება.'],
        APP + '/account.html?reset=' + code, 'ახალი პაროლის დაყენება');
    }
    return {};
  },
  // ბმულიდან ახალი პაროლი: ბმული ერთჯერადია და უქმდება, თუ პაროლი უკვე შეიცვალა (pwv)
  async resetLink(b, ip) {
    await limit('resetlink-ip', ip, 30, 3600);
    const code = String(b.code || '');
    const raw = CODE_RE.test(code) ? await db(['GET', 'pr:' + sha(code)]) : null, t = raw ? JSON.parse(raw) : null, user = t && await getUser(t.u);
    if (!user || user.pwv !== t.v) throw new Fail(400, 'bad_link');
    const pass = checkPass(b.password, user.name);
    Object.assign(user, { pw: await hashSecret(pass), pwv: user.pwv + 1 });   // ყველა ძველი სესია უქმდება
    await dbPipe([['SET', 'user:' + t.u, JSON.stringify(user)], ['DEL', 'pr:' + sha(code)]]);
    if (b.nologin) return { name: user.name };   // account.html: პაროლი შეიცვალა, შესვლა თამაშში (თამაშის cookie-ს არ ვეხებით)
    const p = await db(['GET', 'progrev:' + t.u]);
    return { name: user.name, token: await newSession(t.u, user.pwv), rev: +p || 0, em: maskEmail(user.email), ev: !!user.ev };
  },
  // ელფოსტის მიბმა ან შეცვლა — პაროლით (მოპარული სესიით ელფოსტას ვერ შეცვლიან და მერე პაროლს ვერ „აღადგენენ“)
  async setEmail(b) {
    const { u, user } = await session(b.token);
    await limit('email-name', u, 5, 3600);
    // პაროლი მხოლოდ დადასტურებული ელფოსტის შეცვლას სჭირდება (თორემ სესიის ქურდი აღდგენას თავისკენ გადაიტანდა)
    if (user.email && user.ev && !await checkSecret(String(b.password || ''), user.pw)) throw new Fail(401, 'bad_pass');
    const email = checkEmail(b.email);
    if (email === user.email && user.ev) return { em: maskEmail(email), ev: true };
    if (user.email && user.ev) await db(['SREM', 'emailu:' + user.email, u]);
    Object.assign(user, { email, ev: 0 });
    await putUser(u, user);
    await sendVerify(u, user);
    return { em: maskEmail(email), ev: false };
  },
  async resendVerify(b) {
    const { u, user } = await session(b.token);
    if (!user.email) throw new Fail(400, 'email_format');
    if (user.ev) return { em: maskEmail(user.email), ev: true };
    await limit('verify-mail', u, 3, 3600);
    await sendVerify(u, user);
    return { em: maskEmail(user.email), ev: false };
  },
  async verifyEmail(b, ip) {
    // account.html: თამაშში შესული არ ხარ — სახელი და პაროლი (სესია არ იქმნება, თამაშის cookie-ს არ ვეხებით)
    const { u, user } = b.name != null ? await byPassword(b, ip) : await session(b.token);
    const code = String(b.code || '');
    const raw = CODE_RE.test(code) ? await db(['GET', 'ev:' + sha(code)]) : null, t = raw ? JSON.parse(raw) : null;
    if (t && t.u !== u) throw new Fail(403, 'other_account');
    if (!t || t.e !== user.email) throw new Fail(400, 'bad_link');
    user.ev = Date.now();
    await dbPipe([['SET', 'user:' + u, JSON.stringify(user)], ['SADD', 'emailu:' + user.email, u], ['DEL', 'ev:' + sha(code)]]);
    return { em: maskEmail(user.email), ev: true };
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
    return { name: user.name, rev: +p || 0, pro: proToken(u, user), sv: user.sv || 0, em: maskEmail(user.email), ev: !!user.ev };
  },
  async load(b) {
    // rev — მოწყობილობის ვერსია: თუ ანგარიშში იგივეა, მონაცემს არ ვაგზავნით (ხშირი შემოწმება ორ მოწყობილობას შორის — იაფი)
    const light = b.rev != null, { u, user } = await session(b.token, !light), head = { name: user.name, pro: proToken(u, user), sv: user.sv || 0, em: maskEmail(user.email), ev: !!user.ev };
    if (light) { const rev = +(await db(['GET', 'progrev:' + u])) || 0; if (rev === Math.floor(+b.rev)) return Object.assign(head, { rev }); }
    return Object.assign(head, await loadProgress(u));
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
  // კომპიუტერის პროგრამა: პროგრესი კომპიუტერში რჩება — სერვერზე მხოლოდ მოკლე შეჯამება (კლასის რეიტინგი, მფლობელის სტატისტიკა)
  async summary(b) {
    const { u, user } = await session(b.token, true);
    await saveSummary(u, user.name, b.summary);
    return {};
  },
  // 📚 სკოლა (/learn): მისი პროგრესი თამაშისგან ცალკე ინახება (school:<ანგარიში>). მოწყობილობა თავის მდგომარეობას აგზავნის,
  // სერვერი აერთიანებს და გაერთიანებულს აბრუნებს — ორი მოწყობილობა კონფლიქტის გარეშე თანაბრდება.
  // sv — ბოლო ცვლილების დრო (me / load-შიც ბრუნდება): თამაში მისით იგებს, რომ სკოლის XP შეიცვალა
  async school(b) {
    const { u, user } = await session(b.token, true);
    needPro(user);   // 👑 სკოლა Pro-ს ნაწილია
    const raw = await db(['GET', 'school:' + u]), cur = raw ? unpack(raw) : null, next = mergeSchool(cur, cleanSchool(b.state)), json = JSON.stringify(next);
    if (json !== JSON.stringify(mergeSchool(cur, null))) {   // არაფერი შეცვლილა (ან ორივე ცარიელია) — ბაზაში არ ვწერთ
      if (json.length > SCHOOL_MAX) throw new Fail(413, 'too_big');
      user.sv = Date.now();
      await dbPipe([['SET', 'school:' + u, pack(next)], ['SET', 'user:' + u, JSON.stringify(user)]]);
    }
    return { state: next, sv: user.sv || 0 };
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
    if (user.pro && !user.pro.owner && (await db(['GET', 'prokey:' + user.pro.kh])) === u) await db(['DEL', 'prokey:' + user.pro.kh]);
    if (user.email) await db(['SREM', 'emailu:' + user.email, u]);
    await dbPipe((inn || []).map(code => ['SREM', 'clsm:' + code, u]).concat([['DEL', 'user:' + u], ['DEL', 'prog:' + u], ['DEL', 'progrev:' + u], ['DEL', 'sum:' + u], ['DEL', 'school:' + u],
      ['DEL', 'uin:' + u], ['DEL', 'uown:' + u], ['DEL', 'sess:' + sha(b.token)]]));
    return {};
  },
  /* ---- Pro: ლიცენზიის კოდის გააქტიურება შესულ ანგარიშზე ---- */
  async proActivate(b, ip) {
    const { u, user } = await session(b.token);
    await limit('proact-ip', ip, 60, 900);
    await limit('proact', u, 20, 3600);
    const key = String(b.key || '').trim();
    if (!key || key.length > 200) throw new Fail(400, 'pro_invalid');
    const kh = crypto.createHash('sha256').update(key).digest('hex'), owner = isOwnerKey(key);
    if (!owner) {
      const bound = await db(['GET', 'prokey:' + kh]);
      if (bound && bound !== u) throw new Fail(409, 'pro_taken');   // ერთი ლიცენზია — ერთი ანგარიში
      if (!bound) {
        if (!(await dodoValid(key))) throw new Fail(400, 'pro_invalid');
        if (await db(['SET', 'prokey:' + kh, u, 'NX']) !== 'OK' && (await db(['GET', 'prokey:' + kh])) !== u) throw new Fail(409, 'pro_taken');
      }
    }
    const token = signPro(u, kh);
    if (!token) throw new Fail(503, 'no_signing_key');
    user.pro = Object.assign({ kh, at: (user.pro && user.pro.at) || Date.now() }, owner ? { owner: true } : {});
    await putUser(u, user);
    return { pro: token };   // არა token: ვებზე token სესიის cookie-ში გადადის
  },
  /* ---- კლასები (Pro): მასწავლებელი ქმნის, მოსწავლე 6-ასოიანი კოდით უერთდება ---- */
  async classCreate(b) {
    const { u, user } = await session(b.token);
    needPro(user);
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
    const { u, user } = await session(b.token);
    needPro(user);
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
    const { u, user } = await session(b.token);
    needPro(user);
    const [own, inn] = (await dbPipe([['SMEMBERS', 'uown:' + u], ['SMEMBERS', 'uin:' + u]])).map(x => x || []);
    const all = own.concat(inn), meta = all.length ? await dbPipe(all.map(c => ['GET', 'cls:' + c])) : [];
    const cnt = own.length ? await dbPipe(own.map(c => ['SCARD', 'clsm:' + c])) : [];
    const out = { own: [], in: [] }, gone = [];
    all.forEach((code, i) => {
      const c = meta[i] ? JSON.parse(meta[i]) : null;
      if (!c) gone.push([i < own.length ? 'uown:' + u : 'uin:' + u, code]);
      else if (i < own.length) out.own.push({ code, name: c.name, count: cnt[i] || 0, live: !!c.live });
      else out.in.push({ code, name: c.name, teacher: c.ownerName, live: !!c.live });
    });
    if (gone.length) await dbPipe(gone.map(([k, code]) => ['SREM', k, code]));   // მასწავლებელმა კლასი წაშალა
    return out;
  },
  // მასწავლებელი ხედავს დეტალებს, მოსწავლე — მხოლოდ სახელებს და XP-ს (კვირის რეიტინგი)
  async classView(b) {
    const { u, user } = await session(b.token);
    needPro(user);
    const code = normCode(b.code), c = await getClass(code);
    if (!c) throw new Fail(404, 'class_none');
    const owner = c.owner === u;
    if (!owner && !(await db(['SISMEMBER', 'clsm:' + code, u]))) throw new Fail(403, 'class_none');
    return classDetail(code, c, owner, u);
  },
  async classKick(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code), c = await getClass(code), m = keyOf(String(b.member || ''));
    if (!m || m.length > 40) throw new Fail(400, 'bad_request');
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
  /* ---- ცოცხალი გაკვეთილი ---- */
  // მასწავლებელი იწყებს: ახალი ID (მოსწავლეები კლასის ხედიდან იღებენ) და გასაღები (მხოლოდ მასწავლებელს)
  async liveStart(b) {
    const { u, user } = await session(b.token);
    needPro(user);
    const code = normCode(b.code), c = await getClass(code);
    if (!c || c.owner !== u) throw new Fail(403, 'class_none');
    await limit('live', u, 30, 3600);
    if (c.live) await db(['DEL', 'live:' + c.live, 'livekey:' + c.live]);   // წინა გაკვეთილი მთავრდება
    const id = newCode(10), key = crypto.randomBytes(24).toString('base64url');
    const st = liveState(id, Object.assign({}, b, { ver: 1, run: 0 }), { cls: c.name, teacher: c.ownerName, lang: 'js' });
    await dbPipe([['SET', 'live:' + id, JSON.stringify(st), 'EX', LIVE_SEC], ['SET', 'livekey:' + id, sha(key), 'EX', LIVE_SEC], ['SET', 'cls:' + code, JSON.stringify(Object.assign(c, { live: id }))]]);
    return { id, key, state: st };
  },
  // მასწავლებლის დაფა: კოდი, ენა, გაშვება — სესიის გარეშე, გაკვეთილის გასაღებით (ბაზაზე 1 ბრძანება)
  async liveSet(b) {
    const id = normLive(b.id);
    if (!id) throw new Fail(404, 'live_none');
    const st = liveState(id, b, { cls: cleanText(b.cls, 40), teacher: cleanText(b.teacher, 40) });
    if (await db(['EVAL', LIVE_SET, 2, 'live:' + id, 'livekey:' + id, sha(String(b.key || '')), JSON.stringify(st), LIVE_SEC]) !== 1) throw new Fail(403, 'live_none');
    return {};
  },
  async liveEnd(b) {
    const { u } = await session(b.token);
    const code = normCode(b.code), c = await getClass(code);
    if (!c || c.owner !== u) throw new Fail(403, 'class_none');
    if (c.live) {
      const raw = await db(['GET', 'live:' + c.live]), st = raw ? JSON.parse(raw) : {};
      await dbPipe([['SET', 'live:' + c.live, JSON.stringify(Object.assign(st, { end: true, at: Date.now() })), 'EX', 600], ['DEL', 'livekey:' + c.live]]);
      delete c.live;
      await db(['SET', 'cls:' + code, JSON.stringify(c)]);
    }
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
  /* ---- მფლობელის სტატისტიკა (OWNER_KEYS) ---- */
  // ერთი მოთხოვნით: ლეველების ანონიმური სტატისტიკა, ანგარიშები (სულ / აქტიური / Pro), ენების პოპულარობა, ყველა კლასი
  async ownerStats(b, ip) {
    await limit('owner', ip, 120, 3600);
    if (!isOwnerKey(String(b.key || '').trim())) throw new Fail(403, 'not_owner');
    // ლეველები: { id: [მცდელობა, შეცდომები, გავლა] }; ქვესთები (q-<id>): { id: [მიეცა, 0, შესრულდა] }
    const flat = (await db(['HGETALL', 'stat:lv'])) || [], levels = {}, quests = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const [id, k] = String(flat[i]).split('|'), j = { n: 0, f: 1, d: 2 }[k], to = id.startsWith('q-') ? quests : levels;
      if (j == null) continue;
      (to[id] = to[id] || [0, 0, 0])[j] = +flat[i + 1] || 0;
    }
    // ანგარიშები და მათი შეჯამებები (პაროლის ჰეშები სერვერს არ ტოვებს — მხოლოდ რაოდენობები)
    const ukeys = await scanKeys('user:'), wk = weekId(), now = Date.now();
    const acc = { total: ukeys.length, pro: 0, proOwner: 0, week: 0, active7: 0, new7: 0, xp: 0 }, courses = {};
    for (let i = 0; i < ukeys.length; i += 200) {
      const part = ukeys.slice(i, i + 200);
      const got = await dbPipe(part.map(k => ['GET', k]).concat(part.map(k => ['GET', 'sum:' + k.slice(5)])));
      part.forEach((k, j) => {
        const user = got[j] ? JSON.parse(got[j]) : null, s = got[part.length + j] ? JSON.parse(got[part.length + j]) : null;
        if (user && user.pro) { acc.pro++; if (user.pro.owner) acc.proOwner++; }
        if (user && now - (user.at || 0) < 7 * 86400000) acc.new7++;
        if (!s) return;
        acc.xp += s.xp || 0;
        if (s.wk === wk) acc.week++;
        if (now - (s.at || 0) < 7 * 86400000) acc.active7++;
        Object.entries(s.courses || {}).forEach(([cid, done]) => { const c = courses[cid] = courses[cid] || { players: 0, done: 0 }; if (done > 0) { c.players++; c.done += done; } });
      });
    }
    // კლასები
    const codes = (await scanKeys('cls:')).map(k => k.slice(4));
    const metas = codes.length ? await dbPipe(codes.map(c => ['GET', 'cls:' + c]).concat(codes.map(c => ['SCARD', 'clsm:' + c]))) : [];
    const classes = codes.map((code, i) => {
      const c = metas[i] ? JSON.parse(metas[i]) : null;
      return c && { code, name: c.name, teacher: c.ownerName, count: metas[codes.length + i] || 0, live: !!c.live, at: c.at || 0 };
    }).filter(Boolean);
    return { levels, quests, accounts: acc, courses, classes, week: wk, at: now };
  },
  // ნებისმიერი კლასის დეტალები (მასწავლებლის ხედი)
  async ownerClass(b, ip) {
    await limit('owner', ip, 120, 3600);
    if (!isOwnerKey(String(b.key || '').trim())) throw new Fail(403, 'not_owner');
    const code = normCode(b.code), c = await getClass(code);
    if (!c) throw new Fail(404, 'class_none');
    return classDetail(code, c, true, '');
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

/* ---------- „Continue with GitHub“ (ცოცხალი გაკვეთილის GitHub: რეპოების სია, ჩატვირთვა, push) ----------
   GitHub → Settings → Developer settings → OAuth Apps → New: Authorization callback URL = https://<საიტი>/api/account
   Vercel-ში: GITHUB_CLIENT_ID და GITHUB_CLIENT_SECRET. ბაზა არ სჭირდება.
   GET ?gh=start — GitHub-ის ნებართვის გვერდზე გადამისამართება (state — HttpOnly cookie-ში, 10 წთ);
   GET ?gh=cb — code → ტოკენი; პასუხი პატარა გვერდია, რომელიც ტოკენს მხოლოდ იმავე საიტის გამხსნელ ფანჯარას (window.opener) გადასცემს და იხურება.
   ტოკენი სერვერზე არ ინახება. */
function ghPage(res, msg) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const data = JSON.stringify(msg).replace(/</g, '\\u003c');
  return res.status(200).send('<!doctype html><meta charset="utf-8"><title>GitHub</title><body style="font:16px system-ui;padding:24px">' + (msg.ghToken ? 'შესვლა შედგა — ფანჯარა იხურება…' : 'GitHub-ში შესვლა ვერ მოხერხდა. დახურე ეს ფანჯარა და სცადე თავიდან.') +
    '<script>try{window.opener&&window.opener.postMessage(' + data + ',location.origin)}catch(e){}setTimeout(function(){window.close()},' + (msg.ghToken ? 300 : 4000) + ')</script>');
}
// OAuth App-ის Client ID საჯაროა (საიდუმლო არ არის): მისით მუშაობს „Device Flow“ — საიდუმლო გასაღებისა და Vercel-ის ცვლადების გარეშე.
// GITHUB_CLIENT_SECRET-იც თუ არის, ღილაკი pop-up ფანჯრით შედის (?gh=start), თორემ — კოდით github.com/login/device-ზე
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Ov23litXELhInnYVvBBX';   // OAuth App „CodeQuest“ (lazarepataraia910-jpg), Device Flow ჩართულია
/* POST ?gh=device → { mode: 'web' } ან { user_code, verification_uri, interval, expires_in, device_code };
   POST ?gh=poll { device_code } → { token } ან { wait: true, interval } ან { error }. GitHub-ის ეს მისამართები ბრაუზერიდან (CORS) არ იხსნება, ამიტომ აქედან გადის */
async function ghDevice(req, res) {
  const gh = new URL(req.url || '/', 'http://x').searchParams.get('gh');
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!GH_CLIENT_ID) return res.status(503).json({ ok: false, error: 'no_oauth' });
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return r.json();
  };
  try {
    if (gh === 'device') {
      if (process.env.GITHUB_CLIENT_SECRET) return res.status(200).json({ ok: true, mode: 'web' });
      const j = await post('https://github.com/login/device/code', { client_id: GH_CLIENT_ID, scope: 'repo' });
      if (!j.device_code) return res.status(502).json({ ok: false, error: j.error || 'github' });
      return res.status(200).json({ ok: true, device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5, expires_in: j.expires_in || 900 });
    }
    if (gh === 'poll') {
      const dc = b && typeof b.device_code === 'string' && /^[\w-]{10,100}$/.test(b.device_code) ? b.device_code : '';
      if (!dc) return res.status(400).json({ ok: false, error: 'bad_request' });
      const j = await post('https://github.com/login/oauth/access_token', { client_id: GH_CLIENT_ID, device_code: dc, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (j.access_token) return res.status(200).json({ ok: true, token: j.access_token });
      if (j.error === 'authorization_pending' || j.error === 'slow_down') return res.status(200).json({ ok: true, wait: true, interval: j.interval || 0 });
      return res.status(200).json({ ok: false, error: j.error || 'github' });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'github' });
  }
  return res.status(400).json({ ok: false, error: 'bad_request' });
}
async function ghOauth(req, res) {
  const id = GH_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) return ghPage(res, { ghError: 'no_oauth' });
  const q = new URL(req.url || '/', 'http://x').searchParams, host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https', back = proto + '://' + host + '/api/account?gh=cb';
  const cookie = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('cq_ghs='));
  if (q.get('gh') === 'start') {
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', 'cq_ghs=' + state + '; Path=/api; Max-Age=600; HttpOnly; SameSite=Lax' + (proto === 'https' ? '; Secure' : ''));
    res.setHeader('Location', 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ client_id: id, redirect_uri: back, scope: 'repo', state, allow_signup: 'true' }));
    return res.status(302).end();
  }
  const state = cookie ? cookie.slice(7) : '', got = String(q.get('state') || '');
  res.setHeader('Set-Cookie', 'cq_ghs=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax');
  if (!state || state.length !== got.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(got)) || !q.get('code')) return ghPage(res, { ghError: 'state' });
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, code: q.get('code'), redirect_uri: back }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return ghPage(res, j.access_token ? { ghToken: j.access_token } : { ghError: 'denied' });
  } catch (e) {
    return ghPage(res, { ghError: 'server' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = String(req.headers.origin || '');
  if (origin && !originOk(origin) && !sameHost(req, origin)) return res.status(403).json({ ok: false, error: 'bad_origin' });
  if (burst(clientIp(req))) return res.status(429).json({ ok: false, error: 'rate_limited' });
  if (req.method === 'GET' && /[?&]gh=/.test(req.url || '')) return ghOauth(req, res);
  if (req.method === 'POST' && /[?&]gh=/.test(req.url || '')) return ghDevice(req, res);
  // მოსწავლის დაფა: GET ?live=ID — ყველასთვის ერთნაირი პასუხი, CDN-ში 1 წამით (ბაზას წამში ერთხელ მიმართავს)
  if (req.method === 'GET') {
    const id = normLive(new URL(req.url || '/', 'http://x').searchParams.get('live'));
    if (id && DB_URL && DB_TOKEN) {
      try {
        const raw = await db(['GET', 'live:' + id]);
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1');
        return res.status(200).json(raw ? JSON.parse(raw) : { id, end: true, gone: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'server' });
      }
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!DB_URL || !DB_TOKEN) return res.status(503).json({ ok: false, error: 'no_db' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const act = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
  if (!act) return res.status(400).json({ ok: false, error: 'bad_request' });
  const ip = clientIp(req);
  // ვებ-ბრაუზერი (Origin ჩვენი საიტია): ტოკენი cookie-დან; ძველი ვერსიის ტოკენი (JSON-ში) cookie-ში გადადის
  const web = !!origin, bodyTok = typeof body.token === 'string' && body.token ? body.token : '';
  if (!bodyTok && web) { const c = readCookie(req); if (c) body.token = c; }
  try {
    const out = Object.assign({ ok: true }, await act(body, ip));
    if (web) {
      // სესიის ახალი ნიშანი მხოლოდ ამ მოქმედებებიდან მოდის — ის cookie-ში გადადის და JSON-ში აღარ ჩანს
      if (out.token && /^(register|login|reset|resetLink|password)$/.test(body.action)) { setCookie(req, res, out.token); delete out.token; out.cookie = true; }
      else if (bodyTok && (body.action === 'me' || body.action === 'load' || body.action === 'save')) { setCookie(req, res, bodyTok); out.cookie = true; }
      if (body.action === 'logout' || body.action === 'delete') setCookie(req, res, '');
    }
    return res.status(200).json(out);
  } catch (e) {
    if (web && e instanceof Fail && e.code === 'no_session') setCookie(req, res, '');
    if (e instanceof Fail) return res.status(e.status).json(Object.assign({ ok: false, error: e.code }, e.extra || {}));
    console.error('account', body.action, e && e.message);
    return res.status(500).json({ ok: false, error: 'server' });
  }
};
