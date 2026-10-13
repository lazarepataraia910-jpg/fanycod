// „ისწავლე კოდინგი“ — სკოლის გენერატორი (დამოკიდებულებების გარეშე).
//   curriculum/*.json (კურსის რუკა) + content/{კურსი}/{დონე}/{მოდული}/{თავი}.mdx  →  learn/ (სტატიკური გვერდები),
//   learn/data.json (დაფისთვის), learn/search.json (ძებნა), sitemap.xml.
// გაშვება: node school/build.js  (Vercel-ზე — buildCommand). ახალი JSON / MDX ფაილი კოდის შეცვლას არ საჭიროებს:
// თავი, რომლის ფაილიც არსებობს, იხსნება; დანარჩენი „მალე“ ნიშნით ჩანს. კონტენტის შეცდომა აწყობას არ აჩერებს — გაფრთხილებად იბეჭდება.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'learn');
const SITE = 'https://codequest.space';
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/', SRI = require('./cdn.json');
const LEVELS = [['beginner', 'დამწყები'], ['intermediate', 'საშუალო'], ['advanced', 'მოწინავე'], ['expert', 'ექსპერტი']];
const XP = { chapter: 20, quiz: 50, project: 100 };   // იგივე რიცხვები: school/learn.js და CodeQuest.html (schoolXP)
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/, RESERVED = new Set(LEVELS.map(l => l[0]).concat('quiz', 'project', 'courses', 'roadmaps', 'dashboard'));
// კოდის ენები: სახელი, CodeMirror-ის mime და რეჟიმის ფაილები
const LANGS = {
  js: ['JavaScript', 'text/javascript', ['javascript']], ts: ['TypeScript', 'text/typescript', ['javascript']], json: ['JSON', 'application/json', ['javascript']],
  jsx: ['JSX', 'text/jsx', ['xml', 'javascript', 'jsx']], tsx: ['TSX', 'text/typescript-jsx', ['xml', 'javascript', 'jsx']],
  html: ['HTML', 'text/html', ['xml', 'javascript', 'css', 'htmlmixed']], css: ['CSS', 'text/css', ['css']],
  python: ['Python', 'text/x-python', ['python']], java: ['Java', 'text/x-java', ['clike']], c: ['C', 'text/x-csrc', ['clike']], cpp: ['C++', 'text/x-c++src', ['clike']],
  csharp: ['C#', 'text/x-csharp', ['clike']], kotlin: ['Kotlin', 'text/x-kotlin', ['clike']], go: ['Go', 'text/x-go', ['go']], rust: ['Rust', 'text/x-rustsrc', ['rust']],
  php: ['PHP', 'text/x-php', ['xml', 'javascript', 'css', 'htmlmixed', 'clike', 'php']], swift: ['Swift', 'text/x-swift', ['swift']], sql: ['SQL', 'text/x-sql', ['sql']],
  bash: ['ტერმინალი', 'text/x-sh', ['shell']], yaml: ['YAML', 'text/x-yaml', ['yaml']], dockerfile: ['Dockerfile', 'text/x-dockerfile', ['simple', 'dockerfile']],
  text: ['ტექსტი', '', []], output: ['შედეგი', '', []]
};
const ALIAS = { javascript: 'js', typescript: 'ts', py: 'python', sh: 'bash', shell: 'bash', 'c++': 'cpp', cs: 'csharp', kt: 'kotlin', rs: 'rust', yml: 'yaml' };
const RUNNABLE = new Set(['js', 'html']);   // ბრაუზერში ნამდვილად ეშვება; დანარჩენზე „გაუშვი“ მოსალოდნელ შედეგს აჩვენებს (```output)

const warn = [];
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');

// 👑 სკოლის თავები Pro-ს ნაწილია (შემოწმება — school/learn.js). ხელმოწერის საჯარო გასაღები და ფასი ერთ ადგილას წერია: CodeQuest.html → PRO.
// გასაღების გარეშე გვერდები ყველასთვის ჩაიკეტებოდა, ამიტომ მისი ვერპოვნა აწყობას აჩერებს (deploy ჩავარდება, საიტი ძველ ვერსიაზე რჩება)
const PRO = (() => {
  const g = read(path.join(ROOT, 'CodeQuest.html')) || '', k = /pub: Object\.freeze\(\{ kty: 'EC', crv: 'P-256', x: '([\w-]+)', y: '([\w-]+)' \}\)/.exec(g), p = /price: '([^']*)'/.exec(g);
  if (!k) throw new Error('CodeQuest.html-ში Pro-ს საჯარო გასაღები (PRO.pub) ვერ მოიძებნა');
  return { key: k[1] + '.' + k[2], price: p && p[1] ? ' · ' + p[1] : '' };
})();

