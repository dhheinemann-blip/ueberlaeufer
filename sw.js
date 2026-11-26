// Überläufer v0.6.0 – Service Worker (Network-First + Offline-Puffer + Samsung-Galerie Share-Target)
const UL_SW_CACHE = "ueberlaeufer-pwa-v0.6.0-final";
const UL_PRECACHE = ["./", "./index.html", "./manifest.json", "./icon-512.png"];
const UL_SHARE_DB = "UeberlaeuferShareDB";
const UL_SHARE_STORE = "shared_media";

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(UL_SHARE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(UL_SHARE_STORE)) {
        db.createObjectStore(UL_SHARE_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeSharedFiles(files) {
  const db = await openShareDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(UL_SHARE_STORE, "readwrite");
      const store = tx.objectStore(UL_SHARE_STORE);
      const now = Date.now();
      files.forEach((file, idx) => {
        if (!file || typeof file.size !== "number" || file.size <= 0) return;
        store.put({
          id: `sh_${now}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name || `galerie_${now}_${idx}.jpg`,
          type: file.type || "image/jpeg",
          lastModified: file.lastModified || now,
          blob: file,
          receivedAt: now
        });
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch (e) {}
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(UL_SW_CACHE)
      .then((cache) => Promise.all(UL_PRECACHE.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ueberlaeufer-pwa-") && k !== UL_SW_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Web Share Target POST aus der Samsung-Galerie abfangen
  if (req.method === "POST" && url.searchParams.has("share-target")) {
    event.respondWith((async () => {
      try {
        const formData = await req.formData();
        const mediaFiles = formData.getAll("media").filter((f) => f && typeof f.arrayBuffer === "function");
        if (mediaFiles.length > 0) {
          await storeSharedFiles(mediaFiles);
        }
      } catch (e) {
        // Fallback: trotzdem sauber in die App weiterleiten
      }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  // Nur eigene Origin-GET-Anfragen cachen (Gemini API & sw.js selbst niemals cachen!)
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.endsWith("/sw.js")) {
    return;
  }

  // 2. HTML / Navigation: strikt Network-First (GitHub-Updates sofort aktiv, im Wald offline aus Cache)
  const isNav = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  if (isNav) {
    event.respondWith((async () => {
      const cache = await caches.open(UL_SW_CACHE);
      try {
        const netResp = await fetch(req, { cache: "no-cache" });
        if (netResp && netResp.ok) {
          cache.put("./index.html", netResp.clone()).catch(() => {});
          cache.put("./", netResp.clone()).catch(() => {});
        }
        return netResp;
      } catch (err) {
        return (await cache.match(req)) || (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  // 3. Statische App-Assets (manifest.json, icon-512.png): Network-First mit schnellem Cache-Fallback
  event.respondWith((async () => {
    const cache = await caches.open(UL_SW_CACHE);
    try {
      const netResp = await fetch(req);
      if (netResp && netResp.ok) {
        cache.put(req, netResp.clone()).catch(() => {});
      }
      return netResp;
    } catch (err) {
      return (await cache.match(req)) || Response.error();
    }
  })());
});
