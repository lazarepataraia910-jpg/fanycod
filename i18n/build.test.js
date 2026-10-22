// node i18n/build.test.js — ლექსიკონის ჩანაცვლების წესების შემოწმება
const assert = require('assert');
const { translate } = require('./build');

// მთლიანი სტრიქონი და HTML-ის ტექსტი იცვლება, სიტყვა გრძელ წინადადებაში — არა
assert.strictEqual(translate("t('ლეველი') + '<b>ლეველი</b>' + 'ახალი ლეველი'", { 'ლეველი': 'Level' }), "t('Level') + '<b>Level</b>' + 'ახალი ლეველი'");
// გრძელი გასაღები პირველია
assert.strictEqual(translate('"ახალი ლეველი"', { 'ლეველი': 'Level', 'ახალი ლეველი': 'New level' }), '"New level"');
// _raw ნებისმიერ ტექსტს ცვლის და ჯერ სრულდება
assert.strictEqual(translate('<html lang="ka">', { _raw: [['lang="ka"', 'lang="en"']] }), '<html lang="en">');
// null ქართულად ტოვებს, '' შლის
assert.strictEqual(translate("'კარგი' + '-ზე'", { 'კარგი': null, '-ზე': '' }), "'კარგი' + ''");
// ბრჭყალების რაოდენობა უნდა ემთხვეოდეს
assert.throws(() => translate("'ბიტის'", { 'ბიტის': "Bit's" }), /ბრჭყალები/);
console.log('i18n build: ok');
