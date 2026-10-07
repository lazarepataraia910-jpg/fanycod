// CodeQuest — კომპიუტერის ვერსია (Electron).
// თამაში იხსნება მისამართზე codequest://app/CodeQuest.html:
//   • ინტერნეტით — ყოველთვის ახალი ვერსია საიტიდან (და ასლი კომპიუტერში ინახება);
//   • ინტერნეტის გარეშე — ბოლოს შენახული ან აპთან მოყოლილი ასლი (app/CodeQuest.html).
// origin ყოველთვის ერთია, ამიტომ პროგრესი (localStorage) არ იკარგება. /api/* საიტზე გადაეგზავნება (Pro-ს კოდის შემოწმება),
// CodeMirror, React და შრიფტები (/_ext/*) ერთხელ ჩამოიტვირთება და მერე კომპიუტერიდან იხსნება.
'use strict';
const { app, BrowserWindow, Menu, protocol, net, shell, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SITE = (process.env.CODEQUEST_SITE || 'https://codequest-lazare.vercel.app').replace(/\/+$/, '');
const OFFLINE = process.env.CODEQUEST_OFFLINE === '1';   // სატესტოდ: ქსელი „გათიშულია“
const ORIGIN = 'codequest://app';
const START = ORIGIN + '/CodeQuest.html';
const BUNDLE = path.join(__dirname, 'app');
const EXT_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
let DATA = '', win = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'codequest', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

/* ---------- ფაილები ---------- */
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
function writeAtomic(f, data) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', data);
    fs.renameSync(f + '.tmp', f);
  } catch (e) { }
}
const keyOf = url => crypto.createHash('sha1').update(url).digest('hex');
const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });

async function fetchTimeout(url, ms, init) {
  if (OFFLINE) throw new Error('offline');
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await net.fetch(url, Object.assign({ signal: ac.signal, cache: 'no-store' }, init)); } finally { clearTimeout(t); }
}

