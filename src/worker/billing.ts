// Billing through Creem, a merchant of record: Creem is the seller, so it
// collects and remits sales tax and VAT everywhere, and we never register for
// them. A workspace pays: checkout starts from its settings, carries the
// workspace slug in metadata, and signed webhooks move it between Team and
// Free. Off unless BILLING=on and the Creem keys are set (docs/BILLING.md).
//
// Everything Creem-specific is in this file (four HTTPS calls and one
// signature check), so another provider means replacing it, not the callers.
import { timingSafeEqual } from "./session.ts";
import type { PlanId } from "./plans.ts";

export type BillingEnv = {
  /** "on" turns billing on; anything else (or unset) leaves it off. */
  BILLING?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  /** The Team plan's product (a monthly subscription) in Creem. */
  CREEM_PRODUCT_ID?: string;
};

/** What Team costs, for the pricing page and settings. Creem's product holds the real price; keep them the same. */
export const TEAM_PRICE = { amount: 25, currency: "USD", period: "month" } as const;

export function billingOn(env: BillingEnv): boolean {
  return env.BILLING === "on";
}

/** Billing is on and has what it needs to take a payment. */
export function billingReady(env: BillingEnv): boolean {
  return billingOn(env) && Boolean(env.CREEM_API_KEY && env.CREEM_WEBHOOK_SECRET && env.CREEM_PRODUCT_ID);
}

export class BillingError extends Error {}

/** Test keys (creem_test_…) talk to Creem's sandbox, so the whole flow can be tried without real money. */
function base(env: BillingEnv): string {
  return env.CREEM_API_KEY?.startsWith("creem_test_") ? "https://test-api.creem.io" : "https://api.creem.io";
}

async function creem<T>(env: BillingEnv, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base(env)}${path}`, {
    method: "POST",
    headers: { "x-api-key": env.CREEM_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`creem ${path} failed`, res.status, (await res.text().catch(() => "")).slice(0, 300));
    throw new BillingError("The payment provider didn't answer. Try again in a minute.");
  }
  return (await res.json()) as T;
}

/** Only ever send someone to Creem itself. */
function creemUrl(u: string | undefined, what: string): string {
  try {
    const url = new URL(u ?? "");
    if (url.protocol === "https:" && (url.hostname === "creem.io" || url.hostname.endsWith(".creem.io"))) return url.href;
  } catch {
    // falls through
  }
  throw new BillingError(`The payment provider didn't return a usable ${what} link.`);
}

/** A Creem checkout for Team for this workspace; returns the URL to send the admin to. */
export async function startCheckout(env: BillingEnv, input: { workspace: string; created?: string | null; email: string; successUrl: string }): Promise<string> {
  if (!billingReady(env)) throw new BillingError("Billing isn't set up yet.");
  const r = await creem<{ checkout_url?: string }>(env, "/v1/checkouts", {
    product_id: env.CREEM_PRODUCT_ID,
    // The same for a minute, so a double click doesn't open two checkouts.
    request_id: `${input.workspace}-${Math.floor(Date.now() / 60_000)}`,
    customer: { email: input.email },
    success_url: input.successUrl,
    // When the workspace was made: if it's deleted and its address reused before the payment lands, the
    // new one isn't mistaken for the payer.
    metadata: { workspace: input.workspace, ...(input.created ? { created: input.created } : {}) },
  });
  return creemUrl(r.checkout_url, "checkout");
}

/** Creem's customer portal for a paying workspace: change card, see invoices, cancel. */
export async function portalLink(env: BillingEnv, customerId: string): Promise<string> {
  if (!billingReady(env)) throw new BillingError("Billing isn't set up yet.");
  const r = await creem<{ customer_portal_link?: string }>(env, "/v1/customers/billing", { customer_id: customerId });
  return creemUrl(r.customer_portal_link, "billing");
}

/** `creem-signature`: hex HMAC-SHA256 of the raw body with the webhook secret. */
export async function verifyWebhook(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, signature.trim().toLowerCase());
}

/**
 * The plan a subscription pays for, and until when. Failed payments (past_due,
 * unpaid, expired) keep Team for two weeks past the period while Creem
 * retries; a canceled or paused one keeps Team until the end of the period
 * already paid for.
 */
