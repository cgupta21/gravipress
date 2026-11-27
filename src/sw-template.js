const BUILD_ID = __BUILD_ID__;
const OFFLINE_BYTES = __OFFLINE_BYTES__;
const SHELL_ASSETS = __SHELL_ASSETS__;
const OFFLINE_ALLOWLIST = __OFFLINE_ALLOWLIST__;

const CACHE_PREFIX = 'gravipress-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`;
const OFFLINE_CACHE = `${CACHE_PREFIX}offline-${BUILD_ID}`;

const SHELL_SET = new Set(SHELL_ASSETS);
const ALL_REQUIRED = [...new Set([...SHELL_ASSETS, ...OFFLINE_ALLOWLIST])];
const ALLOWLIST_SET = new Set(ALL_REQUIRED);
const HTML_ROUTES = new Set([
  '/',
  '/index.html',
  '/privacy',
  '/privacy.html',
  '/faq',
  '/faq.html',
  '/terms',
  '/terms.html',
  '/404',
  '/404.html',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) &&
                key !== SHELL_CACHE &&
                key !== OFFLINE_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isValidAssetResponse(requestUrl, response) {
  if (!response || !response.ok || response.status !== 200 || response.type !== 'basic') {
    return false;
  }
  const pathname = requestUrl.pathname;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (/\.(js|mjs)$/i.test(pathname) && contentType.includes('text/html')) {
    return false;
  }
  if (/\.css$/i.test(pathname) && contentType.includes('text/html')) {
    return false;
  }
  return true;
}

async function broadcast(payload) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage(payload);
  }
}

async function computeOfflineStatus() {
  const shellCache = await caches.open(SHELL_CACHE);
  const offlineCache = await caches.open(OFFLINE_CACHE);
  let cachedCount = 0;
  let optionalCachedCount = 0;

  for (const urlPath of ALL_REQUIRED) {
    const inShell = await shellCache.match(urlPath);
    const inOffline = inShell ? null : await offlineCache.match(urlPath);
    if (inShell || inOffline) {
      cachedCount += 1;
      if (!SHELL_SET.has(urlPath)) optionalCachedCount += 1;
    }
  }

  return {
    type: 'OFFLINE_STATUS',
    buildId: BUILD_ID,
    totalCount: ALL_REQUIRED.length,
    cachedCount,
    optionalCachedCount,
    totalBytes: OFFLINE_BYTES,
    ready: cachedCount === ALL_REQUIRED.length,
  };
}

let preparingPromise = null;

async function prepareOfflineAssets() {
  if (preparingPromise) return preparingPromise;
  preparingPromise = (async () => {
    const shellCache = await caches.open(SHELL_CACHE);
    const offlineCache = await caches.open(OFFLINE_CACHE);
    const missing = [];

    for (const urlPath of ALL_REQUIRED) {
      const hit = (await shellCache.match(urlPath)) || (await offlineCache.match(urlPath));
      if (!hit) missing.push(urlPath);
    }

    let completed = ALL_REQUIRED.length - missing.length;
    await broadcast({
      type: 'OFFLINE_PROGRESS',
      cachedCount: completed,
      totalCount: ALL_REQUIRED.length,
      totalBytes: OFFLINE_BYTES,
    });

    const CONCURRENCY = 6;
    for (let i = 0; i < missing.length; i += CONCURRENCY) {
      const batch = missing.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (urlPath) => {
          const reqUrl = new URL(urlPath, self.location.origin);
          const res = await fetch(reqUrl.href, { cache: 'no-cache' });
          if (!isValidAssetResponse(reqUrl, res)) {
            throw new Error(`Invalid response for ${urlPath} (${res.status})`);
          }
          const target = SHELL_SET.has(urlPath) ? shellCache : offlineCache;
          await target.put(urlPath, res.clone());
          completed += 1;
        })
      );
      await broadcast({
        type: 'OFFLINE_PROGRESS',
        cachedCount: completed,
        totalCount: ALL_REQUIRED.length,
        totalBytes: OFFLINE_BYTES,
      });
    }

    const status = await computeOfflineStatus();
    await broadcast(status);
    return status;
  })()
    .catch(async (err) => {
      const status = await computeOfflineStatus();
      await broadcast({
        ...status,
        type: 'OFFLINE_ERROR',
        message: err?.message || 'Offline preparation failed.',
      });
    })
    .finally(() => {
      preparingPromise = null;
    });

  return preparingPromise;
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'GET_OFFLINE_STATUS') {
    event.waitUntil(computeOfflineStatus().then((s) => event.source?.postMessage(s)));
  } else if (data.type === 'PREPARE_OFFLINE') {
    event.waitUntil(prepareOfflineAssets());
  } else if (data.type === 'REMOVE_OFFLINE_DATA') {
    event.waitUntil(
      caches
        .delete(OFFLINE_CACHE)
        .then(() => computeOfflineStatus())
        .then((s) => broadcast(s))
    );
  } else if (data.type === 'APPLY_UPDATE') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const pathname = url.pathname;
  if (!ALLOWLIST_SET.has(pathname)) return;

  if (request.mode === 'navigate' || HTML_ROUTES.has(pathname)) {
    event.respondWith(
      caches.match(pathname, { cacheName: SHELL_CACHE }).then((cachedShell) => {
        if (cachedShell) return cachedShell;
        return fetch(request)
          .then((response) => {
            if (isValidAssetResponse(url, response)) {
              const targetCache = SHELL_SET.has(pathname) ? SHELL_CACHE : OFFLINE_CACHE;
              const copy = response.clone();
              caches.open(targetCache).then((cache) => cache.put(pathname, copy));
            }
            return response;
          })
          .catch(async () => {
            const cached =
              (await caches.match(pathname)) ||
              (pathname === '/' ? await caches.match('/index.html') : null);
            return cached || Response.error();
          });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(pathname).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (isValidAssetResponse(url, response)) {
          const targetCache = SHELL_SET.has(pathname) ? SHELL_CACHE : OFFLINE_CACHE;
          const copy = response.clone();
          caches.open(targetCache).then((cache) => cache.put(pathname, copy));
        }
        return response;
      });
    })
  );
});
