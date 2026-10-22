// ინგლისური ვერსია: en/<გვერდი> იქმნება ქართული გვერდიდან და ლექსიკონიდან i18n/en/<გვერდი>.json.
// ლექსიკონი: { "ქართული ნაწყვეტი": "English", ..., "_raw": [["ზუსტი ტექსტი", "ჩანაცვლება"], ...] }
//   — ნაწყვეტი იცვლება მხოლოდ მთლიანად (ბრჭყალებს ან თეგებს შორის), გრძელი — პირველი;
//   — _raw ჯერ სრულდება და ნებისმიერ ტექსტს ცვლის (lang, canonical, ბმულები).
// თარგმანში ' " ` და \ ისეთივე რაოდენობით უნდა იყოს, როგორც ორიგინალში — თორემ JS/HTML გატყდება.
// null — ჯერ არ არის ნათარგმნი (ტექსტი ქართულად რჩება), "" — ნაწყვეტი ინგლისურში საჭირო არ არის. Vercel: /en/* → /* თუ ფაილი en/-ში არ არის.
// node i18n/build.js — აწყობა და დარჩენილი ქართული ტექსტის ანგარიში
const fs = require('fs'), path = require('path');
const { blankComments } = require('./extract');
const ROOT = path.join(__dirname, '..'), DICT = path.join(ROOT, 'i18n', 'en'), OUT = path.join(ROOT, 'en');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (s, ch) => s.split(ch).length - 1;

function translate(src, dict, file) {
  const errors = [];
  for (const [a, b] of dict._raw || []) {
    if (!src.includes(a)) errors.push('_raw ვერ მოიძებნა: ' + a.slice(0, 80));
    src = src.split(a).join(b);
  }
  const keys = Object.keys(dict).filter(k => k !== '_raw' && dict[k] != null);
  for (const k of keys) for (const ch of ["'", '"', '`', '\\']) if (count(k, ch) !== count(dict[k], ch)) errors.push('ბრჭყალები/\\ არ ემთხვევა (' + ch + '): ' + k.slice(0, 80));
  if (errors.length) throw new Error(file + ':\n  ' + errors.join('\n  '));
  if (!keys.length) return src;
  keys.sort((a, b) => b.length - a.length);
  // მხოლოდ მთლიანი ნაწყვეტი: სტრიქონი ბრჭყალებს შორის ან HTML-ის ტექსტი თეგებს შორის
  const re = new RegExp('(?<=[>\'"`]\\s*)(?:' + keys.map(esc).join('|') + ')(?=\\s*[<\'"`])', 'g');
  return src.replace(re, m => dict[m]);
}
const kaLeft = s => (blankComments(s).match(/[Ⴀ-ჿ]/g) || []).length;

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  let failed = false;
  for (const f of fs.readdirSync(DICT).filter(f => f.endsWith('.json'))) {
    const page = f.slice(0, -5), src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    try {
      const out = translate(src, JSON.parse(fs.readFileSync(path.join(DICT, f), 'utf8')), page);
      fs.writeFileSync(path.join(OUT, page), out);
      const a = kaLeft(src), b = kaLeft(out);
      console.log('en/' + page + ': ' + Math.round(100 * (a - b) / (a || 1)) + '% ნათარგმნი (' + b + ' ქართული ასო დარჩა)');
    } catch (e) { console.error(e.message); failed = true; }
  }
  if (failed) process.exit(1);
}
module.exports = { translate };
