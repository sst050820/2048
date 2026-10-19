/* Offline cache for the installed (home screen / desktop) app.
 * Bump VERSION whenever any cached file changes. */
var VERSION = 'ninghe-v11';
var FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/physics.js',
  'js/mode.js',
  'js/achievements.js',
  'js/styles.js',
  'js/render.js',
  'js/audio.js',
  'js/game.js',
  'manifest.webmanifest',
  'fonts/audiowide-latin.woff2',
  'fonts/nunito-latin.woff2',
  'fonts/souba_score.ttf',
  'fonts/souba_text.otf',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; })
      .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

// Network first so updates arrive quickly; only successful responses are cached,
// and offline / error responses fall back to the last healthy cached copy.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (res) {
      // Only cache successful (2xx), same-origin responses. An error response
      // (e.g. HTTP 503) must never overwrite a healthy cached entry.
      if (res.ok && res.type === 'basic') {
        var copy = res.clone();
        e.waitUntil(caches.open(VERSION).then(function (c) { return c.put(e.request, copy); }));
        return res;
      }
      // Error response: fall back to the existing healthy cache, else the error.
      return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        return hit || res;
      });
    }).catch(function () {
      // Network failure (offline): serve the cached copy.
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