/* ---------- თამაშის გვერდი ---------- */
// საიტზე CDN-ის მისამართები /_ext/-ზე გადადის, რომ ინტერნეტის გარეშეც ჩაიტვირთოს
const rewrite = html => html
  .replace(/https:\/\/cdnjs\.cloudflare\.com\//g, ORIGIN + '/_ext/cdnjs.cloudflare.com/')
  .replace(/https:\/\/fonts\.googleapis\.com\/css2/g, ORIGIN + '/_ext/fonts.googleapis.com/css2');
const validPage = html => typeof html === 'string' && html.length > 100000 && html.includes('id="scr-menu"');
const pageFile = () => path.join(DATA, 'site', 'CodeQuest.html');

function savePage(html) {
  writeAtomic(pageFile(), html);
  writeAtomic(pageFile() + '.json', JSON.stringify({ at: Date.now() }));
}
// ბოლოს შენახული ან აპთან მოყოლილი ასლი — რომელიც უფრო ახალია
function offlinePage() {
  const bundled = readJson(path.join(BUNDLE, 'build.json')) || { at: 0 };
  const cached = readJson(pageFile() + '.json');
  if (cached && cached.at > bundled.at) { try { return fs.readFileSync(pageFile(), 'utf8'); } catch (e) { } }
  return fs.readFileSync(path.join(BUNDLE, 'CodeQuest.html'), 'utf8');
}
async function page() {
  let html = null;
  const load = fetchTimeout(SITE + '/CodeQuest.html', 60000).then(async r => {
    const t = r.ok ? await r.text() : null;
    if (validPage(t)) { savePage(t); return t; }
    return null;
  }).catch(() => null);
  // ნელ ინტერნეტზე 5 წამზე მეტს არ ველოდებით: ამჯერად შენახული ასლი იხსნება, ახალი კი შემდეგ გახსნაზე
  html = await Promise.race([load, new Promise(r => setTimeout(() => r(null), 5000))]);
  if (!html) html = offlinePage();
  return new Response(rewrite(html), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------- CDN-ის ფაილები: აპთან მოყოლილი → შენახული → ინტერნეტი ---------- */
async function ext(rest) {
  const host = rest.split('/')[0];
  if (!EXT_HOSTS.includes(host)) return notFound();
  const url = new URL('https://' + rest).href, key = keyOf(url);
  for (const dir of [path.join(BUNDLE, 'ext'), path.join(DATA, 'ext')]) {
    const meta = readJson(path.join(dir, key + '.json'));
    if (meta) {
      try { return new Response(fs.readFileSync(path.join(dir, key + '.bin')), { headers: { 'content-type': meta.type, 'access-control-allow-origin': '*' } }); } catch (e) { }
    }
  }
  try {
    const r = await fetchTimeout(url, 30000, { cache: 'default' });
    if (!r.ok) return new Response('', { status: r.status });
    const type = r.headers.get('content-type') || 'application/octet-stream';
    let body = Buffer.from(await r.arrayBuffer());
    if (host === 'fonts.googleapis.com') body = Buffer.from(body.toString('utf8').replace(/https:\/\/fonts\.gstatic\.com\//g, ORIGIN + '/_ext/fonts.gstatic.com/'));
    writeAtomic(path.join(DATA, 'ext', key + '.bin'), body);
    writeAtomic(path.join(DATA, 'ext', key + '.json'), JSON.stringify({ url, type }));
    return new Response(body, { headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

/* ---------- /api/* → საიტი (Pro-ს ლიცენზიის შემოწმება) ---------- */
async function api(req, u) {
  try {
    const init = { method: req.method, headers: { 'content-type': req.headers.get('content-type') || 'application/json' } };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    const r = await fetchTimeout(SITE + u.pathname + u.search, 20000, init);
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ valid: false, error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}

async function handle(req) {
  const u = new URL(req.url);
  if (u.host !== 'app') return notFound();
  if (u.pathname.startsWith('/api/')) return api(req, u);
  if (u.pathname.startsWith('/_ext/')) return ext(u.pathname.slice(6) + u.search);
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/CodeQuest.html') return page();
  return notFound();
}

/* ---------- ფანჯარა ---------- */
const stateFile = () => path.join(DATA, 'window.json');
function loadBounds() {
  const s = readJson(stateFile());
  if (!s || !s.width || !s.height) return null;
  const wa = screen.getDisplayMatching(s).workArea;   // ეკრანი, რომელზეც ბოლოს იყო (თუ ჯერ კიდევ მიერთებულია)
  const fits = s.x >= wa.x - 50 && s.y >= wa.y - 50 && s.x + 100 <= wa.x + wa.width && s.y + 100 <= wa.y + wa.height;
  return fits ? s : { width: Math.min(s.width, wa.width), height: Math.min(s.height, wa.height), max: s.max };
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const max = win.isMaximized() || win.isFullScreen();
  writeAtomic(stateFile(), JSON.stringify(Object.assign({}, win.getNormalBounds(), { max })));
}

const isWeb = url => /^https?:\/\//i.test(url);
function openOutside(url) { if (isWeb(url)) shell.openExternal(url); }

function menu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: 'CodeQuest', submenu: [{ role: 'about', label: 'CodeQuest-ის შესახებ' }, { type: 'separator' }, { role: 'hide', label: 'დამალვა' }, { role: 'unhide', label: 'ყველას ჩვენება' }, { type: 'separator' }, { role: 'quit', label: 'გასვლა' }] }] : []),
    { label: 'თამაში', submenu: [
      { label: 'მთავარი გვერდი', accelerator: 'CmdOrCtrl+Shift+H', click: () => win && win.loadURL(START) },
      { role: 'reload', label: 'თავიდან ჩატვირთვა' },
      { type: 'separator' },
      { label: 'საიტის გახსნა ბრაუზერში', click: () => openOutside(SITE + '/CodeQuest.html') },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'გასვლა' }])
    ] },
    { label: 'რედაქტირება', submenu: [
      { role: 'undo', label: 'დაბრუნება' }, { role: 'redo', label: 'გამეორება' }, { type: 'separator' },
      { role: 'cut', label: 'ამოჭრა' }, { role: 'copy', label: 'კოპირება' }, { role: 'paste', label: 'ჩასმა' }, { role: 'selectAll', label: 'ყველას მონიშვნა' }
    ] },
    { label: 'ხედი', submenu: [
      { role: 'zoomIn', label: 'გადიდება' }, { role: 'zoomOut', label: 'დაპატარავება' }, { role: 'resetZoom', label: 'ჩვეულებრივი ზომა' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'სრული ეკრანი' }
    ] }
  ]);
}

// მარჯვენა ღილაკის მენიუ: კოპირება და ჩასმა (Electron-ს თავისით არ აქვს)
function contextMenu(wc, p) {
  const items = [];
  if (p.isEditable) items.push({ role: 'cut', label: 'ამოჭრა', enabled: p.editFlags.canCut }, { role: 'copy', label: 'კოპირება', enabled: p.editFlags.canCopy }, { role: 'paste', label: 'ჩასმა', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: 'ყველას მონიშვნა' });
  else if (p.selectionText && p.selectionText.trim()) items.push({ role: 'copy', label: 'კოპირება' });
  if (p.linkURL && isWeb(p.linkURL)) items.push(...(items.length ? [{ type: 'separator' }] : []), { label: 'ბმულის გახსნა ბრაუზერში', click: () => openOutside(p.linkURL) });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
}

function createWindow() {
  const b = loadBounds() || { width: 1280, height: 820 };
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: 360, minHeight: 520,
    title: 'CodeQuest', show: false, backgroundColor: '#f4f6fb', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  let bt = null;
  const later = () => { clearTimeout(bt); bt = setTimeout(saveBounds, 600); };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // გარე ბმულები (YouTube, გადახდა, GitHub...) ჩვეულებრივ ბრაუზერში იხსნება
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) { e.preventDefault(); openOutside(url); } });
  wc.on('context-menu', (e, p) => contextMenu(wc, p));
  win.loadURL(START);
}

app.whenReady().then(() => {
  DATA = app.getPath('userData');
  app.userAgentFallback = app.userAgentFallback + ' CodeQuestDesktop/' + app.getVersion();
  protocol.handle('codequest', handle);
  const ses = session.defaultSession;
  // YouTube-ის ჩასმულ ვიდეოს საიტის მისამართი სჭირდება (Referer), თორემ „Error 153“-ს აჩვენებს
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] }, (d, cb) => {
    d.requestHeaders.Referer = SITE + '/';
    cb({ requestHeaders: d.requestHeaders });
  });
  // კამერა, მიკროფონი, შეტყობინებები... არ სჭირდება; მხოლოდ სრული ეკრანი (ვიდეო) და ბუფერში კოპირება
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
  Menu.setApplicationMenu(menu());
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
