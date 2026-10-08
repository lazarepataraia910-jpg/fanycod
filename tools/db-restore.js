// CodeQuest-ის ბაზის აღდგენა სარეზერვო ასლიდან (db-backup.js-ის ფაილი).
//   node tools/db-restore.js <ფაილი.cqb> --dry-run            — მხოლოდ გაშიფვრა და შემოწმება (ბაზას არ ეხება)
//   node tools/db-restore.js <ფაილი.cqb> --yes [--verify]     — ჩაწერა UPSTASH_URL-ის ბაზაში (არსებული იგივე გასაღებები გადაიწერება)
// გარემო: BACKUP_KEY; ჩაწერისთვის — UPSTASH_URL და UPSTASH_TOKEN (ჩაწერის უფლებით).
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto');
const [file, ...flags] = process.argv.slice(2);
const has = f => flags.includes(f);
const PASS = String(process.env.BACKUP_KEY || '');
if (!file || !PASS) { console.error('usage: BACKUP_KEY=… node tools/db-restore.js <file.cqb> --dry-run | --yes [--verify]'); process.exit(2); }

function open(path) {
  const b = fs.readFileSync(path);
  if (b.subarray(0, 4).toString() !== 'CQB1') throw new Error('not a CodeQuest backup');
  const salt = b.subarray(4, 20), iv = b.subarray(20, 32), tag = b.subarray(32, 48);
  const key = crypto.scryptSync(PASS, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);   // არასწორი პაროლი ან დაზიანებული ფაილი აქ ჩავარდება
  const data = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(b.subarray(48)), d.final()])).toString('utf8'));
  if (data.v !== 1 || !Array.isArray(data.keys) || data.keys.length !== data.count) throw new Error('backup structure check failed');
  return data;
}
const URL_ = String(process.env.UPSTASH_URL || '').replace(/\/+$/, ''), TOKEN = String(process.env.UPSTASH_TOKEN || '');
async function pipe(cmds) {
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error('db ' + r.status);
  return j.map(x => { if (x.error) throw new Error('db: ' + x.error); return x.result; });
}
// ჩაწერის ბრძანებები ერთი გასაღებისთვის
function writeCmds([k, type, ttl, v]) {
  const c = [['DEL', k]];
  if (type === 'string') c.push(['SET', k, v]);
  else if (type === 'set' && v.length) for (let i = 0; i < v.length; i += 500) c.push(['SADD', k, ...v.slice(i, i + 500)]);
  else if (type === 'hash' && v.length) for (let i = 0; i < v.length; i += 1000) c.push(['HSET', k, ...v.slice(i, i + 1000)]);
  else if (type === 'list' && v.length) for (let i = 0; i < v.length; i += 500) c.push(['RPUSH', k, ...v.slice(i, i + 500)]);
  if (ttl > 0) c.push(['PEXPIRE', k, String(ttl)]);
  return c;
}
const same = (type, a, b) => {
  if (type === 'string') return a === b;
  if (type === 'set') return Array.isArray(b) && a.length === b.length && new Set(b).size === a.length && a.every(x => b.includes(x));
  if (type === 'hash') { const m = arr => { const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; }; return JSON.stringify(Object.entries(m(a)).sort()) === JSON.stringify(Object.entries(m(b || [])).sort()); }
  return JSON.stringify(a) === JSON.stringify(b);
};

(async () => {
  const data = open(file);
  const by = {};
  data.keys.forEach(([k]) => { const p = k.split(':')[0]; by[p] = (by[p] || 0) + 1; });
  console.log('backup from', data.at, '—', data.count, 'keys:', Object.entries(by).sort().map(([p, n]) => p + ':' + n).join('  '));
  // ცნობილი ჩანაწერები სწორად უნდა იკითხებოდეს (მომხმარებელი, პროგრესი)
  for (const [k, type, , v] of data.keys) {
    if (/^(user|cls|sum):/.test(k) && type === 'string') JSON.parse(v);
    if (/^prog:/.test(k) && type === 'string' && !(typeof v === 'string' && v.length)) throw new Error('empty progress ' + k);
  }
  if (has('--dry-run') || !has('--yes')) { console.log('dry run ok — nothing written' + (has('--yes') ? '' : ' (add --yes to write)')); return; }
  if (!URL_ || !TOKEN) throw new Error('UPSTASH_URL and UPSTASH_TOKEN are required to write');
  let batch = [], n = 0;
  for (const row of data.keys) {
    batch.push(...writeCmds(row));
    if (batch.length >= 300) { await pipe(batch); n += batch.length; batch = []; }
  }
  if (batch.length) { await pipe(batch); n += batch.length; }
  console.log('restored', data.count, 'keys (' + n + ' commands)');
  if (has('--verify')) {
    let bad = 0;
    for (let i = 0; i < data.keys.length; i += 200) {
      const part = data.keys.slice(i, i + 200);
      const got = await pipe(part.map(([k, type]) => ({ string: ['GET', k], set: ['SMEMBERS', k], hash: ['HGETALL', k], list: ['LRANGE', k, '0', '-1'] }[type])));
      part.forEach(([k, type, , v], j) => { if (!same(type, v, got[j])) { bad++; if (bad <= 5) console.log('MISMATCH', k); } });
    }
    if (bad) throw new Error('verify failed: ' + bad + ' keys differ');
    console.log('verify ok: all', data.count, 'keys match');
  }
})().catch(e => { console.error('restore failed:', e.message); process.exit(1); });
