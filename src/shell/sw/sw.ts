// Service worker: shows Web Push notifications and opens the artifact (or
// focuses a tab already showing it) when one is tapped.
const sw = self as unknown as ServiceWorkerGlobalScope;
export {};

type Payload = { title?: string; body?: string; url?: string; tag?: string };

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event: ExtendableEvent) => event.waitUntil(sw.clients.claim()));

sw.addEventListener("push", (event: PushEvent) => {
  let data: Payload = {};
  try {
    data = event.data?.json() as Payload;
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    sw.registration.showNotification(data.title || "Artifacts", {
      body: data.body ?? "",
      tag: data.tag,
      data: { url: data.url ?? "/" },
      icon: "/static/icons/icon-192.png",
      badge: "/static/icons/favicon-32.png",
    }),
  );
});

sw.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string } | null)?.url ?? "/", sw.location.origin);
  // Only open pages on this origin.
  const target = url.origin === sw.location.origin ? url.href : sw.location.origin;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.find((w) => new URL(w.url).pathname === new URL(target).pathname);
      if (same) {
        await same.focus();
        if (same.url !== target) await same.navigate(target).catch(() => undefined);
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
