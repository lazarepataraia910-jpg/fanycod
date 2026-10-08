// CodeQuest-ის ბაზის (Upstash Redis) დაშიფრული სარეზერვო ასლი.
//   node tools/db-backup.js <ფაილი.cqb>
// გარემო: UPSTASH_URL, UPSTASH_TOKEN (საკმარისია read-only ტოკენი), BACKUP_KEY (დაშიფვრის პაროლი, მინიმუმ 16 სიმბოლო).
// ფაილი: "CQB1" + salt(16) + iv(12) + tag(16) + AES-256-GCM(gzip(JSON)). გასაღები = scrypt(BACKUP_KEY, salt).
// არ ინახება: სესიები (sess:), მცდელობების ლიმიტები (rl:), ცოცხალი გაკვეთილები (live:, livekey:) — ისინი დროებითია.
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto');
const URL_ = String(process.env.UPSTASH_URL || '').replace(/\/+$/, ''), TOKEN = String(process.env.UPSTASH_TOKEN || ''), PASS = String(process.env.BACKUP_KEY || '');
const out = process.argv[2];
if (!URL_ || !TOKEN || !out) { console.error('usage: UPSTASH_URL=… UPSTASH_TOKEN=… BACKUP_KEY=… node tools/db-backup.js <file.cqb>'); process.exit(2); }
if (PASS.length < 16) { console.error('BACKUP_KEY must be at least 16 characters'); process.exit(2); }
const SKIP = /^(sess|rl|live|livekey):/;

async function pipe(cmds) {
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error('db ' + r.status);
  return j.map(x => { if (x.error) throw new Error('db: ' + x.error); return x.result; });
}
const toArr = v => (Array.isArray(v) ? v : []);

(async () => {
  // 1. ყველა გასაღები (SCAN)
  const keys = [];
  let cur = '0';
  do {
    const [[next, batch]] = await pipe([['SCAN', cur, 'COUNT', '1000']]);
    cur = String(next);
    toArr(batch).forEach(k => { if (!SKIP.test(k)) keys.push(k); });
  } while (cur !== '0');
  // 2. ტიპი, ვადა და მნიშვნელობა — 200-200
  const rows = [];
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    const meta = await pipe(part.flatMap(k => [['TYPE', k], ['PTTL', k]]));
    const read = part.map((k, j) => ({ string: ['GET', k], set: ['SMEMBERS', k], hash: ['HGETALL', k], list: ['LRANGE', k, '0', '-1'] }[meta[j * 2]] || null));
    const vals = await pipe(read.filter(Boolean));
    let n = 0;
    part.forEach((k, j) => {
      if (!read[j]) { if (meta[j * 2] !== 'none') console.warn('skip unsupported type', meta[j * 2]); return; }
      rows.push([k, meta[j * 2], +meta[j * 2 + 1], vals[n++]]);
    });
  }
  // 3. დაშიფვრა
  const json = JSON.stringify({ v: 1, at: new Date().toISOString(), count: rows.length, keys: rows });
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(PASS, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(json)), c.final()]);
  fs.writeFileSync(out, Buffer.concat([Buffer.from('CQB1'), salt, iv, c.getAuthTag(), body]));
  // მხოლოდ რაოდენობები (მონაცემები ლოგში არ იწერება)
  const by = {};
  rows.forEach(([k]) => { const p = k.split(':')[0]; by[p] = (by[p] || 0) + 1; });
  console.log('backup ok:', rows.length, 'keys,', body.length, 'bytes →', out);
  console.log(Object.entries(by).sort().map(([p, n]) => p + ':' + n).join('  '));
})().catch(e => { console.error('backup failed:', e.message); process.exit(1); });
