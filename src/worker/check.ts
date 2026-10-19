// Render check: Cloudflare Browser Run loads the artifact's frame top-level in
// headless Chrome (check mode). One snapshot call returns the page HTML, from
// which we read the runtime's result, and a screenshot for the agent. Runs after
// writes so agents see runtime errors and layout in the tool result instead of in
// a viewer's browser.
import { signToken } from "./session.ts";

export type RenderCheck =
  | { status: "ok"; ms: number; textLength: number }
  | { status: "errors"; ms: number; errors: string[] }
  | { status: "skipped"; reason: string }
  | { status: "queued"; inSeconds: number };

/** A check plus the JPEG screenshot (base64) when Browser Run returned one. */
export type CheckOutcome = { check: RenderCheck; screenshot?: string };

type BrowserRunBinding = {
  quickAction(action: "snapshot", options: Record<string, unknown>): Promise<Response>;
};

export type CheckEnv = { BROWSER?: BrowserRunBinding; SESSION_SECRET: string };

export const SCREENSHOT_VIEWPORT = { width: 1024, height: 768 };
/** A phone, for checks of how a page reads there. */
export const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

/** How to look at the page: the stored check is the default (desktop, first screen); the rest are on demand. */
export type CheckView = { phone?: boolean; fullPage?: boolean; section?: string };
export const isDefaultView = (v?: CheckView) => !v || (!v.phone && !v.fullPage && !v.section);
export function describeView(v?: CheckView): string {
  const size = v?.phone ? "390×844 (phone)" : "1024×768";
  return v?.fullPage ? `the whole page at ${v.phone ? "phone width (390)" : "1024 wide"}` : v?.section ? `the screen at #${v.section}, ${size}` : `the first screen (${size})`;
}

/** One Browser Run call; the workspace queues checks when Browser Run rate-limits. */
export async function renderCheck(
  env: CheckEnv,
  origin: string,
  id: string,
  version: number,
  workspace: string,
  view?: CheckView,
): Promise<CheckOutcome | { rateLimited: true }> {
  if (!env.BROWSER) return { check: { status: "skipped", reason: "no browser binding" } };
  // Single use: the frame spends it when it loads, so a copy that leaks (say, printed by the page) is already dead.
  const token = await signToken(env.SESSION_SECRET, "frame", 120, { id, w: workspace, c: true, j: crypto.randomUUID() });
  // A query parameter, not a #fragment: Browser Run doesn't keep fragments.
  const section = view?.section ? `&section=${encodeURIComponent(view.section)}` : "";
  const url = `${origin}/frame/${id}?v=${version}&check=1&t=${encodeURIComponent(token)}${section}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await env.BROWSER.quickAction("snapshot", {
      url,
      formats: ["content", "screenshot"],
      // Whole pages can be very tall: lower quality keeps the image a sensible size (Chrome caps the height).
      screenshotOptions: { type: "jpeg", quality: view?.fullPage ? 45 : 60, ...(view?.fullPage ? { fullPage: true } : {}) },
      waitForSelector: { selector: "#art-check", timeout: 15000 },
      // Browser Run doesn't reliably honour waitForSelector, and the result
      // element appears ~600 ms after first render, so also wait for the network
      // to settle and then a fixed delay.
      gotoOptions: { waitUntil: "networkidle0", timeout: 20000 },
      waitForTimeout: 1500,
      viewport: view?.phone ? PHONE_VIEWPORT : SCREENSHOT_VIEWPORT,
      cacheTTL: 0,
    });
  } catch (err) {
    return { check: { status: "skipped", reason: `browser unavailable: ${(err as Error).message}` } };
  }
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as
    | { success: true; result: { content?: string; screenshot?: string } }
    | { success: false; errors?: { message?: string }[] }
    | null;
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok || !body || !body.success) {
    const reason = (body && !body.success && body.errors?.[0]?.message) || `HTTP ${res.status}`;
    if (/rate limit/i.test(reason)) return { rateLimited: true };
    if (/waiting for selector|timeout/i.test(reason)) {
      return {
        check: {
          status: "errors",
          ms,
          errors: ["The artifact did not finish rendering within 15 s (blank page, a hung promise, or an infinite loop?)."],
        },
      };
    }
    return { check: { status: "skipped", reason: `browser check failed: ${reason}` } };
  }
  const screenshot = body.result.screenshot;
  const html = body.result.content ?? "";
  const raw = /<pre id="art-check"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  let parsed: { status?: string; errors?: string[]; textLength?: number } | null = null;
  try {
    parsed = raw ? JSON.parse(decodeEntities(raw)) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    const shown = html
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    // No result means the page isn't (or is no longer) the artifact, say it navigated away: no screenshot of it.
    return { check: { status: "skipped", reason: `no render result; the page showed: ${shown || "(nothing)"}` } };
  }
  const errors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [];
  if (parsed.status === "error" || errors.length) {
    return { check: { status: "errors", ms, errors: errors.length ? errors : ["The artifact failed to render."] }, screenshot };
  }
  return { check: { status: "ok", ms, textLength: Number(parsed.textLength ?? 0) }, screenshot };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function describeCheck(check: RenderCheck): string {
  switch (check.status) {
    case "ok":
      return check.textLength === 0
        ? "Render check: rendered without errors, but the page shows no text. Make sure the entry renders visible content."
        : "Render check: rendered without errors.";
    case "errors":
      return `Render check FAILED (the version is saved; fix it with artifact_edit):\n${check.errors.map((e) => `- ${e}`).join("\n")}`;
    case "skipped":
      return `Render check skipped (${check.reason}). Run artifact_check later.`;
    case "queued":
      return `Render check queued (the headless browser is rate-limited); call artifact_check in about ${check.inSeconds} s for the result.`;
  }
}
