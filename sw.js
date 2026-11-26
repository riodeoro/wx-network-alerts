"use strict";

const VERSION = "v1";
const CHART_CACHE = "wx-charts-" + VERSION;
const PARQUET_CACHE = "wx-parquet-" + VERSION;
const TILE_CACHE = "wx-tiles-" + VERSION;
const KEEP = new Set([CHART_CACHE, PARQUET_CACHE, TILE_CACHE]);
const DATA_HOSTS = new Set([
  "pub-5f2f92f12a6b4b88aa9f4558095a9644.r2.dev",
  "pub-f7822b16eb0e42279d4cbfb96e0709af.r2.dev",
]);
const TILE_HOST = "s3.amazonaws.com";
const TILE_PATH = "/elevation-tiles-prod/";
const CHECKED_HEADER = "x-wx-checked";
const RECHECK_MS = 5 * 60 * 1000;
const LIMITS = { [CHART_CACHE]: 300, [PARQUET_CACHE]: 200, [TILE_CACHE]: 3000 };
const TRIM_DELAY_MS = 2000;
const NOTIFY_DELAY_MS = 400;

const trimTimers = new Map();
const checking = new Map();
let notifyTimer = 0;
const notifyQueue = new Set();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("wx-") && !KEEP.has(n)).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

function isTile(url) {
  return url.hostname === TILE_HOST && url.pathname.indexOf(TILE_PATH) === 0;
}

function cacheFor(url) {
  if (isTile(url)) return TILE_CACHE;
  return /\.parquet$/i.test(url.pathname) ? PARQUET_CACHE : CHART_CACHE;
}

function wanted(request) {
  if (request.method !== "GET") return null;
  if (request.headers.has("range")) return null;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!DATA_HOSTS.has(url.hostname) && !isTile(url)) return null;
  return url;
}

function keyOf(url) {
  return url.origin + url.pathname;
}

function signature(res) {
  const tag = res.headers.get("ETag") || "";
  const mod = res.headers.get("Last-Modified") || "";
  return tag || mod ? tag + "|" + mod : "";
}

async function sameBody(a, b) {
  const [x, y] = await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}

async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set(CHECKED_HEADER, String(Date.now()));
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

function scheduleTrim(name) {
  if (trimTimers.has(name)) return;
  trimTimers.set(
    name,
    setTimeout(() => {
      trimTimers.delete(name);
      trim(name).catch(() => {});
    }, TRIM_DELAY_MS)
  );
}

async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const extra = keys.length - (LIMITS[name] || 200);
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function store(name, key, res) {
  const cache = await caches.open(name);
  const copy = await stamped(res);
  try {
    await cache.delete(key);
    await cache.put(key, copy.clone());
  } catch (e) {
    const keys = await cache.keys();
    for (let i = 0; i < Math.ceil(keys.length / 2); i++) await cache.delete(keys[i]);
  }
  scheduleTrim(name);
  return copy;
}

function notify(key) {
  notifyQueue.add(key);
  if (notifyTimer) return;
  notifyTimer = setTimeout(async () => {
    notifyTimer = 0;
    const urls = Array.from(notifyQueue);
    notifyQueue.clear();
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) client.postMessage({ type: "wx-data-updated", urls: urls });
  }, NOTIFY_DELAY_MS);
}

function revalidate(request, name, key, held) {
  if (checking.has(key)) return checking.get(key);
  const job = (async () => {
    try {
      const res = await fetch(request.url, { mode: "cors", credentials: "omit", cache: "no-cache" });
      if (!res.ok) return;
      const before = signature(held);
      const after = signature(res);
      const changed = before && after ? before !== after : !(await sameBody(held, res));
      await store(name, key, res);
      if (changed) notify(key);
    } catch (e) {
      void e;
    } finally {
      checking.delete(key);
    }
  })();
  checking.set(key, job);
  return job;
}

const tileJobs = new Map();

async function respondTile(url) {
  const key = keyOf(url);
  const cache = await caches.open(TILE_CACHE);
  const held = await cache.match(key);
  if (held) return held;
  if (tileJobs.has(key)) return (await tileJobs.get(key)).clone();
  const job = (async () => {
    const res = await fetch(url.href, { mode: "cors", credentials: "omit" });
    if (!res.ok) return res;
    const body = await res.arrayBuffer();
    const headers = new Headers();
    headers.set("Content-Type", res.headers.get("Content-Type") || "image/png");
    const copy = new Response(body, { status: 200, statusText: "OK", headers });
    try {
      await cache.put(key, copy.clone());
      scheduleTrim(TILE_CACHE);
    } catch (e) {
      void e;
    }
    return copy;
  })();
  tileJobs.set(key, job);
  try {
    return (await job).clone();
  } finally {
    tileJobs.delete(key);
  }
}

async function respond(event, url) {
  if (isTile(url)) return respondTile(url);
  const request = event.request;
  const name = cacheFor(url);
  const key = keyOf(url);
  const cache = await caches.open(name);
  const held = await cache.match(key);
  if (held) {
    const checked = Number(held.headers.get(CHECKED_HEADER) || 0);
    if (Date.now() - checked > RECHECK_MS) {
      event.waitUntil(revalidate(request, name, key, held.clone()));
    }
    return held;
  }
  const res = await fetch(request.url, { mode: "cors", credentials: "omit", cache: "no-cache" });
  if (!res.ok) return res;
  return store(name, key, res);
}

self.addEventListener("fetch", (event) => {
  const url = wanted(event.request);
  if (!url) return;
  event.respondWith(
    respond(event, url).catch(() => fetch(event.request))
  );
});