// აპის ასაწყობად: ../CodeQuest.html → app/CodeQuest.html, ხოლო CDN-ის ფაილები (CodeMirror, React, შრიფტები) → app/ext/,
// რომ თამაშმა პირველივე გაშვებაზე ინტერნეტის გარეშეც იმუშაოს. ფაილის სახელი = sha1(მისამართი), ზუსტად როგორც main.js-ში.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = process.env.CODEQUEST_HTML || path.join(__dirname, '..', 'CodeQuest.html');
const OUT = path.join(__dirname, 'app');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const keyOf = url => crypto.createHash('sha1').update(url).digest('hex');

async function get(url) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'application/octet-stream' };
    } catch (e) {
      if (a >= 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
}
let files = 0, bytes = 0;
function save(url, body, type) {
  const href = new URL(url).href, k = keyOf(href);
  fs.writeFileSync(path.join(OUT, 'ext', k + '.bin'), body);
  fs.writeFileSync(path.join(OUT, 'ext', k + '.json'), JSON.stringify({ url: href, type }));
  files++; bytes += body.length;
}

(async () => {
  const html = fs.readFileSync(SRC, 'utf8');
  if (!html.includes('id="scr-menu"')) throw new Error('CodeQuest.html ვერ მოიძებნა: ' + SRC);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'ext'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'CodeQuest.html'), html);
  fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({ at: Date.now() }));

  for (const u of new Set(html.match(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[^"'\s<>)]+/g) || [])) {
    const r = await get(u);
    save(u, r.body, r.type);
  }
  // Google Fonts: CSS (ჩრომის UA-ით → woff2) და მასში ჩაწერილი შრიფტის ფაილები
  for (const u of new Set((html.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"'\s<>]+/g) || []).map(x => x.replace(/&amp;/g, '&')))) {
    const r = await get(u), css = r.body.toString('utf8');
    for (const f of new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || [])) {
      const x = await get(f);
      save(f, x.body, x.type);
    }
    save(u, Buffer.from(css.replace(/https:\/\/fonts\.gstatic\.com\//g, 'codequest://app/_ext/fonts.gstatic.com/')), r.type);
  }
  console.log('app/: CodeQuest.html (' + (html.length / 1048576).toFixed(1) + ' MB) + ' + files + ' CDN-ფაილი (' + (bytes / 1048576).toFixed(1) + ' MB)');
})().catch(e => { console.error('bundle:', e.message); process.exit(1); });
