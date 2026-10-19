// Errors in artifacts.boo's own pages (never an artifact's, which run in their frame and are reported to its
// owner) go to the server, grouped there with the same ones, so a bug in the app shows up without anyone
// writing in. Only the message and the page's path go, and only a few per page view.
const flag = "__artErrors";
const w = window as unknown as Record<string, boolean>;
if (!w[flag]) {
  w[flag] = true;
  let sent = 0;
  const send = (message: string) => {
    if (!message || sent >= 3) return;
    sent++;
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message.slice(0, 1000), place: location.pathname }),
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener("error", (e) => send(e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.message ?? "")));
  window.addEventListener("unhandledrejection", (e) => send(e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason ?? "")));
}
