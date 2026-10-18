// Layout check: loads one of our own pages in a headless browser at phone
// width and reports whether anything sticks out sideways, and what. Operators
// run it across every page (spikes/e2e-layout.ts) before shipping UI changes,
// because overflow on phones is the bug that keeps coming back.
import type { CheckEnv } from "./check.ts";

export const PHONE = { width: 390, height: 844 };

export type LayoutResult =
  | { ok: boolean; width: number; scrollWidth: number; offenders: { el: string; right: number; text: string }[]; screenshot?: string }
  | { ok: false; error: string };

export async function checkLayout(env: CheckEnv, url: string, cookie?: { name: string; value: string }): Promise<LayoutResult> {
  if (!env.BROWSER) return { ok: false, error: "no browser binding" };
  const res = await env.BROWSER.quickAction("snapshot", {
    url,
    formats: ["content", "screenshot"],
    screenshotOptions: { type: "jpeg", quality: 50 },
    viewport: PHONE,
    gotoOptions: { waitUntil: "networkidle0", timeout: 20000 },
    // Our own static script, so the pages' Content-Security-Policy lets it run (an inline one is refused).
    addScriptTag: [{ url: `${new URL(url).origin}/static/layout-check.js` }],
    waitForTimeout: 2500,
    ...(cookie ? { cookies: [{ ...cookie, url }] } : {}),
    cacheTTL: 0,
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { content?: string; screenshot?: string }; errors?: { message?: string }[] } | null;
  if (!res.ok || !body?.success) return { ok: false, error: body?.errors?.[0]?.message ?? `HTTP ${res.status}` };
  const m = /<pre id="layout-check" hidden="">([\s\S]*?)<\/pre>/.exec(body.result?.content ?? "");
  if (!m) return { ok: false, error: "the page didn't finish loading" };
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const r = JSON.parse(decoded) as { width: number; scrollWidth: number; offenders: { el: string; right: number; text: string }[] };
  const ok = r.scrollWidth <= r.width && r.offenders.length === 0;
  // A screenshot only when something overflows, as evidence.
  return { ok, ...r, ...(ok ? {} : { screenshot: body.result?.screenshot }) };
}
