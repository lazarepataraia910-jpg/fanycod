// CodeQuest: ტელეფონზე (ან კომპიუტერზე) დაყენებული აპის ოფლაინ რეჟიმი (PWA).
//   • საიტის გვერდები — ჯერ ინტერნეტიდან (ყოველთვის ახალი ვერსია); ინტერნეტის გარეშე ან 6 წამზე მეტ ლოდინზე — შენახული ასლი;
//   • CodeMirror, React და შრიფტები (cdnjs, Google Fonts) — ჯერ შენახული ასლიდან (ვერსიიანი ფაილებია, არ იცვლება);
//   • /api/* (ანგარიში, Pro) და YouTube არასოდეს ინახება.
// ახალი ვერსიისთვის VER შეცვალე — ძველი ქეში თავისით წაიშლება.
const VER = 'cq-v1';
const CORE = ['CodeQuest.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const LIBS = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const save = (req, res) => { if (res && res.ok) { const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); } return res; };
// ჯერ ინტერნეტი; თუ ვერ ან ძალიან ნელა — შენახული (თამაშის გვერდი ?-ის გარეშეც მოიძებნება)
function networkFirst(req) {
  const cached = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('CodeQuest.html') : undefined));
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const slow = setTimeout(() => cached().then(finish), 6000);
    fetch(req).then(r => { clearTimeout(slow); finish(save(req, r)); })
      .catch(() => { clearTimeout(slow); cached().then(r => finish(r || Response.error())); });
  });
}
// ბიბლიოთეკები: ჯერ შენახული; პირველად — CORS-ით, რომ ქეშში სრული (არა „გაუმჭვირვალე“) პასუხი ჩაიწეროს
function cacheFirst(req) {
  return caches.match(req.url).then(hit => hit || fetch(req.url, { mode: 'cors', credentials: 'omit' }).then(r => save(req.url, r)).catch(() => fetch(req)));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    e.respondWith(networkFirst(req));
  } else if (LIBS.test(req.url)) {
    e.respondWith(cacheFirst(req));
  }
});
