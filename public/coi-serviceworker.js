/* coi-serviceworker v0.1.7 - github.com/gzuidhof/coi-serviceworker */
/*
 * This service worker injects Cross-Origin-Opener-Policy and
 * Cross-Origin-Embedder-Policy headers so that SharedArrayBuffer
 * (required by DuckDB-WASM multi-threading) works on GitHub Pages.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", function (event) {
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.status === 0) {
          return response;
        }

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
        newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch((e) => console.error(e))
  );
});

// Registration script — runs when loaded as a <script> tag (not as a SW)
if (typeof window !== "undefined") {
  (function () {
    const coi = {
      quiet: false,
      doReload: () => window.location.reload(),
    };

    // Already cross-origin isolated — nothing to do
    if (window.crossOriginIsolated !== false) return;

    if (!window.isSecureContext) {
      !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      return;
    }

    if (!navigator.serviceWorker) {
      !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
      return;
    }

    navigator.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

        registration.addEventListener("updatefound", () => {
          !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
          coi.doReload();
        });

        if (registration.active && !navigator.serviceWorker.controller) {
          !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
          coi.doReload();
        }
      },
      (err) => {
        !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
      }
    );
  })();
}
