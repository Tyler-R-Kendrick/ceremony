const CACHE = "ceremony-public-shell-v1";
const STATIC = ["/offline.html", "/icon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const path of STATIC) {
        const response = await fetch(path, {
          credentials: "omit",
          cache: "reload",
        });
        if (!response.ok) throw new Error("Static shell unavailable");
        await cache.put(path, response);
      }
    }),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("ceremony-public-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});
self.addEventListener("message", (event) => {
  if (
    event.origin === self.location.origin &&
    event.data?.type === "activate-static-update"
  )
    void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  if (STATIC.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) => (await cache.match(url.pathname)) ?? fetch(request),
        ),
    );
    return;
  }
  // Never intercept broker, callbacks, streams, environment, provider pages, or authenticated APIs.
  if (request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match("/offline.html")) ?? Response.error(),
      ),
    );
  }
});
