/* Aula — Service Worker untuk Web Push (PWA).
 * Scope "/" — notifikasi tetap muncul walau browser/tab ditutup
 * (bila PWA diinstal di Android/iOS, atau browser desktop berjalan).
 *
 * • install/activate: langsung ambil alih (skipWaiting + clients.claim).
 * • push: bila ada window Aula yang terlihat & terfokus → tidak perlu
 *   tampilkan (poller in-app yang mengurus); selain itu tampilkan
 *   notifikasi dengan tag per percakapan.
 * • notificationclick: fokuskan window Aula yang ada, atau buka baru.
 * • pushsubscriptionchange: langganan diperbarui push service → kirim
 *   ulang ke /api/push/subscribe (best-effort).
 */

const ICON = "/icons/icon-192.png";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Aula", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Aula";
  const body = data.body || "";
  const tag = data.tag || "aula";
  const url = (data && data.url) || "/";

  event.waitUntil(
    (async () => {
      try {
        const clientList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        // Ada window yang terlihat & terfokus → aplikasi sedang dipakai;
        // poller in-app sudah menampilkan notifikasi sendiri.
        const visibleFocused = clientList.some(
          (c) => c.visibilityState === "visible" && c.focused
        );
        if (visibleFocused) return;

        await self.registration.showNotification(title, {
          body,
          tag,
          icon: ICON,
          badge: ICON,
          data: { url },
          vibrate: [100, 50, 100],
          renotify: false,
        });
      } catch (e) {
        // Best-effort — jangan biarkan push event error.
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      try {
        const clientList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clientList) {
          try {
            if (new URL(client.url).origin === self.location.origin) {
              await client.focus();
              return;
            }
          } catch (e) {
            // URL client aneh — lanjut ke berikutnya.
          }
        }
        await self.clients.openWindow(url);
      } catch (e) {
        // Best-effort.
      }
    })()
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old =
          event.oldSubscription ||
          (await self.registration.pushManager.getSubscription());
        const options = old
          ? old.options
          : { userVisibleOnly: true };
        const sub = await self.registration.pushManager.subscribe(options);
        const json = sub.toJSON();
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
          }),
        });
      } catch (e) {
        // Best-effort — user dapat mengaktifkan ulang dari panel notifikasi.
      }
    })()
  );
});
