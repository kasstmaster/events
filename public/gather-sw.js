// Never cache authenticated pages, API responses, invitations, media or sign-in links.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET")
    return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Gather</title><h1>Gather is offline</h1><p>Reconnect to sign in or view your invitations. Private information is never stored in the offline app.</p>",
          {
            status: 503,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy": "default-src 'none'",
            },
          },
        ),
    ),
  );
});