/* ---------- MDX-ის ქვესიმრავლე: frontmatter + Markdown + <Exercise> <Hint> <Solution> <Quiz> ---------- */
function frontmatter(src) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src), meta = {};
  if (!m) return { meta, body: src };
  m[1].split(/\r?\n/).forEach(l => {
    const i = l.indexOf(':');
    if (i < 1) return;
    let v = l.slice(i + 1).trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (/^\d+$/.test(v)) v = +v;
    else v = v.replace(/^["']|["']$/g, '');
    meta[l.slice(0, i).trim()] = v;
  });
  return { meta, body: src.slice(m[0].length) };
}
// სტრიქონის შიგნით: `კოდი`, **მუქი**, *დახრილი*, [ბმული](მისამართი). დანარჩენი HTML უვნებელდება
function inline(s) {
  const codes = [];
  s = String(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (/^(https?:\/\/|\/|#)/.test(u) ? '<a href="' + u + '"' + (/^http/.test(u) ? ' target="_blank" rel="noopener"' : '') + '>' + t + '</a>' : m));
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[i]) + '</code>');
}
const plain = s => String(s).replace(/[`*]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

function codeBlock(lang, run, text, ctx, expect) {
  lang = ALIAS[lang] || lang || 'text';
  if (!LANGS[lang]) { ctx.warn('უცნობი ენა ```' + lang); lang = 'text'; }
  const L = LANGS[lang];
  if (L[1]) ctx.langs.add(lang);
  ctx.blocks++;
  if (!run) return '<div class="code"><div class="code-h"><span>' + L[0] + '</span>' + (lang === 'output' ? '' : '<button type="button" class="copy">კოპირება</button>') + '</div><pre><code data-lang="' + lang + '" data-mime="' + L[1] + '">' + esc(text) + '</code></pre></div>';
  ctx.runs++;
  if (!RUNNABLE.has(lang) && expect == null) ctx.warn('```' + lang + ' run — მოსალოდნელი შედეგი (```output) აკლია');
  return '<div class="run" data-lang="' + lang + '" data-mime="' + L[1] + '"' + (expect != null && !RUNNABLE.has(lang) ? ' data-expect="' + esc(expect) + '"' : '') + '><div class="code-h"><span>' + L[0] + ' · სცადე თავად</span><button type="button" class="run-reset">↺ საწყისი კოდი</button></div>' +
    '<textarea class="run-src" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="კოდის რედაქტორი" rows="' + Math.min(20, text.split('\n').length + 1) + '">' + esc(text) + '</textarea>' +
    '<div class="run-bar"><button type="button" class="btn primary run-go">▶ გაუშვი</button><span class="run-note"></span></div><div class="run-out" aria-live="polite" hidden></div></div>';
}
// <Quiz> … </Quiz>: „### კითხვა“, „- [ ] პასუხი“ / „- [x] სწორი პასუხი“, „> ახსნა“
function quizBlock(lines, ctx) {
  const qs = [];
  let q = null;
  lines.forEach(l => {
    let m;
    if ((m = /^#{2,4}\s+(.*)$/.exec(l))) qs.push(q = { t: m[1], o: [], ok: -1, x: '' });
    else if (q && (m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(l))) { if (m[1] !== ' ') q.ok = q.o.length; q.o.push(m[2]); }
    else if (q && (m = /^>\s?(.*)$/.exec(l))) q.x += (q.x ? ' ' : '') + m[1];
    else if (q && l.trim() && !q.o.length) q.t += ' ' + l.trim();
  });
  const good = qs.filter(x => { const ok = x.o.length >= 2 && x.ok >= 0; if (!ok) ctx.warn('ქვიზის კითხვას სწორი პასუხი ან ვარიანტები აკლია: ' + x.t.slice(0, 40)); return ok; });
  ctx.questions += good.length;
  good.forEach(x => ctx.text.push(plain([x.t].concat(x.o, x.x).join(' '))));
  return '<div class="quiz" data-quiz="' + ctx.kind + '">' + good.map((x, n) => '<div class="q" data-ok="' + x.ok + '"><p class="q-t"><span class="q-n">' + (n + 1) + '</span>' + inline(x.t) + '</p><div class="q-opts">' +
    x.o.map(o => '<button type="button" class="q-o">' + inline(o) + '</button>').join('') + '</div><p class="q-x" hidden>' + inline(x.x) + '</p></div>').join('') +
    (ctx.kind === 'quiz' ? '<div class="quiz-res" hidden aria-live="polite"></div>' : '') + '</div>';
}
function md(src, ctx) {
  const L = src.replace(/\r\n/g, '\n').split('\n'), out = [], para = [];
  const flush = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); ctx.text.push(plain(para.join(' '))); para.length = 0; } };
  const until = (i, re) => { const b = []; while (i < L.length && !re.test(L[i])) b.push(L[i++]); return [b, i + 1]; };
  const heading = (text, lvl, cls) => { const id = 's' + (++ctx.ids); if (lvl === 2) ctx.toc.push({ id, text: plain(text) }); ctx.heads.push(plain(text)); return '<h' + lvl + ' id="' + id + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + inline(text) + '</h' + lvl + '>'; };
  let i = 0, m, b;
  while (i < L.length) {
    const l = L[i];
    if ((m = /^```\s*([\w+#-]*)\s*(run)?\s*$/.exec(l))) {
      flush();
      [b, i] = until(i + 1, /^```\s*$/);
      let expect = null, j = i;
      while (j < L.length && !L[j].trim()) j++;
      if (m[2] && !RUNNABLE.has(ALIAS[m[1]] || m[1]) && /^```\s*output\s*$/.test(L[j] || '')) { let e; [e, i] = until(j + 1, /^```\s*$/); expect = e.join('\n'); }
      out.push(codeBlock(m[1], !!m[2], b.join('\n'), ctx, expect));
    } else if ((m = /^<(Exercise|Hint|Solution|Quiz)>\s*(.*?)\s*(<\/\1>)?\s*$/.exec(l))) {
      flush();
      const tag = m[1];
      if (m[3]) { b = [m[2]]; i++; } else { [b, i] = until(i + 1, new RegExp('^</' + tag + '>\\s*$')); if (m[2]) b.unshift(m[2]); }
      if (tag === 'Quiz') out.push((ctx.kind === 'quiz' ? '' : heading('მინი-ქვიზი', 2)) + quizBlock(b, ctx));
      else if (tag === 'Exercise') { ctx.exercises++; out.push('<section class="exercise">' + heading('სავარჯიშო', 2) + md(b.join('\n'), ctx) + '</section>'); }
      else out.push('<details class="' + (tag === 'Hint' ? 'hint' : 'solution') + '"><summary>' + (tag === 'Hint' ? '💡 მინიშნება' : '✅ ამოხსნის ნახვა') + '</summary>' + md(b.join('\n'), ctx) + '</details>');
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { flush(); out.push(heading(m[2], Math.min(4, Math.max(2, m[1].length)))); i++; }
    else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      flush();
      const ol = /^\s*\d+\./.test(l), items = [];
      while (i < L.length && (/^\s*([-*]|\d+\.)\s+/.test(L[i]) || (/^\s{2,}\S/.test(L[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(L[i])) items.push(L[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); else items[items.length - 1] += ' ' + L[i].trim();
        i++;
      }
      items.forEach(t => ctx.text.push(plain(t)));
      out.push('<' + (ol ? 'ol' : 'ul') + '>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</' + (ol ? 'ol' : 'ul') + '>');
    } else if (/^\|.*\|\s*$/.test(l)) {
      flush();
      const rows = [];
      while (i < L.length && /^\|.*\|\s*$/.test(L[i])) rows.push(L[i++].trim().slice(1, -1).split('|').map(c => c.trim()));
      const head = rows.length > 1 && rows[1].every(c => /^:?-+:?$/.test(c)) ? rows.shift() : null;
      if (head) rows.shift();
      out.push('<div class="tbl"><table>' + (head ? '<thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>' : '') + '<tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
    } else if (/^>\s?/.test(l)) {
      flush(); b = [];
      while (i < L.length && /^>\s?/.test(L[i])) b.push(L[i++].replace(/^>\s?/, ''));
      ctx.text.push(plain(b.join(' ')));
      out.push('<blockquote>' + inline(b.join(' ')) + '</blockquote>');
    } else if (/^---+\s*$/.test(l)) { flush(); out.push('<hr>'); i++; }
    else if (!l.trim()) { flush(); i++; }
    else { para.push(l.trim()); i++; }
  }
  flush();
  return out.join('\n');
}
// kind: chapter | quiz | project
function parseDoc(file, kind) {
  const src = read(file);
  if (src == null) return null;
  const { meta, body } = frontmatter(src);
  const ctx = { kind, toc: [], heads: [], text: [], langs: new Set(), ids: 0, blocks: 0, runs: 0, exercises: 0, questions: 0, warn: m => warn.push(rel(file) + ': ' + m) };
  const html = md(body, ctx), text = ctx.text.join(' ').replace(/\s+/g, ' ').trim(), words = text.split(' ').filter(Boolean).length;
  if (kind === 'chapter') {   // შაბლონის შემოწმება — მხოლოდ გაფრთხილება
    const miss = [];
    ['რას ისწავლი', 'ხშირი შეცდომები', 'შეჯამება'].forEach(h => { if (!ctx.heads.some(x => x.includes(h))) miss.push('„' + h + '“'); });
    if (!ctx.blocks) miss.push('კოდის მაგალითი');
    if (!ctx.runs) miss.push('ინტერაქტიული რედაქტორი (```ენა run)');
    if (!ctx.exercises) miss.push('<Exercise>');
    if (ctx.questions !== 3) miss.push('მინი-ქვიზი 3 კითხვით (ახლა ' + ctx.questions + ')');
    if (miss.length) ctx.warn('შაბლონს აკლია: ' + miss.join(', '));
    if (words < 400 || words > 900) ctx.warn('მოცულობა ' + words + ' სიტყვა (რეკომენდებული 400–800)');
  }
  return { meta, html, toc: ctx.toc, text, words, langs: [...ctx.langs], runs: ctx.runs, questions: ctx.questions, minutes: +meta.readingTime || Math.max(2, Math.round(words / 110)) };
}

/* ---------- კურსები ---------- */
function loadCourses() {
  const dir = path.join(ROOT, 'curriculum');
  const courses = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => {
    let c;
    try { c = JSON.parse(read(path.join(dir, f))); } catch (e) { warn.push('curriculum/' + f + ': ' + e.message); return null; }
    c.slug = f.slice(0, -5);
    if (!SLUG.test(c.slug) || RESERVED.has(c.slug) || !c.title) { warn.push('curriculum/' + f + ': არასწორი slug ან სათაური — გამოტოვებულია'); return null; }
    const seen = new Set(), base = path.join(ROOT, 'content', c.slug);
    c.items = [];   // ხელმისაწვდომი გვერდები რიგით (წინა / შემდეგი)
    c.planned = 0;
    c.levels = LEVELS.map(([ls, lt]) => {
      const lv = (Array.isArray(c.levels) ? c.levels : []).find(x => x && x.slug === ls) || {};
      const out = { slug: ls, title: lt, project: lv.project && lv.project.title ? lv.project : null, modules: [] };
      (Array.isArray(lv.modules) ? lv.modules : []).forEach(mo => {
        if (!mo || !SLUG.test(mo.slug || '') || RESERVED.has(mo.slug) || seen.has(mo.slug)) { warn.push('curriculum/' + f + ': მოდულის slug არასწორია ან მეორდება: ' + (mo && mo.slug)); return; }
        seen.add(mo.slug);
        const mdir = path.join(base, ls, mo.slug), chs = new Set();
        const m = { slug: mo.slug, title: mo.title || mo.slug, description: mo.description || '', level: out, chapters: [] };
        (Array.isArray(mo.chapters) ? mo.chapters : []).forEach(ch => {
          if (!ch || !SLUG.test(ch.slug || '') || RESERVED.has(ch.slug) || chs.has(ch.slug)) { warn.push('curriculum/' + f + ': თავის slug არასწორია ან მეორდება: ' + mo.slug + '/' + (ch && ch.slug)); return; }
          chs.add(ch.slug);
          const it = { kind: 'chapter', id: c.slug + '/' + mo.slug + '/' + ch.slug, title: ch.title || ch.slug, description: ch.description || '', module: m, course: c, doc: parseDoc(path.join(mdir, ch.slug + '.mdx'), 'chapter') };
          if (it.doc && it.doc.meta.title) it.title = it.doc.meta.title;
          m.chapters.push(it); c.planned++;
          if (it.doc) c.items.push(it);
        });
        m.quiz = { kind: 'quiz', id: c.slug + '/' + mo.slug + '/quiz', title: 'ქვიზი: ' + m.title, description: 'შეამოწმე, რა ისწავლე მოდულში „' + m.title + '“.', module: m, course: c, doc: parseDoc(path.join(mdir, 'quiz.mdx'), 'quiz') };
        if (m.quiz.doc) c.items.push(m.quiz);
        out.modules.push(m);
      });
      if (out.project) {
        out.projectItem = { kind: 'project', id: c.slug + '/' + ls + '/project', title: 'პროექტი: ' + out.project.title, description: out.project.description || '', level: out, course: c, doc: parseDoc(path.join(base, ls, 'project.mdx'), 'project') };
        if (out.projectItem.doc) c.items.push(out.projectItem);
      }
      return out;
    });
    c.syllabus = c.levels.some(l => l.modules.length);
    c.minutes = c.items.reduce((a, it) => a + it.doc.minutes, 0);
    c.full = c.planned > 0 && c.items.filter(it => it.kind === 'chapter').length === c.planned;
    return c;
  }).filter(Boolean).sort((a, b) => (a.order || 999) - (b.order || 999) || a.slug.localeCompare(b.slug));
  // content/-ში ფაილი, რომელიც სილაბუსში არ არის — ავტორს შევახსენოთ
  const known = new Set();
  courses.forEach(c => c.levels.forEach(l => { known.add('content/' + c.slug + '/' + l.slug + '/project.mdx'); l.modules.forEach(m => { known.add('content/' + c.slug + '/' + l.slug + '/' + m.slug + '/quiz.mdx'); m.chapters.forEach(ch => known.add('content/' + c.slug + '/' + l.slug + '/' + m.slug + '/' + ch.id.split('/')[2] + '.mdx')); }); }));
  (function walk(d) { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } list.forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.mdx') && !known.has(rel(p))) warn.push(rel(p) + ': სილაბუსში (curriculum) არ არის — გვერდი არ შეიქმნა'); }); })(path.join(ROOT, 'content'));
  return courses;
}

/* ---------- გვერდების ჩარჩო ---------- */
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, f))).digest('hex').slice(0, 8);
const ASSET = { css: '/school/learn.css?v=' + hash('learn.css'), js: '/school/learn.js?v=' + hash('learn.js') };
const cdnTag = f => (f.endsWith('.css') ? '<link rel="stylesheet" href="' + CDN + f + '" integrity="' + SRI[f] + '" crossorigin="anonymous" referrerpolicy="no-referrer">' : '<script src="' + CDN + f + '" integrity="' + SRI[f] + '" crossorigin="anonymous" referrerpolicy="no-referrer" defer></script>');
const modeFile = m => (m === 'simple' ? 'addon/mode/simple.min.js' : 'mode/' + m + '/' + m + '.min.js');
const time = min => (min >= 60 ? Math.floor(min / 60) + ' სთ' + (min % 60 ? ' ' + (min % 60) + ' წთ' : '') : min + ' წთ');
const url = p => '/learn/' + (p ? p + '/' : '');
const pages = [];   // { path, html } + sitemap

function shell(o) {
  const langs = o.langs || [], modes = [...new Set(langs.flatMap(l => LANGS[l][2]))];
  const cm = langs.length ? ['codemirror.min.js', 'addon/runmode/runmode.min.js', ...modes.map(modeFile)] : [];
  const canon = SITE + url(o.path), title = o.title + ' · ისწავლე კოდინგი', nav = (p, t) => '<a href="' + url(p) + '"' + (o.nav === p ? ' aria-current="page"' : '') + '>' + t + '</a>';
  return '<!DOCTYPE html>\n<html lang="ka" data-theme="dark" data-pro="' + PRO.key + '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(o.desc) + '">\n<link rel="canonical" href="' + canon + '">\n' + (o.noindex ? '<meta name="robots" content="noindex">\n' : '') +
    '<meta property="og:type" content="' + (o.article ? 'article' : 'website') + '">\n<meta property="og:site_name" content="ისწავლე კოდინგი · CodeQuest">\n<meta property="og:locale" content="ka_GE">\n<meta property="og:title" content="' + esc(title) + '">\n' +
    '<meta property="og:description" content="' + esc(o.desc) + '">\n<meta property="og:url" content="' + canon + '">\n<meta property="og:image" content="' + SITE + '/og.jpg">\n<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="theme-color" content="#0b0f14">\n<link rel="icon" href="/favicon.ico">\n' +
    '<script>try{var t=localStorage.getItem("cq.learn.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@400;600;700;800&amp;family=JetBrains+Mono:wght@400;600&amp;display=swap">\n' +
    (cm.length ? cdnTag('codemirror.min.css') + '\n' : '') + '<link rel="stylesheet" href="' + ASSET.css + '">\n' +
    '<!-- Vercel Web Analytics -->\n<script>if (location.protocol === \'https:\') { window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); }; var s = document.createElement(\'script\'); s.defer = true; s.src = \'/_vercel/insights/script.js\'; document.head.appendChild(s); }</script>\n' +
    '</head>\n<body class="' + (o.cls || '') + '">\n<a class="skip" href="#main">გადადი შინაარსზე</a>\n' +
    '<header class="top"><div class="top-in"><a class="logo" href="/learn/"><span class="logo-m" aria-hidden="true">&lt;/&gt;</span><span>ისწავლე <b>კოდინგი</b></span></a>' +
    '<button type="button" class="ic-btn nav-t" id="nav-t" aria-label="მენიუ" aria-expanded="false" aria-controls="nav">☰</button>' +
    '<nav class="nav" id="nav" aria-label="მთავარი მენიუ">' + nav('courses', 'კურსები') + nav('roadmaps', 'სასწავლო გზები') + nav('dashboard', 'ჩემი დაფა') + '<a href="/CodeQuest.html">🎮 თამაში</a></nav>' +
    '<div class="top-r"><button type="button" class="search-b" id="search-b" aria-label="ძებნა (Ctrl+K)"><span aria-hidden="true">🔍</span><span class="tl">ძებნა</span><kbd>Ctrl K</kbd></button>' +
    '<button type="button" class="ic-btn" id="theme-b" aria-label="მუქი / ღია რეჟიმი" title="მუქი / ღია რეჟიმი">◐</button><a class="acc-b" id="acc-b" href="/learn/dashboard/">შესვლა</a></div></div></header>\n' +
    (o.bar || '') + '<main id="main">\n' + o.body + '\n</main>\n' +
    '<footer class="foot"><span>ისწავლე კოდინგი · <a href="/">CodeQuest</a> © <span id="yr">2026</span></span><span><a href="/learn/courses/">კურსები</a> · <a href="/CodeQuest.html">თამაში</a> · <a href="/privacy.html">კონფიდენციალურობა</a> · <a href="/terms.html">წესები</a></span></footer>\n' +
    cm.map(cdnTag).join('\n') + (cm.length ? '\n' : '') + '<script src="' + ASSET.js + '" defer></script>\n</body>\n</html>\n';
}
const add = (p, o) => pages.push({ path: p, noindex: !!o.noindex, html: shell(Object.assign({ path: p }, o)) });

/* ---------- ბარათები და სიები ---------- */
function courseCard(c) {
  const n = c.items.length, chN = c.items.filter(i => i.kind === 'chapter').length;
  return '<a class="card course" href="' + url(c.slug) + '" style="--cc:' + esc(c.color || '#3dffa2') + '" data-course="' + c.slug + '" data-total="' + n + '" data-topic="' + esc(c.topic || '') + '" data-state="' + (n ? 'open' : 'soon') + '">' +
    '<span class="c-ic" aria-hidden="true">' + esc(c.icon || '📘') + '</span><span class="c-main"><b>' + esc(c.title) + '</b><small>' + esc(c.description || '') + '</small></span>' +
    '<span class="c-meta">' + (n ? '<span>' + chN + (c.planned > chN ? ' / ' + c.planned : '') + ' თავი</span><span>⏱ ' + time(c.minutes) + '</span>' : '<span class="soon">მალე</span>' + (c.planned ? '<span>' + c.planned + ' თავი იგეგმება</span>' : '')) +
    '</span><span class="c-bar" aria-hidden="true"><i></i></span></a>';
}
const itemRow = it => (it.doc
  ? '<a class="row" href="' + url(it.id) + '" data-id="' + it.id + '"><span class="tick" aria-hidden="true"></span><span class="row-t">' + esc(it.title) + '</span><small>' + (it.kind === 'chapter' ? time(it.doc.minutes) : it.kind === 'quiz' ? it.doc.questions + ' კითხვა' : 'პროექტი') + '</small></a>'
  : '<span class="row off"><span class="tick" aria-hidden="true"></span><span class="row-t">' + esc(it.title) + '</span><small class="soon">მალე</small></span>');

/* ---------- გვერდები ---------- */
function build() {
  const courses = loadCourses();
  const roadmaps = (() => { try { return JSON.parse(read(path.join(ROOT, 'curriculum', '_roadmaps.json')) || '[]'); } catch (e) { warn.push('curriculum/_roadmaps.json: ' + e.message); return []; } })();
  const by = Object.fromEntries(courses.map(c => [c.slug, c]));
  const total = { courses: courses.length, planned: courses.reduce((a, c) => a + c.planned, 0), open: courses.reduce((a, c) => a + c.items.filter(i => i.kind === 'chapter').length, 0), ready: courses.filter(c => c.items.length).length };

  // მთავარი
  add('', { title: 'ისწავლე კოდინგი ნულიდან — ქართულად', nav: '', cls: 'home', desc: 'პროგრამირების ონლაინ სკოლა ქართულად: ' + total.courses + ' კურსი ნულიდან პროფესიონალურ დონემდე. მოკლე თავები, ცოცხალი კოდი, სავარჯიშოები და ქვიზები.',
    body: '<section class="hero"><p class="eyebrow"><span class="dot"></span> 👑 CodeQuest Pro · ქართულად · ბრაუზერში</p><h1>ისწავლე კოდინგი ნულიდან — <span class="hl">ქართულად</span></h1>' +
      '<p class="lead">მოკლე თავები მარტივი ენით, კოდი, რომელსაც იქვე გაუშვებ, სავარჯიშოები და ქვიზები. დაიწყე პირველი თავით და იარე საკუთარი ტემპით.</p>' +
      '<p class="hero-a"><a class="btn primary big" id="hero-go" href="' + url(courses.find(c => c.items.length) ? courses.find(c => c.items.length).items[0].id : 'courses') + '">დაიწყე პირველი თავით →</a><a class="btn big" href="/learn/courses/">ყველა კურსი</a></p>' +
      '<div class="term" aria-hidden="true"><div class="term-h"><i></i><i></i><i></i><span>first.js</span></div><pre><span class="k">let</span> name = <span class="s">"ნინო"</span>;\nconsole.log(<span class="s">"გამარჯობა, "</span> + name + <span class="s">"!"</span>);\n<span class="c">// → გამარჯობა, ნინო!</span></pre></div></section>' +
      '<section class="stats" aria-label="სკოლა ციფრებში"><div><b>' + total.courses + '</b><small>კურსი</small></div><div><b>' + total.planned + '</b><small>თავი სილაბუსებში</small></div><div><b>' + total.open + '</b><small>თავი უკვე ღიაა</small></div><div><b>' + roadmaps.length + '</b><small>სასწავლო გზა</small></div></section>' +
      '<section><h2>როგორ მუშაობს</h2><ol class="steps"><li><b>წაიკითხე მოკლე თავი</b><span>ახსნა მარტივი ენით და ცხოვრებისეული მაგალითით — 5–8 წუთში.</span></li><li><b>გაუშვი და შეცვალე კოდი</b><span>ყველა მაგალითი იქვე ეშვება. შეცვალე და ნახე, რა მოხდება.</span></li><li><b>შეამოწმე თავი</b><span>სავარჯიშო, მინი-ქვიზი და XP ყოველ დასრულებულ თავზე.</span></li></ol></section>' +
      '<section><div class="sec-h"><h2>კურსები</h2><a href="/learn/courses/">ყველა ' + total.courses + ' კურსი →</a></div><div class="grid">' + courses.filter(c => c.items.length).concat(courses.filter(c => !c.items.length)).slice(0, 6).map(courseCard).join('') + '</div></section>' +
      '<section><div class="sec-h"><h2>სასწავლო გზები</h2><a href="/learn/roadmaps/">ყველა გზა →</a></div><div class="chips">' + roadmaps.map(r => '<a class="chip" href="/learn/roadmaps/#' + esc(r.slug) + '"><span aria-hidden="true">' + esc(r.icon || '🧭') + '</span> ' + esc(r.title) + '</a>').join('') + '</div></section>' +
      '<section class="cta"><h2>მზად ხარ პირველი ხაზისთვის?</h2><p>სკოლა CodeQuest Pro-ს ნაწილია: ერთჯერადი გადახდა ხსნის ყველა კურსს და თამაშის ყველა ლეველს, ვიდეოს და პროექტს. პროგრესი შენს ანგარიშში ინახება.</p><p class="lock-a"><a class="btn primary big" href="/CodeQuest.html?pro=open">👑 Pro' + esc(PRO.price) + '</a><a class="btn big" href="/learn/courses/">ნახე კურსები</a></p></section>' });

  // კატალოგი
  const topics = [...new Set(courses.map(c => c.topic).filter(Boolean))];
  add('courses', { title: 'კურსების კატალოგი', nav: 'courses', desc: 'ყველა კურსი: ' + courses.map(c => c.title).slice(0, 8).join(', ') + ' და სხვა. აირჩიე თემა და დაიწყე.',
    body: '<section class="head"><h1>კურსები</h1><p class="lead">' + total.courses + ' კურსი, თითოში 4 დონე: დამწყებიდან ექსპერტამდე. ' + total.ready + ' კურსი უკვე ღიაა, დანარჩენი ემატება. თავები 👑 CodeQuest Pro-ს ნაწილია.</p></section>' +
      '<div class="filters"><input type="search" id="cat-q" placeholder="მოძებნე კურსი…" aria-label="კურსის ძებნა"><div class="chips" role="group" aria-label="თემა"><button type="button" class="chip on" data-topic="">ყველა</button>' + topics.map(t => '<button type="button" class="chip" data-topic="' + esc(t) + '">' + esc(t) + '</button>').join('') + '<button type="button" class="chip" data-topic="@open">მხოლოდ ღია</button></div></div>' +
      '<div class="grid" id="cat">' + courses.map(courseCard).join('') + '</div><p class="empty" id="cat-empty" hidden>ასეთი კურსი ვერ მოიძებნა.</p>' });

  // სასწავლო გზები
  add('roadmaps', { title: 'სასწავლო გზები', nav: 'roadmaps', desc: 'რა რიგით ისწავლო: ' + roadmaps.map(r => r.title).join(', ') + '. თითო გზა კურსების თანმიმდევრობაა.',
    body: '<section class="head"><h1>სასწავლო გზები</h1><p class="lead">არ იცი, საიდან დაიწყო? აირჩიე მიზანი და მიჰყევი კურსებს რიგით.</p></section>' +
      roadmaps.map(r => '<section class="road" id="' + esc(r.slug) + '"><h2><span aria-hidden="true">' + esc(r.icon || '🧭') + '</span> ' + esc(r.title) + '</h2><p class="muted">' + esc(r.description || '') + '</p><ol class="road-l">' +
        (r.steps || []).map(st => '<li>' + (Array.isArray(st) ? st : [st]).map(sl => by[sl]).filter(Boolean).map(c => '<a class="node" href="' + url(c.slug) + '" style="--cc:' + esc(c.color || '#3dffa2') + '" data-course="' + c.slug + '" data-total="' + c.items.length + '"><span aria-hidden="true">' + esc(c.icon || '📘') + '</span><b>' + esc(c.title) + '</b>' + (c.items.length ? '' : '<small class="soon">მალე</small>') + '</a>').join('<span class="or">ან</span>') + '</li>').join('') + '</ol></section>').join('') });

  // დაფა (შიგთავსს learn.js ავსებს ბრაუზერის მონაცემებიდან)
  add('dashboard', { title: 'ჩემი დაფა', nav: 'dashboard', noindex: true, desc: 'შენი პროგრესი, სერია, XP, ბეჯები და სანიშნეები.',
    body: '<section class="head"><h1>ჩემი დაფა</h1><p class="lead" id="dash-hi">შენი პროგრესი ამ ბრაუზერში ინახება.</p></section><div id="dash" data-dash><p class="muted">იტვირთება…</p></div><noscript><p class="muted">დაფას JavaScript სჭირდება.</p></noscript>' });

  // კურსები, თავები, ქვიზები, პროექტები
  courses.forEach(c => {
    const chN = c.items.filter(i => i.kind === 'chapter').length, mods = c.levels.reduce((a, l) => a + l.modules.length, 0);
    const bar = '<div class="cbar" data-course="' + c.slug + '" data-total="' + c.items.length + '" style="--cc:' + esc(c.color || '#3dffa2') + '" role="progressbar" aria-label="კურსის პროგრესი" aria-valuemin="0" aria-valuemax="100"><i></i></div>';
    add(c.slug, { title: c.title, nav: 'courses', bar, desc: (c.description || c.title) + (c.planned ? ' ' + c.planned + ' თავი 4 დონეზე.' : ''),
      body: '<section class="head course-h" style="--cc:' + esc(c.color || '#3dffa2') + '"><span class="c-ic big" aria-hidden="true">' + esc(c.icon || '📘') + '</span><div><p class="crumbs"><a href="/learn/courses/">კურსები</a> ›</p><h1>' + esc(c.title) + '</h1><p class="lead">' + esc(c.description || '') + '</p>' +
        '<p class="facts"><span>👑 Pro</span>' + (c.syllabus ? '<span>4 დონე</span><span>' + mods + ' მოდული</span><span>' + c.planned + ' თავი</span>' + (chN ? '<span>' + chN + ' ღიაა · ⏱ ' + time(c.minutes) + '</span>' : '<span class="soon">მალე</span>') : '<span class="soon">მალე</span><span>სილაბუსი მზადდება</span>') + '</p>' +
        (c.items.length ? '<p><a class="btn primary big" id="course-go" href="' + url(c.items[0].id) + '">დაიწყე</a></p>' : '') + '</div></section>' +
        (Array.isArray(c.learn) && c.learn.length ? '<section><h2>რას ისწავლი</h2><ul class="learn">' + c.learn.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></section>' : '') +
        (c.syllabus ? '<section><h2>სილაბუსი</h2>' + c.levels.filter(l => l.modules.length || l.project).map((l, li) => '<details class="lvl"' + (li === 0 ? ' open' : '') + '><summary><b>' + l.title + '</b><small>' + l.modules.length + ' მოდული · ' + l.modules.reduce((a, m) => a + m.chapters.length, 0) + ' თავი</small></summary>' +
          l.modules.map((m, mi) => '<details class="mod"' + (m.chapters.some(ch => ch.doc) && li === 0 && mi === 0 ? ' open' : '') + '><summary><span class="mod-n">' + (mi + 1) + '</span><span class="row-t">' + esc(m.title) + '</span><small>' + m.chapters.filter(ch => ch.doc).length + ' / ' + m.chapters.length + '</small></summary>' +
            (m.description ? '<p class="muted mod-d">' + esc(m.description) + '</p>' : '') + m.chapters.map(itemRow).join('') + itemRow(m.quiz) + '</details>').join('') +
          (l.projectItem ? '<div class="proj">' + itemRow(l.projectItem) + '<p class="muted">' + esc(l.project.description || '') + '</p></div>' : '') + '</details>').join('') + '</section>'
          : '<section class="soon-box"><h2>სილაბუსი მალე დაემატება</h2><p class="muted">ამ კურსის თავები ჯერ მზადდება. მანამდე დაიწყე ღია კურსით.</p><a class="btn" href="/learn/courses/">ღია კურსები</a></section>') });

    c.items.forEach((it, n) => {
      const prev = c.items[n - 1], next = c.items[n + 1], d = it.doc, m = it.module, lvl = m ? m.level : it.level;
      const side = '<aside class="side" id="side" aria-label="კურსის ნავიგაცია"><a class="side-c" href="' + url(c.slug) + '"><span aria-hidden="true">' + esc(c.icon || '📘') + '</span> ' + esc(c.title) + '</a><p class="side-l">' + lvl.title + '</p>' +
        lvl.modules.map(mo => '<details' + (mo === m ? ' open' : '') + '><summary>' + esc(mo.title) + '</summary>' + mo.chapters.concat(mo.quiz).map(x => (x.doc ? '<a href="' + url(x.id) + '" data-id="' + x.id + '"' + (x === it ? ' aria-current="page"' : '') + '><span class="tick" aria-hidden="true"></span>' + esc(x.kind === 'quiz' ? 'ქვიზი' : x.title) + '</a>' : '<span class="off"><span class="tick" aria-hidden="true"></span>' + esc(x.kind === 'quiz' ? 'ქვიზი' : x.title) + '</span>')).join('') + '</details>').join('') +
        (lvl.projectItem && lvl.projectItem.doc ? '<a class="side-p" href="' + url(lvl.projectItem.id) + '" data-id="' + lvl.projectItem.id + '"' + (lvl.projectItem === it ? ' aria-current="page"' : '') + '><span class="tick" aria-hidden="true"></span>დონის პროექტი</a>' : '') + '</aside>';
      const xp = XP[it.kind], desc = d.meta.description || it.description || it.title;
      const tags = Array.isArray(d.meta.tags) ? d.meta.tags : [];
      const body = '<div class="lesson">' + side + '<article class="doc" data-item="' + it.id + '" data-kind="' + it.kind + '" data-title="' + esc(it.title) + '">' +
        '<p class="crumbs"><a href="' + url(c.slug) + '">' + esc(c.title) + '</a> › ' + lvl.title + (m ? ' › ' + esc(m.title) : '') + '</p><h1>' + esc(it.title) + '</h1>' +
        '<p class="meta">' + (it.kind === 'chapter' ? '<span>' + esc(d.meta.difficulty || lvl.title) + '</span><span>⏱ ' + time(d.minutes) + '</span>' : it.kind === 'quiz' ? '<span>' + d.questions + ' კითხვა</span><span>გასავლელად 70%</span>' : '<span>პრაქტიკული პროექტი</span>') + '<span>+' + xp + ' XP</span><span>👑 Pro</span>' + tags.map(t => '<span class="tag">#' + esc(t) + '</span>').join('') + '</p>' +
        '<button type="button" class="btn small side-t" id="side-t" aria-expanded="false" aria-controls="side">☰ თავების სია</button>\n' +
        // 👑 შინაარსი დამალულია, სანამ learn.js Pro-ს არ დაადასტურებს (.pro კლასი); Pro-ს გარეშე ჩანს #lock
        '<section class="lock" id="lock" hidden><span class="lock-ic" aria-hidden="true">👑</span><h2>ეს ' + (it.kind === 'quiz' ? 'ქვიზი' : it.kind === 'project' ? 'პროექტი' : 'თავი') + ' CodeQuest Pro-ს ნაწილია</h2>' +
        '<p>Pro ხსნის სკოლის ყველა კურსს და თამაშის ყველა ლეველს, ვიდეოს და პროექტს. ერთჯერადი გადახდა, გამოწერის გარეშე.</p>' +
        '<p class="lock-a"><a class="btn primary big" href="/CodeQuest.html?pro=open">👑 Pro-ს ყიდვა' + esc(PRO.price) + '</a><a class="btn big" id="lock-in" href="/learn/dashboard/">უკვე მაქვს Pro — შესვლა</a></p><p class="lock-note" id="lock-note"></p></section>' +
        '<noscript><p class="muted">თავის სანახავად JavaScript და Pro-ანგარიშია საჭირო.</p></noscript>\n<div class="gated">\n' + d.html + '\n' +
        (it.kind === 'quiz' ? '' : '<div class="done-box"><button type="button" class="btn primary" id="mark-done">✓ დასრულებულად მონიშვნა · +' + xp + ' XP</button><button type="button" class="btn" id="mark-bm" aria-pressed="false">🔖 სანიშნე</button></div>' +
          '<details class="note"><summary>📝 ჩემი შენიშვნა</summary><textarea id="note" maxlength="1000" rows="4" placeholder="ჩაიწერე, რაც არ გინდა დაგავიწყდეს…" aria-label="პირადი შენიშვნა"></textarea><small class="muted" id="note-st"></small></details>') +
        '</div>\n<nav class="pn" aria-label="წინა და შემდეგი">' + (prev ? '<a class="prev" href="' + url(prev.id) + '"><small>← წინა</small><b>' + esc(prev.title) + '</b></a>' : '<span></span>') + (next ? '<a class="next" href="' + url(next.id) + '"><small>შემდეგი →</small><b>' + esc(next.title) + '</b></a>' : '<a class="next" href="' + url(c.slug) + '"><small>სილაბუსი →</small><b>' + esc(c.title) + '</b></a>') + '</nav></article>' +
        '<aside class="toc" aria-label="ამ გვერდზე">' + (d.toc.length ? '<b>ამ გვერდზე</b><ul>' + d.toc.map(t => '<li><a href="#' + t.id + '">' + esc(t.text) + '</a></li>').join('') + '</ul>' : '') + '</aside></div>';
      add(it.id, { title: it.title + ' — ' + c.title, nav: 'courses', article: true, cls: 'lesson-page', bar, langs: d.langs, desc, body });
    });
  });

  /* ---------- ჩაწერა ---------- */
  fs.rmSync(OUT, { recursive: true, force: true });
  pages.forEach(p => { const dir = path.join(OUT, p.path); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), p.html); });
  fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify({ xp: XP, courses: courses.map(c => ({ s: c.slug, t: c.title, i: c.icon || '📘', c: c.color || '#3dffa2', p: c.planned, full: c.full, items: c.items.map(it => [it.id, it.title, it.kind[0]]) })) }));
  // shortcut: ძებნის ინდექსი ერთი JSON-ია (სათაური, ტეგები, აღწერა, ტექსტის პირველი 1500 სიმბოლო) — 10 000 თავზე ~2–3 MB; სრულ ტექსტზე ძებნა თუ დაგჭირდა, გადადი Pagefind-ზე
  fs.writeFileSync(path.join(OUT, 'search.json'), JSON.stringify(courses.flatMap(c => [{ u: url(c.slug), t: c.title, c: 'კურსი', d: c.description || '', g: c.topic || '', x: '' }].concat(c.items.map(it => ({ u: url(it.id), t: it.title, c: c.title, d: it.doc.meta.description || it.description || '', g: (Array.isArray(it.doc.meta.tags) ? it.doc.meta.tags : []).join(' '), x: it.doc.text.slice(0, 1500) }))))));
  const sm = ['/', '/CodeQuest.html', '/privacy.html', '/terms.html'].concat(pages.filter(p => !p.noindex).map(p => url(p.path)));
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + sm.map(u => '  <url><loc>' + SITE + u + '</loc></url>').join('\n') + '\n</urlset>\n');
  return { pages: pages.length, total };
}

if (require.main === module) {
  const r = build();
  warn.forEach(w => console.warn('⚠️  ' + w));
  console.log('learn/: ' + r.pages + ' გვერდი · ' + r.total.courses + ' კურსი · ' + r.total.open + ' / ' + r.total.planned + ' თავი ღიაა' + (warn.length ? ' · ' + warn.length + ' გაფრთხილება' : ''));
} else module.exports = { frontmatter, inline, md, parseDoc, warn };
