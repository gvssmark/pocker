// Family Hold'em — service worker
// Only caches this app's own static files (the "shell"). Anything else —
// Firebase auth/database calls, Google Fonts, etc. — is left completely
// alone and goes straight to the network, since game state must always be
// live and can't be served from a cache.

const CACHE_NAME = 'family-holdem-shell-v9';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './engine.js',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './instructions.html',
  './admin-help.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for our own shell files.
  // Everything else (Firebase, fonts, anything cross-origin) passes through untouched.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // Network-first: always try to get the latest version of the app first,
  // since this app changes often during development. Only fall back to the
  // cached copy if the network is genuinely unavailable (offline). A
  // cache-first strategy here would silently keep serving old app.js/
  // engine.js after every deploy, which is exactly the kind of "my fix
  // isn't showing up" bug this app can't afford.
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
