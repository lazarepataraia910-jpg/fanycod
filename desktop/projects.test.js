// node desktop/projects.test.js — „ჩემი პროექტების“ შენახვის შემოწმება (Electron-ის გარეშე, დროებით საქაღალდეში)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const make = require('./projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-pj-'));
const data = path.join(tmp, 'data'), out = path.join(tmp, 'out');
fs.mkdirSync(out);
let picked = out;
const pj = make({ dataDir: () => data, pickFolder: async () => picked });

(async () => {
  // გზები: მხოლოდ პროექტის შიგნით
  const { okPath } = make;
  for (const ok of ['index.html', 'src/App.jsx', 'css/a b.css', 'ჩემი.txt']) assert.ok(okPath(ok), ok);
  for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'CON', 'nul.txt', 'a/LPT1', 'x.', 'x ', 'a//b', 'a:b', 'a*b']) assert.ok(!okPath(bad), bad);

  // დრაფტი
  const files = { 'index.html': '<h1>hi</h1>', 'style.css': 'h1{}', 'script.js': 'console.log(1)' };
  assert.deepStrictEqual(pj['pj:put']({ id: 'abc123', name: 'ჩემი პროექტი', type: 'js', files }), { ok: true, state: 'draft' });
  assert.strictEqual(pj['pj:put']({ id: 'abc123', name: 'x', type: 'js', files: { '../evil.js': '' } }).error, 'bad_path');
  assert.strictEqual(pj['pj:put']({ id: 'abc123', name: '..', type: 'js', files }).error, 'bad_path');
  assert.strictEqual(pj['pj:put']({ id: '../x', name: 'x', type: 'js', files }).error, 'bad_path');
  assert.strictEqual(pj['pj:put']({ id: 'abc124', name: 'x', type: 'exe', files }).error, 'bad_path');
  assert.strictEqual(pj['pj:put']({ id: 'abc124', name: 'x', type: 'js', files: { 'a.bin': 'a\0b' } }).error, 'limit');
  assert.strictEqual(pj['pj:put']({ id: 'abc124', name: 'x', type: 'js', files: { 'a.js': 'x'.repeat(1048577) } }).error, 'limit');
  assert.strictEqual(pj['pj:list']().length, 1);
  assert.deepStrictEqual(pj['pj:get']('abc123').project.files, files);

  // შენახვა: ფაილები საქაღალდეში, დრაფტი იშლება, პროექტი დისკიდან იხსნება
  const r = await pj['pj:save']('abc123');
  assert.deepStrictEqual(r, { ok: true, folder: path.join(out, 'ჩემი პროექტი') });
  assert.strictEqual(fs.readFileSync(path.join(out, 'ჩემი პროექტი', 'script.js'), 'utf8'), 'console.log(1)');
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'projects', 'abc123.json'), 'utf8'));
  assert.strictEqual(saved.state, 'saved');
  assert.strictEqual(saved.files, null);
  fs.writeFileSync(path.join(out, 'ჩემი პროექტი', 'style.css'), 'h1{color:red}');   // სხვა რედაქტორში შეცვლილი
  assert.strictEqual(pj['pj:get']('abc123').project.files['style.css'], 'h1{color:red}');

  // ახალი ცვლილება → dirty; ჩაწერის შეცდომისას (საქაღალდის ნაცვლად ფაილი) დრაფტი რჩება
  assert.strictEqual(pj['pj:put']({ id: 'abc123', name: 'ჩემი პროექტი', type: 'js', files: Object.assign({}, files, { 'script.js': 'v2' }) }).state, 'dirty');
  picked = path.join(tmp, 'not-a-folder');
  fs.writeFileSync(picked, '');
  const bad = await pj['pj:save']('abc123', true);
  assert.strictEqual(bad.ok, false);
  assert.ok(['io', 'missing', 'denied'].includes(bad.error), bad.error);
  const kept = pj['pj:get']('abc123').project;
  assert.strictEqual(kept.state, 'dirty');
  assert.strictEqual(kept.files['script.js'], 'v2');

  // გაუქმებული ფანჯარა
  picked = null;
  assert.deepStrictEqual(await pj['pj:save']('abc123', true), { ok: false, canceled: true });

  // ლიმიტი: 20 პროექტი
  for (let i = 0; i < 19; i++) pj['pj:put']({ id: 'p' + i + 'xyz', name: 'p' + i, type: 'py', files: { 'main.py': '' } });
  assert.strictEqual(pj['pj:put']({ id: 'over20', name: 'x', type: 'py', files: { 'main.py': '' } }).error, 'too_many');

  // წაშლა: სიიდან ქრება, საქაღალდეში შენახული ფაილები რჩება
  pj['pj:del']('abc123');
  assert.strictEqual(pj['pj:get']('abc123').ok, false);
  assert.ok(fs.existsSync(path.join(out, 'ჩემი პროექტი', 'index.html')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('desktop/projects.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
