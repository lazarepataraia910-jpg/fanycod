// სკოლის გენერატორის თვითშემოწმება: node school/test.js  (კონტენტის ფორმატის გარჩევა; გვერდებს არ აწყობს)
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { frontmatter, inline, md, parseDoc, warn } = require('./build.js');
const ctx = kind => ({ kind, toc: [], heads: [], text: [], langs: new Set(), ids: 0, blocks: 0, runs: 0, exercises: 0, questions: 0, warn: m => warn.push(m) });

// frontmatter: სტრიქონი, რიცხვი, სია, ორწერტილი მნიშვნელობაში
let f = frontmatter('---\ntitle: "ცვლადი: ყუთი"\nreadingTime: 6\ntags: [a, "b c"]\n---\nტექსტი');
assert.deepStrictEqual(f.meta, { title: 'ცვლადი: ყუთი', readingTime: 6, tags: ['a', 'b c'] });
assert.strictEqual(f.body, 'ტექსტი');
assert.strictEqual(frontmatter('ფრონტმატერის გარეშე').body, 'ფრონტმატერის გარეშე');

// სტრიქონის შიგნით: HTML უვნებელდება, კოდში ვარსკვლავი არ იქცევა დახრილად, ბმული მხოლოდ უსაფრთხო მისამართზე
assert.strictEqual(inline('x < 5 & <b>'), 'x &lt; 5 &amp; &lt;b&gt;');
assert.strictEqual(inline('`3 * 4` და **მუქი** და *დახრილი*'), '<code>3 * 4</code> და <b>მუქი</b> და <i>დახრილი</i>');
assert.strictEqual(inline('`<script>`'), '<code>&lt;script&gt;</code>');
assert.ok(inline('[კურსები](/learn/courses/)').includes('<a href="/learn/courses/">კურსები</a>'));
assert.ok(!inline('[x](javascript:alert(1))').includes('<a '));

// ბლოკები: სათაური სარჩევში, სია, ცხრილი, კოდი, გასაშვები კოდი
let c = ctx('chapter');
let h = md('## რას ისწავლი\n- ერთი\n- ორი\n\n| ა | ბ |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1 < 2;\n```\n\n```js run\nconsole.log(1);\n```', c);
assert.deepStrictEqual(c.toc, [{ id: 's1', text: 'რას ისწავლი' }]);
assert.ok(h.includes('<ul><li>ერთი</li><li>ორი</li></ul>') && h.includes('<th>ა</th>') && h.includes('<td>2</td>'));
assert.ok(h.includes('let a = 1 &lt; 2;') && h.includes('class="copy"'));
assert.ok(h.includes('class="run" data-lang="js" data-mime="text/javascript"') && h.includes('class="btn primary run-go"'));
assert.strictEqual(c.runs, 1); assert.strictEqual(c.blocks, 2); assert.ok(c.langs.has('js'));

// სხვა ენა: „გაუშვი“ მოსალოდნელ შედეგს აჩვენებს
c = ctx('chapter');
h = md('```python run\nprint("hi")\n```\n\n```output\nhi\n```', c);
assert.ok(h.includes('data-lang="python"') && h.includes('data-expect="hi"') && !h.includes('შედეგი</span>'));

// სავარჯიშო მინიშნებით და ამოხსნით; ქვიზი სწორი პასუხის ნომრით
c = ctx('chapter');
h = md('<Exercise>\nპირობა\n\n<Hint>მინიშნება `x`</Hint>\n\n<Solution>\n```js\n1;\n```\n</Solution>\n</Exercise>\n\n<Quiz>\n### კითხვა?\n- [ ] ა\n- [x] ბ\n> ახსნა\n</Quiz>', c);
assert.ok(h.includes('<section class="exercise">') && h.includes('<details class="hint">') && h.includes('<details class="solution">'));
assert.ok(h.includes('data-ok="1"') && h.includes('<button type="button" class="q-o">ბ</button>') && h.includes('ახსნა'));
assert.strictEqual(c.exercises, 1); assert.strictEqual(c.questions, 1);
assert.deepStrictEqual(c.toc.map(t => t.text), ['სავარჯიშო', 'მინი-ქვიზი']);

// კითხვა სწორი პასუხის გარეშე — გამოტოვება და გაფრთხილება, არა ჩავარდნა
c = ctx('quiz'); const before = warn.length;
h = md('<Quiz>\n### ცუდი\n- [ ] ა\n- [ ] ბ\n</Quiz>', c);
assert.strictEqual(c.questions, 0); assert.ok(warn.length > before);

// ფაილი: შაბლონს აკლია ნაწილები → გაფრთხილება; არარსებული ფაილი → null („მალე“)
const tmp = path.join(os.tmpdir(), 'cq-school-test-' + process.pid + '.mdx');
fs.writeFileSync(tmp, '---\ntitle: სატესტო\n---\n## რას ისწავლი\n- ა\n');
const d = parseDoc(tmp, 'chapter');
fs.unlinkSync(tmp);
assert.strictEqual(d.meta.title, 'სატესტო'); assert.ok(d.minutes >= 2);
assert.ok(warn.some(w => w.includes('შაბლონს აკლია')));
assert.strictEqual(parseDoc(tmp, 'chapter'), null);

console.log('school/test.js: ყველა შემოწმება გავიდა');
