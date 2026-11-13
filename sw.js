const RELEASE = 'vGPT_1.0.0';
const PREFIX = 'bg-user-ok/lawica-taxi:shell:';
const NAME = PREFIX + RELEASE;
const BASE = new URL('./', self.location.href);
const FILES = new Map([
  ['', /^text\/html/],
  ['manifest.webmanifest', /^(application\/(manifest\+)?json|text\/plain)/],
  ...['board', 'main', 'demo', 'feed', 'install'].map(name => [`assets/${RELEASE}/${name}.js`, /javascript/]),
  [`assets/${RELEASE}/style.css`, /^text\/css/],
  ...['192', '512', 'maskable'].map(name => [`assets/${RELEASE}/icon-${name}.png`, /^image\/png/])
]);

function sameRelease(html) { return html.includes(`data-release="${RELEASE}"`); }

self.addEventListener('install', event => event.waitUntil((async () => {
  const bundle = await Promise.all(Array.from(FILES, async ([path, mime]) => {
    const url = new URL(path, BASE);
    const response = await fetch(url, { cache: 'reload', redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (response.status !== 200 || !mime.test(response.headers.get('Content-Type') || '')) throw new Error(`Niekompletny pakiet ${path}`);
    const bytes = await response.arrayBuffer();
    if (!path && !sameRelease(new TextDecoder().decode(bytes))) throw new Error('Niezgodna wersja pakietu');
    const headers = new Headers({ 'Content-Type': response.headers.get('Content-Type') });
    return [url, new Response(bytes, { headers })];
  }));
  const cache = await caches.open(NAME);
  try {
    for (const [url, response] of bundle) await cache.put(url, response);
  } catch (error) {
    await caches.delete(NAME);
    throw error;
  }
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const cachesForApp = (await caches.keys()).filter(key => key.startsWith(PREFIX));
  const obsolete = cachesForApp.filter(key => key !== NAME).slice(0, -1);
  await Promise.all(obsolete.map(key => caches.delete(key)));
  await self.clients.claim();
})()));

async function navigation(request) {
  try {
    const response = await fetch(request, { cache: 'no-cache', signal: AbortSignal.timeout(2200) });
    if (response.status === 200 && /^text\/html/.test(response.headers.get('Content-Type') || '') &&
        sameRelease(await response.clone().text())) return response;
  } catch { /* Open the coherent offline shell. */ }
  const cache = await caches.open(NAME);
  return await cache.match(BASE) ?? Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const path = url.pathname.slice(BASE.pathname.length);
  if (request.mode === 'navigate' && (path === '' || path === 'index.html')) {
    event.respondWith(navigation(request));
  } else if (path === 'manifest.webmanifest') {
    event.respondWith(fetch(request, { cache: 'no-cache', signal: AbortSignal.timeout(2500) }).then(response => {
      if (!response.ok) throw new Error('Manifest niedostępny');
      return response;
    }).catch(async () => (await caches.open(NAME)).match(request)));
  } else if (/^assets\/vGPT_\d+\.\d+\.\d+\//.test(path) && !url.search) {
    event.respondWith((async () => {
      const expectedRelease = path.split('/')[1];
      const key = PREFIX + expectedRelease;
      if (await caches.has(key)) {
        const cached = await (await caches.open(key)).match(request);
        if (cached) return cached;
      }
      return fetch(request);
    })());
  }
});
