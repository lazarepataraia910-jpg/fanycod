// ქართული ტექსტის ნაწყვეტები ფაილიდან — თარგმანის ლექსიკონისთვის (i18n/en/<ფაილი>.json).
// node i18n/extract.js index.html            — ყველა ნაწყვეტი, რომელსაც ლექსიკონში თარგმანი ჯერ არ აქვს
// node i18n/extract.js index.html --all      — ყველა ნაწყვეტი
// ნაწყვეტი: HTML-ის ტექსტი თეგებს შორის, ატრიბუტის მნიშვნელობა ან JS/JSON-ის სტრიქონი. კომენტარები არ ითარგმნება.
const fs = require('fs'), path = require('path');
const KA = /[Ⴀ-ჿ]/;

// HTML/JS-ის კომენტარების ამოღება (სიგრძე და ხაზები რჩება, რომ პოზიციები არ აირიოს)
function blankComments(src) {
  const blank = m => m.replace(/[^\n]/g, ' ');
  src = src.replace(/<!--[\s\S]*?-->/g, blank);
  let out = '', i = 0, q = null, inScript = false;
  while (i < src.length) {
    if (!q && src.startsWith('<script', i)) inScript = true;
    if (!q && src.startsWith('</script', i)) inScript = false;
    if (!q && src.startsWith('<style', i)) inScript = true;
    if (!q && src.startsWith('</style', i)) inScript = false;
    const c = src[i], n = src[i + 1];
    if (inScript) {
      if (q) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === q || (c === '\n' && q !== '`')) q = null; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
      if (c === '/' && n === '/' && src[i - 1] !== ':' && src[i - 1] !== '\\') { let j = i; while (j < src.length && src[j] !== '\n') j++; out += ' '.repeat(j - i); i = j; continue; }
      if (c === '/' && n === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; out += blank(src.slice(i, j)); i = j; continue; }
    }
    out += c; i++;
  }
  return out;
}

function segments(src) {
  const s = blankComments(src), out = new Set();
  // JS/JSON სტრიქონები
  const strRe = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = strRe.exec(s))) {
    const v = m[1] ?? m[2] ?? m[3];
    if (KA.test(v)) out.add(v);   // თეგებიანიც მთლიანად: „</h1>-ით“ ტიპის სუფიქსები ცალკე ვერ ითარგმნება
  }
  htmlText(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')).forEach(t => out.add(t));
  return [...out];
}
// HTML-ის ტექსტი თეგებს შორის და ატრიბუტები
function htmlText(s) {
  const out = [];
  let m;
  const textRe = />([^<>]*[Ⴀ-ჿ][^<>]*)</g;
  while ((m = textRe.exec(s))) out.push(m[1].trim());
  const attrRe = /\s[\w-]+="([^"]*[Ⴀ-ჿ][^"]*)"/g;
  while ((m = attrRe.exec(s))) out.push(m[1]);
  return out;
}

if (require.main === module) {
  const file = process.argv[2], all = process.argv.includes('--all');
  const src = fs.readFileSync(file, 'utf8');
  const dictFile = path.join(__dirname, 'en', path.basename(file) + '.json');
  const dict = fs.existsSync(dictFile) ? JSON.parse(fs.readFileSync(dictFile, 'utf8')) : {};
  const segs = segments(src).filter(t => all || dict[t] == null);
  console.log(JSON.stringify(Object.fromEntries(segs.map(t => [t, null])), null, 1));
  console.error(segs.length + ' segments' + (all ? '' : ' without translation'));
}
module.exports = { segments, blankComments };
