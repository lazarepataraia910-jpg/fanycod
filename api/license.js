// CodeQuest Pro: ლიცენზიის კოდის შემოწმება Dodo Payments-თან და Pro-ს ხელმოწერილი ნიშნის (token) გაცემა.
// Dodo-ს API ბრაუზერიდან პირდაპირ არ იძახება (CORS), ამიტომ თამაში ამ Vercel-ის ფუნქციას მიმართავს.
// Vercel → Settings → Environment Variables:
//   DODO_MODE       — live (ნამდვილი გადახდები) ან test (სატესტო, ნაგულისხმევი)
//   PRO_PRIVATE_KEY — ხელმოწერის საიდუმლო გასაღები (ECDSA P-256, PKCS8 DER base64). მისი საჯარო ნაწილი თამაშშია (PRO.pub).
//                     თამაში Pro-ს მხოლოდ ამ გასაღებით ხელმოწერილ ნიშანს ენდობა — ბრაუზერში ხელით ჩართვა აღარ გამოდის.
//   OWNER_KEYS      — მფლობელის კოდები მძიმით (Dodo-ს გარეშე მოქმედებს), მაგ. CQ-OWNER-XXXX-XXXX-XXXX
const crypto = require('crypto');
const BASE = { live: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' };

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
// მფლობელის კოდი (დროის მიხედვით შედარება, რომ კოდი ასო-ასო ვერ გამოიცნონ)
function isOwnerKey(key) {
  const h = sha(key);
  return String(process.env.OWNER_KEYS || '').split(',').map(s => s.trim()).filter(s => s.length >= 12)
    .some(k => crypto.timingSafeEqual(sha(k), h));
}
// ნიშანი: base64url(JSON) + '.' + base64url(ხელმოწერა); JSON-ში მხოლოდ კოდის ჰეშის ნაწილი და დრო
function sign(key) {
  const pk = String(process.env.PRO_PRIVATE_KEY || '').replace(/\s+/g, '');
  if (!pk) return null;
  const payload = Buffer.from(JSON.stringify({ v: 1, kh: sha(key).toString('hex').slice(0, 16), iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(pk, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return payload + '.' + sig.toString('base64url');
}
function ok(res, key) {
  let token = null;
  try { token = sign(key); } catch (e) { token = null; }
  return res.status(200).json(token ? { valid: true, token } : { valid: true, token: null, error: 'no_signing_key' });
}

/* ---------- ვინ შეიძლება მოგვმართოს (CORS) და IP-ზე ზოგადი ლიმიტი ---------- */
// ბრაუზერიდან — მხოლოდ ჩვენი საიტი (და ლოკალური ტესტი). Origin-ის გარეშე მოდის კომპიუტერის პროგრამა (Electron-ის proxy) და სერვერები.
// ქვიშის ყუთის iframe-ები (მოსწავლის / მასწავლებლის კოდი) Origin: null-ს აგზავნიან — უარი.
const SITE = 'https://codequest-lazare.vercel.app';
const ORIGINS = [SITE].concat(String(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const originOk = o => ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o);
// ერთ სერვერულ ასლზე: IP-დან წუთში მაქსიმუმ 600 მოთხოვნა (ბაზის ბრძანებების გარეშე, რომ შეტევამ ლიმიტი არ ამოწუროს)
const HITS = new Map();
function burst(ip) {
  const now = Date.now();
  let h = HITS.get(ip);
  if (!h || now - h.t > 60000) { if (HITS.size > 5000) HITS.clear(); h = { t: now, n: 0 }; HITS.set(ip, h); }
  return ++h.n > 600;
}
const clientIp = req => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();

const DB_URL = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = String(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '');
async function tooMany(ip) {
  if (!DB_URL || !DB_TOKEN) return false;
  try {
    const k = 'rl:lic:' + sha(ip).toString('hex').slice(0, 32);
    const r = await fetch(DB_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify([['SET', k, 0, 'EX', 900, 'NX'], ['INCR', k]]) });
    const j = await r.json();
    return Array.isArray(j) && j[1] && j[1].result > 60;
  } catch (e) { return false; }   // ბაზის შეცდომამ ყიდვა არ უნდა დაბლოკოს
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = String(req.headers.origin || '');
  if (origin && !originOk(origin)) return res.status(403).json({ valid: false, error: 'bad_origin' });
  if (burst(clientIp(req))) return res.status(429).json({ valid: false, error: 'rate_limited' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ valid: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const key = String((body && body.license_key) || '').trim();
  if (!key || key.length > 200) return res.status(400).json({ valid: false, error: 'bad_key' });
  if (await tooMany(clientIp(req))) return res.status(429).json({ valid: false, error: 'rate_limited' });

  if (isOwnerKey(key)) return ok(res, key);

  const base = BASE[process.env.DODO_MODE] || BASE.test;
  try {
    const r = await fetch(base + '/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key })
    });
    if (r.status === 404 || r.status === 422) return res.status(200).json({ valid: false });
    if (!r.ok) return res.status(502).json({ valid: false, error: 'upstream_' + r.status });
    const data = await r.json();
    return data.valid === true ? ok(res, key) : res.status(200).json({ valid: false });
  } catch (e) {
    return res.status(502).json({ valid: false, error: 'upstream_unreachable' });
  }
};
