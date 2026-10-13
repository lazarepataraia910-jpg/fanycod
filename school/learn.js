// „ისწავლე კოდინგი“ — სკოლის გვერდების სკრიპტი: პროგრესი (ბრაუზერში, ანგარიშით — სერვერზეც), ქვიზები, კოდის გაშვება, ძებნა, დაფა.
// გვერდებს school/build.js აწყობს; აქ კონტენტი არ არის.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const get = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* სავსეა ან მიუწვდომელია — გვერდი მაინც მუშაობს */ } };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const KEY = 'codequest.school', GAME = 'codequest.v1', AUTH = 'codequest.auth';
  // კომპიუტერის პროგრამა (Electron, codequest://app): გვერდები საიტიდან მოდის, პროგრესი კი მხოლოდ კომპიუტერში ინახება — სერვერზე არ იგზავნება
  const DESKTOP = location.protocol === 'codequest:', SITE = 'https://codequest.space';
  const XP = { chapter: 20, quiz: 50, project: 100 }, PASS = 70;   // იგივე რიცხვები: school/build.js და CodeQuest.html (schoolXP)
  const day = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  /* ---------- მდგომარეობა ---------- */
  // done: { id: დღე } (თავები და პროექტები), quiz: { id: საუკეთესო % }, marks: { id: { on, at, t } }, notes: { id: { t, at, h } }
  const blank = () => ({ done: {}, quiz: {}, marks: {}, notes: {} });
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  // ორი მდგომარეობის გაერთიანება — იგივე წესი, რაც სერვერზე (api/account.js → mergeSchool): არაფერი იკარგება
  function merge(a, b) {
    const m = blank();
    [a, b].forEach(s => {
      if (!s) return;
      Object.entries(obj(s.done)).forEach(([k, v]) => { if (!m.done[k] || v < m.done[k]) m.done[k] = v; });
      Object.entries(obj(s.quiz)).forEach(([k, v]) => { m.quiz[k] = Math.max(m.quiz[k] || 0, +v || 0); });
      ['marks', 'notes'].forEach(f => Object.entries(obj(s[f])).forEach(([k, v]) => { if (v && (!m[f][k] || (v.at || 0) > (m[f][k].at || 0))) m[f][k] = v; }));
    });
    return m;
  }
  let S = merge(get(KEY), null);
  const isDone = id => !!S.done[id] || (S.quiz[id] || 0) >= PASS;
  const schoolXP = () => { const d = Object.keys(S.done); return d.filter(k => !k.endsWith('/project')).length * XP.chapter + d.filter(k => k.endsWith('/project')).length * XP.project + Object.values(S.quiz).filter(p => p >= PASS).length * XP.quiz; };
  // თამაშის (CodeQuest.html) პროგრესი იმავე ბრაუზერშია: სერია საერთოა, XP — ჯამი
  const game = () => obj(get(GAME));
  const gameXP = () => { const P = game(); return Object.values(obj(P.levels)).reduce((a, l) => a + ((l && +l.xp) || 0), 0) + (+P.bonusXP || 0); };
  const streakNow = () => { const s = obj(game().streak); return s.last === day() || s.last === day(-1) ? s.count || 0 : 0; };
  // დღევანდელი ვარჯიშის აღნიშვნა თამაშის სერიაში (იგივე წესი, რაც Progress.touchStreak-ში)
  function touchStreak() {
    const P = game(), s = P.streak = Object.assign({ last: '', count: 0, best: 0, days: [] }, obj(P.streak)), today = day();
    if (s.last === today) return;
    s.count = s.last === day(-1) ? (s.count || 0) + 1 : 1;
    s.last = today;
    s.best = Math.max(s.best || 0, s.count);
    s.days = (Array.isArray(s.days) ? s.days : []).filter(d => d !== today).concat(today).slice(-60);
    set(GAME, P);
    const a = get(AUTH);
    if (a && a.name) { a.dirty = true; set(AUTH, a); }   // თამაში შემდეგ გახსნაზე ანგარიშში შეინახავს
  }

  /* ---------- ანგარიში: იგივე, რაც თამაშში (ვებზე სესია HttpOnly cookie-შია) ---------- */
  const acc = () => { const a = get(AUTH); return a && a.name ? a : null; };
  const loginUrl = () => '/CodeQuest.html?acc=1&to=' + encodeURIComponent(location.pathname);
  let syncT = null, syncing = false;
  async function sync(keepalive) {
    const a = acc();
    if (DESKTOP || !a || syncing) return;
    syncing = true;
    try {
      const body = JSON.stringify({ action: 'school', token: a.token, state: S });
      const r = await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive && body.length < 60000 });
      const j = await r.json();
      if (j.ok && j.state) { S = merge(S, j.state); set(KEY, S); set(KEY + '.sync', { at: Date.now(), dirty: false }); paint(); }
    } catch (e) { /* ინტერნეტი არ არის — შემდეგ ჯერზე */ }
    syncing = false;
  }
  function save() {
    set(KEY, S);
    set(KEY + '.sync', Object.assign({ at: 0 }, get(KEY + '.sync'), { dirty: true }));
    paint();
    clearTimeout(syncT);
    syncT = setTimeout(sync, 8000);   // ბაზას ხშირად არ ვაწუხებთ
  }

  /* ---------- საერთო ---------- */
  function toast(text) {
    $$('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  function header() {
    const yr = $('#yr'); if (yr) yr.textContent = new Date().getFullYear();
    $('#theme-b').addEventListener('click', () => {
      const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem('cq.learn.theme', t); } catch (e) { /* მხოლოდ ამ გვერდზე */ }
    });
    const nt = $('#nav-t'), nav = $('#nav');
    nt.addEventListener('click', () => nt.setAttribute('aria-expanded', String(nav.classList.toggle('open'))));
    const a = acc(), b = $('#acc-b');
    if (a) { b.textContent = '👤 ' + a.name; b.title = a.name + ' — ჩემი დაფა'; } else { b.href = loginUrl(); b.title = 'შესვლა CodeQuest-ის ანგარიშით — პროგრესი ყველა მოწყობილობაზე'; }
    // პროგრამაში მხოლოდ სკოლა და თამაში იხსნება; დანარჩენი ბმულები (წესები, მთავარი გვერდი) — ბრაუზერში
    if (DESKTOP) $$('a[href^="/"]').forEach(l => { if (!/^\/(learn\/|school\/|CodeQuest\.html)/.test(l.getAttribute('href'))) l.href = SITE + l.getAttribute('href'); });
    $('#search-b').addEventListener('click', openSearch);
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); } });
  }
  // ✓ ნიშნები, პროგრესის ზოლები, „გააგრძელე“ ღილაკები
  function paint() {
    $$('[data-id]').forEach(el => el.classList.toggle('done', isDone(el.dataset.id)));
    const count = c => Object.keys(S.done).filter(k => k.startsWith(c + '/')).length + Object.keys(S.quiz).filter(k => k.startsWith(c + '/') && S.quiz[k] >= PASS).length;
    $$('[data-course][data-total]').forEach(el => {
      const total = +el.dataset.total, n = Math.min(total, count(el.dataset.course)), pct = total ? Math.round(n / total * 100) : 0;
      const bar = el.classList.contains('cbar') ? el.firstElementChild : $('.c-bar i', el);
      if (bar) bar.style.width = pct + '%';
      if (el.classList.contains('cbar')) el.setAttribute('aria-valuenow', pct);
      if (el.classList.contains('node')) el.classList.toggle('done', total > 0 && n >= total);
    });
    const go = $('#course-go');
    if (go) {
      const rows = $$('a.row[data-id]'), next = rows.find(r => !r.classList.contains('done'));
      if (next && rows.some(r => r.classList.contains('done'))) { go.href = next.href; go.textContent = 'გააგრძელე: ' + $('.row-t', next).textContent; }
      else if (!next && rows.length) { go.textContent = '✓ ყველა ღია თავი დასრულებულია'; go.href = '#main'; }
    }
    const last = get(KEY + '.last'), hero = $('#hero-go');
    if (hero && last && last.id) { hero.href = '/learn/' + last.id + '/'; hero.textContent = 'გააგრძელე: ' + last.t + ' →'; }
    const item = $('.doc[data-item]');
    if (item) {
      const id = item.dataset.item, md = $('#mark-done'), bm = $('#mark-bm');
      if (md && S.done[id]) { md.textContent = '✓ დასრულებულია'; md.disabled = true; }
      if (bm) { const on = !!(S.marks[id] && S.marks[id].on); bm.setAttribute('aria-pressed', String(on)); bm.textContent = on ? '🔖 სანიშნეშია' : '🔖 სანიშნე'; }
    }
    if (dashboard.render) dashboard.render();   // სინქრონის შემდეგ დაფაც განახლდეს
  }

  /* ---------- 👑 Pro: თავები, ქვიზები და პროექტები მხოლოდ Pro-ანგარიშისთვის ---------- */
  // ნიშანს (token) სერვერი აწერს ხელს; აქ მოწმდება იმავე საჯარო გასაღებით, რაც თამაშში (ProLock) — localStorage-ის ხელით შეცვლა Pro-ს არ რთავს.
  // შენიშვნა: თავის ტექსტი გვერდის HTML-შია (Google-ისთვის), ანუ ეს დაცვა ისეთივეა, როგორიც თამაშში — ჩვეულებრივ მომხმარებელს აჩერებს, კოდის მცოდნეს ვერა.
  async function verifyPro(token, name) {
    try {
      const [x, y] = (document.documentElement.dataset.pro || '').split('.'), [body, sig] = String(token).split('.');
      const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!sig || (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(sig), new TextEncoder().encode(body))) !== true) return false;
      const p = JSON.parse(new TextDecoder().decode(bytes(body)));
      return p.v === 2 && p.u === String(name).normalize('NFC').toLowerCase();
    } catch (e) { return false; }
  }
  // ჯერ ამ მოწყობილობაზე შენახული ნიშანი (თამაშის ან სკოლის); თუ არ არის — სერვერი, მაქსიმუმ 10 წუთში ერთხელ (fresh: ყიდვიდან დაბრუნებისას მაშინვე)
  async function hasPro(fresh) {
    const a = acc();
    if (!a) return false;
    for (const t of [obj(game().pro).token, get(KEY + '.pro')]) if (t && await verifyPro(t, a.name)) return true;
    const asked = obj(get(KEY + '.proAsk'));
    if (!fresh && asked.name === a.name && Date.now() - asked.at < 600000) return false;
    set(KEY + '.proAsk', { name: a.name, at: Date.now() });
    try {
      const j = await (await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'me', token: a.token }) })).json();
      if (j.ok && j.pro && await verifyPro(j.pro, a.name)) { set(KEY + '.pro', j.pro); return true; }
      expired = j.error === 'no_session';   // სესია ამოიწურა — თავიდან შესვლაა საჭირო
    } catch (e) { /* ინტერნეტი არ არის */ }
    return false;
  }
  let proOk = false, proAt = 0, expired = false, proP = null;
  const proCheck = fresh => (fresh || !proP ? (proP = hasPro(fresh)) : proP);   // გვერდზე ერთი შემოწმება: gate და sync ერთსა და იმავე პასუხს ელოდება
  async function gate(fresh) {
    const lock = $('#lock');
    if (!lock || proOk) return;
    proAt = Date.now();
    if (await proCheck(fresh)) { proOk = true; document.documentElement.classList.add('pro'); lock.hidden = true; lesson(); paint(); return; }
    const a = expired ? null : acc(), li = $('#lock-in');
    lock.hidden = false;
    if (a) { li.hidden = true; $('#lock-note').textContent = 'შესული ხარ, როგორც ' + a.name + '. ამ ანგარიშს Pro ჯერ არ აქვს. ყიდვის ან კოდის გააქტიურების შემდეგ დაბრუნდი ამ გვერდზე და თავი თვითონ გაიხსნება.'; } else li.href = loginUrl();
  }

  /* ---------- თავის გვერდი ---------- */
  function lesson() {
    const doc = $('.doc[data-item]');
    if (!doc) return;
    const id = doc.dataset.item, kind = doc.dataset.kind, title = doc.dataset.title;
    set(KEY + '.last', { id, t: title, at: Date.now() });   // მხოლოდ ამ ბრაუზერში: „გააგრძელე, სადაც გაჩერდი“
    const st = $('#side-t'), side = $('#side');
    if (st) st.addEventListener('click', () => st.setAttribute('aria-expanded', String(side.classList.toggle('open'))));
    const md = $('#mark-done');
    if (md) md.addEventListener('click', () => {
      if (S.done[id]) return;
      S.done[id] = day(); touchStreak(); save();
      toast('🎉 +' + XP[kind] + ' XP · ' + (kind === 'project' ? 'პროექტი დასრულებულია!' : 'თავი დასრულებულია!'));
      const next = $('.pn .next'); if (next) next.focus();
    });
    const bm = $('#mark-bm');
    if (bm) bm.addEventListener('click', () => { const on = !(S.marks[id] && S.marks[id].on); S.marks[id] = { on: on ? 1 : 0, at: Date.now(), t: title }; save(); });
    const note = $('#note'), ns = $('#note-st');
    if (note) {
      if (S.notes[id] && S.notes[id].t) { note.value = S.notes[id].t; note.closest('details').open = true; }
      let t = null;
      note.addEventListener('input', () => { clearTimeout(t); ns.textContent = '…'; t = setTimeout(() => { S.notes[id] = { t: note.value.slice(0, 1000), at: Date.now(), h: title }; save(); ns.textContent = 'შენახულია ✓'; }, 800); });
    }
    code(doc); quizzes(doc, id);
  }

  /* ---------- კოდი: გაფერადება, კოპირება, გაშვება ---------- */
  const CM = () => window.CodeMirror;
  const WORKER = 'const fmt=v=>{if(typeof v==="string")return v;if(typeof v==="function")return v.toString();if(v===undefined)return "undefined";try{const s=JSON.stringify(v);return s===undefined?String(v):s}catch(e){return String(v)}};' +
    'let n=0;const send=(t,a)=>{if(++n<=300)postMessage({t,s:a.map(fmt).join(" ")})};' +
    'self.console={log:(...a)=>send("log",a),info:(...a)=>send("log",a),warn:(...a)=>send("log",a),debug:(...a)=>send("log",a),table:(...a)=>send("log",a),error:(...a)=>send("err",a)};self.alert=(...a)=>send("log",a);' +
    'onmessage=e=>{try{(0,eval)(e.data)}catch(err){postMessage({t:"err",s:(err&&err.name?err.name+": ":"")+(err&&err.message||err)})}postMessage({t:"end"})};';
  // JavaScript ცალკე ნაკადში (Worker): გვერდს ვერ გააჩერებს; 3 წამში თუ არ დასრულდა — ვთიშავთ (უსასრულო ციკლი)
  function runJS(src, out) {
    const pre = document.createElement('pre'); out.replaceChildren(pre);
    const line = (s, err) => { const el = document.createElement('span'); if (err) el.className = 'err'; el.textContent = s + '\n'; pre.appendChild(el); };
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }))); } catch (e) { line('კოდის გაშვება ამ ბრაუზერში ვერ ხერხდება.', true); return; }
    let lines = 0;
    const stop = setTimeout(() => { w.terminate(); line('⏱️ კოდი 3 წამზე მეტხანს მუშაობს — ხომ არ არის უსასრულო ციკლი? შეამოწმე ციკლის პირობა.', true); }, 3000);
    w.onmessage = e => {
      if (e.data.t === 'end') { clearTimeout(stop); setTimeout(() => { w.terminate(); if (!lines) line('(კოდი შესრულდა, მაგრამ არაფერი დაბეჭდილა — სცადე console.log)'); }, 400); return; }   // 400 მწმ — setTimeout-ით დაბეჭდილისთვის
      lines++; line(e.data.s, e.data.t === 'err');
    };
    w.onerror = e => { clearTimeout(stop); w.terminate(); lines++; line(String(e.message || 'შეცდომა').replace(/^Uncaught /, ''), true); e.preventDefault(); };
    w.postMessage(src);
  }
  function code(root) {
    $$('pre > code[data-mime]', root).forEach(el => {
      if (!el.dataset.mime || !CM() || !CM().runMode) return;
      const text = el.textContent; el.textContent = '';
      CM().runMode(text, el.dataset.mime, el); el.classList.add('cm-s-default');
    });
    $$('.code .copy', root).forEach(b => b.addEventListener('click', async () => {
      const text = $('code', b.closest('.code')).textContent;
      try { await navigator.clipboard.writeText(text); b.textContent = 'დაკოპირდა ✓'; } catch (e) { b.textContent = 'ვერ დაკოპირდა'; }
      setTimeout(() => { b.textContent = 'კოპირება'; }, 1600);
    }));
    $$('.run', root).forEach(box => {
      const ta = $('.run-src', box), out = $('.run-out', box), go = $('.run-go', box), lang = box.dataset.lang, first = ta.value;
      const run = () => {
        const src = ed ? ed.getValue() : ta.value;
        out.hidden = false;
        if (lang === 'js') runJS(src, out);
        else if (lang === 'html') { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.title = 'შედეგი'; f.srcdoc = src; out.replaceChildren(f); }
        else { const l = document.createElement('span'), p = document.createElement('pre'); l.className = 'lbl'; l.textContent = 'მოსალოდნელი შედეგი'; p.textContent = box.dataset.expect || ''; out.replaceChildren(l, p); }
      };
      let ed = null;
      if (CM() && CM().fromTextArea) {
        ed = CM().fromTextArea(ta, { mode: box.dataset.mime || null, lineNumbers: true, indentUnit: 2, tabSize: 2, viewportMargin: Infinity,
          extraKeys: { 'Ctrl-Enter': run, 'Cmd-Enter': run, Esc: () => go.focus(), Tab: cm => cm.execCommand(cm.somethingSelected() ? 'indentMore' : 'insertSoftTab') } });
      } else ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
      $('.run-note', box).textContent = lang === 'js' || lang === 'html' ? 'შეცვალე კოდი და გაუშვი · Ctrl+Enter' : 'ეს ენა ბრაუზერში ჯერ არ ეშვება — ნახავ მოსალოდნელ შედეგს';
      go.addEventListener('click', run);
      $('.run-reset', box).addEventListener('click', () => { if (ed) ed.setValue(first); else ta.value = first; out.hidden = true; });
    });
  }

  /* ---------- ქვიზი ---------- */
  function quizzes(root, id) {
    $$('.quiz', root).forEach(quiz => {
      const qs = $$('.q', quiz), res = $('.quiz-res', quiz);
      let right = 0, answered = 0;
      qs.forEach(q => $$('.q-o', q).forEach((b, i) => b.addEventListener('click', () => {
        const ok = +q.dataset.ok, opts = $$('.q-o', q);
        opts.forEach(o => { o.disabled = true; });
        opts[ok].classList.add('ok');
        if (i === ok) right++; else b.classList.add('no');
        const x = $('.q-x', q); if (x.textContent.trim()) x.hidden = false;
        if (++answered === qs.length && res) finish();
      })));
      function finish() {
        const pct = Math.round(right / qs.length * 100), before = S.quiz[id] || 0, pass = pct >= PASS;
        if (pct > before) { S.quiz[id] = pct; if (pass) touchStreak(); save(); }
        res.hidden = false;
        res.innerHTML = '<b>' + right + ' / ' + qs.length + ' · ' + pct + '%</b><p>' + (pass ? (before >= PASS ? 'ქვიზი გავლილია.' : '🎉 გაიარე! +' + XP.quiz + ' XP') : 'გასავლელად ' + PASS + '% გჭირდება. გადახედე თავებს და თავიდან სცადე.') + '</p><button type="button" class="btn">↺ თავიდან ცდა</button>';
        $('button', res).addEventListener('click', () => location.reload());
        res.scrollIntoView({ block: 'center' });
      }
    });
  }

  /* ---------- ძებნა (Ctrl+K) ---------- */
  let index = null;
  async function openSearch() {
    if ($('.sr')) return;
    const back = document.activeElement, box = document.createElement('div');
    box.className = 'sr'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'ძებნა');
    box.innerHTML = '<div class="sr-box"><input type="search" placeholder="მოძებნე თავი ან კურსი…" aria-label="ძებნა" autocomplete="off"><ul class="sr-list"></ul><p class="sr-tip">↑ ↓ არჩევა · Enter გახსნა · Esc დახურვა</p></div>';
    document.body.appendChild(box);
    const inp = $('input', box), list = $('.sr-list', box);
    const close = () => { box.remove(); if (back && back.focus) back.focus(); };
    let on = 0;
    const show = () => {
      const words = inp.value.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = !index ? [] : (words.length ? index.map(e => { const hay = [e.t, e.g, e.d, e.x].map(v => String(v).toLowerCase()); let sc = 0; for (const w of words) { const f = hay.findIndex(h => h.includes(w)); if (f < 0) return null; sc += 4 - f; } return [sc, e]; }).filter(Boolean).sort((a, b) => b[0] - a[0]).map(h => h[1]) : index.filter(e => e.c === 'კურსი')).slice(0, 30);
      on = 0;
      list.innerHTML = !index ? '<li class="empty">იტვირთება…</li>' : hits.length ? hits.map((e, i) => '<li><a href="' + esc(e.u) + '"' + (i ? '' : ' class="on"') + '>' + esc(e.t) + '<small>' + esc(e.c) + (e.d ? ' · ' + esc(e.d) : '') + '</small></a></li>').join('') : '<li class="empty">ვერაფერი მოიძებნა.</li>';
    };
    inp.addEventListener('input', show);
    box.addEventListener('click', e => { if (e.target === box) close(); });
    box.addEventListener('keydown', e => {
      const links = $$('a', list);
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && links[on]) { location.href = links[on].href; }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!links.length) return; links[on].classList.remove('on'); on = (on + (e.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length; links[on].classList.add('on'); links[on].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Tab') { e.preventDefault(); inp.focus(); }
    });
    inp.focus(); show();
    if (!index) { try { index = await (await fetch('/learn/search.json')).json(); } catch (e) { index = []; } show(); }
  }

  /* ---------- კატალოგი ---------- */
  function catalog() {
    const q = $('#cat-q');
    if (!q) return;
    let topic = '';
    const apply = () => {
      const w = q.value.trim().toLowerCase();
      let n = 0;
      $$('#cat .course').forEach(c => { const ok = (!w || c.textContent.toLowerCase().includes(w)) && (!topic || (topic === '@open' ? c.dataset.state === 'open' : c.dataset.topic === topic)); c.hidden = !ok; if (ok) n++; });
      $('#cat-empty').hidden = n > 0;
    };
    q.addEventListener('input', apply);
    $$('.filters .chip').forEach(b => b.addEventListener('click', () => { topic = b.dataset.topic; $$('.filters .chip').forEach(x => x.classList.toggle('on', x === b)); apply(); }));
  }

  /* ---------- დაფა ---------- */
  async function dashboard() {
    const box = $('[data-dash]');
    if (!box) return;
    let data;
    try { data = await (await fetch('/learn/data.json')).json(); } catch (e) { box.innerHTML = '<p class="muted">მონაცემები ვერ ჩაიტვირთა. შეამოწმე ინტერნეტი და განაახლე გვერდი.</p>'; return; }
    const a = acc();
    $('#dash-hi').innerHTML = a ? 'გამარჯობა, <b>' + esc(a.name) + '</b>! ' + (DESKTOP ? 'პროგრესი ამ კომპიუტერში ინახება.' : 'პროგრესი შენს ანგარიშში ინახება.') : 'სკოლის თავები 👑 CodeQuest Pro-ს ნაწილია. <a href="' + esc(loginUrl()) + '">შედი ანგარიშში</a>, რომ გაიხსნას და პროგრესი შეინახოს.';
    const render = () => {
      const title = {}; data.courses.forEach(c => c.items.forEach(it => { title[it[0]] = it[1]; }));
      const chapters = Object.keys(S.done).filter(k => !k.endsWith('/project')).length, quizN = Object.values(S.quiz).filter(p => p >= PASS).length, best = obj(game().streak).best || 0;
      const prog = data.courses.map(c => ({ c, n: c.items.filter(it => isDone(it[0])).length })).filter(x => x.c.items.length);
      const started = prog.filter(x => x.n), last = get(KEY + '.last');
      // „გააგრძელე“: ბოლოს ნანახი თავი (თუ დაუსრულებელია), თორემ დაწყებული კურსის პირველი დაუსრულებელი
      let next = last && title[last.id] && !isDone(last.id) ? [last.id, title[last.id]] : null;
      if (!next) for (const x of started.concat(prog)) { const it = x.c.items.find(i => !isDone(i[0])); if (it) { next = it; break; } }
      const badges = [
        ['🌱', 'პირველი თავი', 'დაასრულე 1 თავი', chapters >= 1], ['🔟', 'პირველი 10 თავი', 'დაასრულე 10 თავი', chapters >= 10], ['📚', '50 თავი', 'დაასრულე 50 თავი', chapters >= 50],
        ['🧠', 'პირველი ქვიზი', 'გაიარე მოდულის ქვიზი', quizN >= 1], ['🔥', '7 დღე ზედიზედ', 'ივარჯიშე 7 დღე ზედიზედ', best >= 7],
        ['🎓', 'კურსი დასრულდა', 'დაასრულე კურსის ყველა თავი', data.courses.some(c => c.full && c.items.every(it => isDone(it[0])))]
      ];
      const marks = Object.entries(S.marks).filter(([k, v]) => v && v.on).sort((x, y) => y[1].at - x[1].at), notes = Object.entries(S.notes).filter(([k, v]) => v && v.t).sort((x, y) => y[1].at - x[1].at);
      box.innerHTML = '<div class="d-tiles"><div class="d-tile"><b>⭐ ' + (schoolXP() + gameXP()) + '</b><small>XP (სკოლა ' + schoolXP() + ' + თამაში)</small></div><div class="d-tile"><b>🔥 ' + streakNow() + '</b><small>დღიანი სერია</small></div><div class="d-tile"><b>' + chapters + '</b><small>დასრულებული თავი</small></div><div class="d-tile"><b>' + quizN + '</b><small>გავლილი ქვიზი</small></div></div>' +
        (next ? '<div class="d-cont"><div><small>გააგრძელე, სადაც გაჩერდი</small><b>' + esc(next[1]) + '</b></div><a class="btn primary" href="/learn/' + esc(next[0]) + '/">გაგრძელება →</a></div>' : '') +
        '<h2>ჩემი კურსები</h2>' + (started.length ? '<ul class="d-list">' + started.map(x => '<li style="--cc:' + esc(x.c.c) + '"><a href="/learn/' + esc(x.c.s) + '/"><span aria-hidden="true">' + esc(x.c.i) + '</span> ' + esc(x.c.t) + '</a><small>' + x.n + ' / ' + x.c.items.length + '</small><span class="bar"><i style="width:' + Math.round(x.n / x.c.items.length * 100) + '%"></i></span></li>').join('') + '</ul>' : '<p class="muted">ჯერ არცერთი კურსი არ დაგიწყია. <a href="/learn/courses/">აირჩიე კურსი</a>.</p>') +
        '<h2>ბეჯები</h2><div class="badges">' + badges.map(b => '<div class="badge' + (b[3] ? ' on' : '') + '"><span aria-hidden="true">' + b[0] + '</span><b>' + b[1] + '</b><small>' + (b[3] ? 'მიღებულია ✓' : b[2]) + '</small></div>').join('') + '</div>' +
        '<h2>სანიშნეები</h2>' + (marks.length ? '<ul class="d-list">' + marks.map(([k, v]) => '<li><a href="/learn/' + esc(k) + '/">🔖 ' + esc(title[k] || v.t || k) + '</a></li>').join('') + '</ul>' : '<p class="muted">თავის ბოლოს დააჭირე „🔖 სანიშნე“-ს და აქ გამოჩნდება.</p>') +
        '<h2>ჩემი შენიშვნები</h2>' + (notes.length ? '<ul class="d-list">' + notes.map(([k, v]) => '<li><a href="/learn/' + esc(k) + '/">📝 ' + esc(title[k] || v.h || k) + '</a><p>' + esc(v.t) + '</p></li>').join('') + '</ul>' : '<p class="muted">შენიშვნის ჩაწერა ყოველი თავის ბოლოს შეგიძლია.</p>');
    };
    render();
    dashboard.render = render;
  }

  /* ---------- გაშვება ---------- */
  header(); catalog(); paint(); dashboard(); gate();   // თავის გვერდს gate() ხსნის (lesson), როცა Pro დადასტურდება
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !proOk && Date.now() - proAt > 5000) gate(true); });   // ყიდვიდან დაბრუნებისას
  const sy = get(KEY + '.sync') || {};
  // სხვა მოწყობილობის პროგრესი — მაქსიმუმ 10 წუთში ერთხელ და მხოლოდ Pro-ანგარიშით (სერვერი სხვას მაინც უარს ეუბნება)
  if (!DESKTOP && acc() && (sy.dirty || Date.now() - (sy.at || 0) > 600000)) proCheck().then(ok => { if (ok) sync(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (get(KEY + '.sync') || {}).dirty) { clearTimeout(syncT); sync(true); } });
})();