export function planFor(status: string, periodEnd: string | null = null, now = Date.now()): { plan: PlanId; until: string | null } {
  if (["active", "trialing", "paid"].includes(status)) return { plan: "team", until: null };
  // A failed payment keeps Team while Creem retries, for at most two weeks past the paid period.
  if (["past_due", "unpaid", "expired"].includes(status)) {
    if (!periodEnd) return { plan: "team", until: null };
    const grace = new Date(Date.parse(periodEnd) + PAYMENT_GRACE_MS).toISOString();
    return Date.parse(grace) > now ? { plan: "team", until: grace } : { plan: "free", until: null };
  }
  // Canceled from Creem's portal means "at the end of the period" (it says so, and sends canceled with the
  // period's end): what's paid for stays Team until then. Same for a scheduled cancel or a pause.
  const paidUntil = periodEnd && Date.parse(periodEnd) > now ? periodEnd : null;
  if (["canceled", "scheduled_cancel", "paused"].includes(status) && paidUntil) return { plan: "team", until: paidUntil };
  return { plan: "free", until: null };
}

/** How long Team outlasts a failed payment's period while Creem retries. */
const PAYMENT_GRACE_MS = 14 * 86_400_000;

/**
 * A subscription that could still charge or be resumed: another checkout would mean paying twice.
 * Not one that's canceled, or lapsed past its grace (that workspace may start a new one).
 */
export function subscriptionLive(status: string, periodEnd: string | null, now = Date.now()): boolean {
  return status !== "canceled" && planFor(status, periodEnd, now).plan === "team";
}

/**
 * Whether deleting the workspace (or its payer's account) would leave a subscription that can still charge:
 * anything but canceled, expired or set to cancel. Paused and unpaid ones count, as they can resume.
 */
export function subscriptionMayCharge(status: string): boolean {
  return !["canceled", "expired", "scheduled_cancel"].includes(status);
}

/** A provider event as it affects one workspace. */
export type BillingUpdate = {
  eventId: string;
  /** The paying customer's email, when the event carries it. */
  payerEmail: string | null;
  /** When the workspace that started the checkout was made (metadata), to tell it from a later one at the same address. */
  workspaceCreated: string | null;
  /** When the provider says it happened (ms), so an older event arriving late can't undo a newer one. */
  at: number;
  workspace: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  status: string;
  periodEnd: string | null;
  /** The plan the workspace should be on now, or null when this event doesn't change it. */
  plan: PlanId | null;
};

type CreemObject = {
  id?: string;
  object?: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
  customer?: string | { id?: string; email?: string } | null;
  subscription?: CreemObject | null;
  current_period_end_date?: string | null;
};

/**
 * Reads a Creem webhook into what it means for a workspace. `plan` is what the
 * event says on its own (paid, active and trialing are Team; canceled and
 * paused aren't), used to decide whether a new subscription takes over; the
 * workspace's plan itself always comes from planFor on the stored record.
 */
export function readEvent(payload: unknown): BillingUpdate | null {
  const e = payload as { id?: string; eventType?: string; created_at?: number; object?: CreemObject } | null;
  // Without an id and a time, repeats and late arrivals couldn't be recognized.
  if (!e?.eventType || !e.object || !e.id || typeof e.created_at !== "number") return null;
  const sub: CreemObject | null = e.eventType === "checkout.completed" ? (e.object.subscription ?? null) : e.object.object === "subscription" ? e.object : null;
  if (!sub) return null;
  const meta = { ...(e.object.metadata ?? {}), ...(sub.metadata ?? {}) };
  const customer = typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
  const customerObject = [sub.customer, e.object.customer].find((c): c is { email?: string } => typeof c === "object" && c !== null);
  const payerEmail = typeof customerObject?.email === "string" ? customerObject.email.toLowerCase() : null;
  const status = sub.status ?? "";
  const ended = status === "canceled" || status === "paused" || e.eventType === "subscription.canceled";
  const plan: PlanId | null = ended ? "free" : ["active", "trialing", "paid"].includes(status) ? "team" : null;
  return {
    eventId: e.id,
    payerEmail,
    at: e.created_at,
    workspace: typeof meta.workspace === "string" ? meta.workspace : null,
    workspaceCreated: typeof meta.created === "string" ? meta.created : null,
    customerId: customer,
    subscriptionId: sub.id ?? null,
    status: e.eventType === "subscription.canceled" ? "canceled" : status,
    periodEnd: sub.current_period_end_date ?? null,
    plan,
  };
}
