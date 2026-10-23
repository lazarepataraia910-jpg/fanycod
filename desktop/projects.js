// 💻 ჩემი პროექტები (Pro): დრაფტები და საქაღალდეში შენახვა. main.js აკავშირებს ipcMain-ით (preload.js → window.cqDesktop.projects).
//   <userData>/projects/<id>.json → { id, name, type, state, folder, paths, files, at }
//   state: draft — მხოლოდ დრაფტი; saved — შენახულია საქაღალდეში (files: null — ფაილები დისკიდან იკითხება);
//          dirty — შენახულია, მაგრამ დრაფტში ახალი ცვლილებებია.
// გვერდი მხოლოდ id-ს და ფაილების ტექსტს აგზავნის. გზა — <folder>/<name>/<ფაილი>, folder-ს კი მხოლოდ pickFolder (Windows-ის ფანჯარა) წერს.
// ლიმიტები: 20 პროექტი, ფაილი ≤ 1 MB, პროექტი ≤ 5 MB, მხოლოდ ტექსტი; ფაილის გზა — მხოლოდ პროექტის შიგნით (okPath + pjPath).
// node desktop/projects.test.js — შემოწმება
'use strict';
const fs = require('fs');
const path = require('path');

const PJ = { max: 20, file: 1048576, total: 5242880, files: 200 };
const TYPES = ['html', 'css', 'js', 'ts', 'react', 'node', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'lua', 'dart'];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// '/'-ით, „..“-ის, დისკის, აბსოლუტური გზის, Windows-ის აკრძალული სიმბოლოებისა და სახელების გარეშე. იგივე წესი: CodeQuest.html → pjPathOk
const okPath = p => typeof p === 'string' && p.length > 0 && p.length <= 200 && !/[\\:*?"<>|\x00-\x1f]/.test(p) && !p.startsWith('/') && p.split('/').every(x => x && x !== '.' && x !== '..' && !RESERVED.test(x) && !/[. ]$/.test(x));
const okId = id => typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const errCode = e => (['EACCES', 'EPERM', 'EROFS'].includes(e && e.code) ? 'denied' : e && e.code === 'ENOSPC' ? 'full' : e && e.code === 'ENOENT' ? 'missing' : 'io');
const target = p => path.join(p.folder, p.name);
function filePath(p, rel) {   // მეორე დაცვა okPath-ის შემდეგ: ფაილი ყოველთვის <folder>/<name>-ის შიგნითაა
  const base = target(p), f = path.resolve(base, ...rel.split('/')), r = path.relative(base, f);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw Object.assign(new Error('bad path'), { code: 'bad_path' });
  return f;
}
// ხელით წაშლილი ფაილი უბრალოდ აკლია
function fromDisk(p) {
  const files = {};
  for (const rel of p.paths || []) { try { files[rel] = fs.readFileSync(filePath(p, rel), 'utf8'); } catch (e) { } }
  return files;
}

// dataDir() — userData; pickFolder(title) → არჩეული საქაღალდე ან null
module.exports = ({ dataDir, pickFolder }) => {
  const dir = () => path.join(dataDir(), 'projects');
  const file = id => path.join(dir(), id + '.json');
  const read = id => (okId(id) ? readJson(file(id)) : null);
  function write(p) {   // შეცდომას აბრუნებს — დრაფტი ჩუმად არ უნდა დაიკარგოს
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(p.id) + '.tmp', JSON.stringify(p));
    fs.renameSync(file(p.id) + '.tmp', file(p.id));
  }
  function all() {
    let names = [];
    try { names = fs.readdirSync(dir()).filter(f => f.endsWith('.json')); } catch (e) { }
    return names.map(f => readJson(path.join(dir(), f))).filter(p => p && okId(p.id));
  }
  return {
    'pj:list': () => all().map(p => ({ id: p.id, name: p.name, type: p.type, state: p.state, at: p.at })).sort((a, b) => b.at - a.at),
    'pj:get': id => {
      const p = read(id);
      if (!p) return { ok: false, error: 'io' };
      const files = p.state === 'saved' ? fromDisk(p) : p.files;   // შენახული პროექტი კომპიუტერის ფაილებიდან იხსნება
      if (!files || !Object.keys(files).length) return { ok: false, error: 'gone' };
      return { ok: true, project: { id: p.id, name: p.name, type: p.type, state: p.state, folder: p.folder || '', files } };
    },
    'pj:put': d => {
      if (!d || !okId(d.id) || !TYPES.includes(d.type) || !okPath(d.name) || d.name.includes('/') || d.name.length > 60) return { ok: false, error: 'bad_path' };
      const files = d.files && typeof d.files === 'object' ? d.files : {}, paths = Object.keys(files);
      if (!paths.length || paths.length > PJ.files || !paths.every(okPath)) return { ok: false, error: 'bad_path' };
      let total = 0;
      for (const k of paths) {
        const v = files[k], n = typeof v === 'string' ? Buffer.byteLength(v) : Infinity;
        if (n > PJ.file || v.includes('\0')) return { ok: false, error: 'limit' };   // მხოლოდ ტექსტი
        total += n;
      }
      if (total > PJ.total) return { ok: false, error: 'limit' };
      const old = read(d.id);
      if (!old && all().length >= PJ.max) return { ok: false, error: 'too_many' };
      const p = { id: d.id, name: old ? old.name : d.name, type: old ? old.type : d.type, folder: (old && old.folder) || '', paths, files: Object.fromEntries(paths.map(k => [k, files[k]])), at: Date.now() };
      p.state = p.folder ? 'dirty' : 'draft';
      try { write(p); } catch (e) { return { ok: false, error: errCode(e) }; }
      return { ok: true, state: p.state };
    },
    // პროექტი სიიდან იშლება; საქაღალდეში შენახული ფაილები ადგილზე რჩება
    'pj:del': id => { if (okId(id)) fs.rmSync(file(id), { force: true }); return { ok: true }; },
    // „შენახვა“: პირველად (ან pick) — საქაღალდის არჩევა; ჩაწერა + გადამოწმება; წარმატებისას დრაფტი იშლება, შეცდომისას რჩება
    'pj:save': async (id, pick) => {
      const p = read(id);
      if (!p) return { ok: false, error: 'io' };
      if (p.state === 'saved' && !pick) return { ok: true, folder: target(p) };
      const files = p.files || fromDisk(p);
      if (!Object.keys(files).length) return { ok: false, error: 'gone' };
      if (pick || !p.folder) {
        const f = await pickFolder('სად შევინახო „' + p.name + '“?');
        if (!f) return { ok: false, canceled: true };
        p.folder = f;
      }
      try {
        for (const [rel, text] of Object.entries(files)) { const f = filePath(p, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
        for (const [rel, text] of Object.entries(files)) if (fs.readFileSync(filePath(p, rel), 'utf8') !== text) throw Object.assign(new Error('verify'), { code: 'verify' });
        Object.assign(p, { state: 'saved', files: null, paths: Object.keys(files), at: Date.now() });
        write(p);
      } catch (e) { return { ok: false, error: errCode(e) }; }
      return { ok: true, folder: target(p) };
    }
  };
};
module.exports.okPath = okPath;
