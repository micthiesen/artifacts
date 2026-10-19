// Billing through Creem: off by default; checkout and portal calls; signed
// webhooks moving a workspace between Team and Free, safely under repeats
// and out-of-order delivery. Payload shapes follow Creem's webhook docs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeKV, type Harness } from "./support/do-harness.ts";
import { planFor, readEvent, subscriptionLive, verifyWebhook } from "../src/worker/billing.ts";

const { default: worker } = await import("../src/worker/index.ts");

let h: Harness;
let env: Record<string, unknown>;
let calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let creemAnswer: (url: string) => Response = () => Response.json({});
const realFetch = globalThis.fetch;
const APEX = "https://artifacts.test";
const ACME = "https://acme.artifacts.test";
const MEMBER = "member@example.com";
const SECRET = "whsec_test_creem_secret";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const KEYS = { BILLING: "on", CREEM_API_KEY: "creem_test_abc", CREEM_WEBHOOK_SECRET: SECRET, CREEM_PRODUCT_ID: "prod_team" };

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MEMBER, "member", ADMIN);
  await h.hub.setPlan("free");
  calls = [];
  creemAnswer = () => Response.json({});
  env = {
    ...h.env,
    WORKSPACE: { getByName: (slug: string) => (slug === "acme" ? h.hub : null) },
    OAUTH_KV: new FakeKV(),
    EMAIL: { send: async () => {} },
    CONSENT_SECRET: "test-consent-secret-that-is-long-enough",
    OPERATOR_TOKEN: "op-token",
    OPERATOR_EMAILS: "op@corp.com",
    APEX_HOST: "artifacts.test",
    WORKSPACE_SUFFIX: ".artifacts.test",
    MAIL_FROM: "sign-in@mail.artifacts.test",
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    return creemAnswer(u);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function send(path: string, init: RequestInit & { as?: string; host?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.as) {
    const res = await worker.fetch(
      new Request(`${APEX}/api/admin/session`, { method: "POST", headers: { Authorization: "Bearer op-token", "Content-Type": "application/json" }, body: JSON.stringify({ email: init.as, host: new URL(init.host ?? ACME).hostname }) }),
      env as never,
      ctx,
    );
    headers.set("Cookie", ((await res.json()) as { cookie: string }).cookie);
    headers.set("Origin", init.host ?? ACME);
  }
  return worker.fetch(new Request(`${init.host ?? ACME}${path}`, { ...init, headers }), env as never, ctx);
}

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function webhook(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return send("/api/billing/webhook", { host: APEX, method: "POST", body, headers: { "creem-signature": signature ?? (await sign(body)), "Content-Type": "application/json" } });
}

const sub = (status: string, metadata: Record<string, unknown> = { workspace: "acme" }) => ({
  id: "sub_1",
  object: "subscription",
  product: { id: "prod_team", status: "active" },
  customer: { id: "cust_1", email: "admin@example.com" },
  status,
  current_period_end_date: "2026-11-18T00:00:00.000Z",
  metadata,
});
let n = 0;
const event = (eventType: string, object: unknown, created_at = 1_800_000_000_000 + ++n * 1000) => ({ id: `evt_${n}_${eventType}`, eventType, created_at, object });
const checkoutCompleted = () =>
  event("checkout.completed", {
    id: "ch_1",
    object: "checkout",
    request_id: "acme-1",
    status: "completed",
    metadata: { workspace: "acme" },
    customer: { id: "cust_1" },
    subscription: { ...sub("active"), customer: "cust_1" },
  });

test("signatures are hex HMAC-SHA256 of the raw body", async () => {
  const body = '{"a":1}';
  expect(await verifyWebhook(SECRET, body, await sign(body))).toBe(true);
  expect(await verifyWebhook(SECRET, body, (await sign(body)).toUpperCase())).toBe(true);
  expect(await verifyWebhook(SECRET, '{"a":2}', await sign(body))).toBe(false);
  expect(await verifyWebhook(SECRET, body, null)).toBe(false);
});

test("events map to plans: paid and active are Team, canceled and paused are Free, failed payments keep Team", () => {
  expect(readEvent(checkoutCompleted())).toMatchObject({ workspace: "acme", customerId: "cust_1", subscriptionId: "sub_1", plan: "team" });
  expect(readEvent(event("subscription.paid", sub("active")))?.plan).toBe("team");
  expect(readEvent(event("subscription.trialing", sub("trialing")))?.plan).toBe("team");
  expect(readEvent(event("subscription.scheduled_cancel", sub("scheduled_cancel")))).toMatchObject({ plan: null, status: "scheduled_cancel" });
  for (const s of ["past_due", "unpaid"]) expect(readEvent(event(`subscription.${s}`, sub(s)))?.plan).toBeNull();
  expect(readEvent(event("subscription.expired", sub("active")))?.plan).toBe("team");
  expect(readEvent(event("subscription.canceled", sub("canceled")))?.plan).toBe("free");
  expect(readEvent(event("subscription.paused", sub("paused")))?.plan).toBe("free");
  expect(readEvent(event("refund.created", { id: "ref_1", object: "refund" }))).toBeNull();
  expect(readEvent({ nonsense: true })).toBeNull();
  // Without an id and a time it can't be ordered or de-duplicated.
  expect(readEvent({ eventType: "subscription.paid", object: sub("active") })).toBeNull();
});

test("off by default: no pricing page, no webhook, nothing in settings", async () => {
  expect((await send("/pricing", { host: APEX })).status).toBe(404);
  expect((await webhook(checkoutCompleted())).status).toBe(404);
  const settings = (await (await send("/api/settings", { as: ADMIN })).json()) as { billing: unknown };
  expect(settings.billing).toBeNull();
  expect((await (await send("/", { host: APEX })).text())).not.toContain('href="/pricing"');
});

test("on without keys: the pricing page shows, but nobody can check out yet", async () => {
  env.BILLING = "on";
  const pricing = await send("/pricing", { host: APEX });
  expect(pricing.status).toBe(200);
  const html = await pricing.text();
  expect(html).toContain("$25");
  expect(html).toContain("merchant of record");
  expect(await (await send("/", { host: APEX })).text()).toContain('href="/pricing"');
  const settings = (await (await send("/api/settings", { as: ADMIN })).json()) as { billing: { ready: boolean } };
  expect(settings.billing.ready).toBe(false);
  const checkout = await send("/api/settings/billing/checkout", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect(checkout.status).toBe(503);
  expect(calls).toEqual([]);
});

test("checkout: admins only; Creem gets the product, the admin's email and the workspace; test keys use the sandbox", async () => {
  Object.assign(env, KEYS);
  creemAnswer = () => Response.json({ id: "ch_1", checkout_url: "https://checkout.creem.io/ch_1" });
  const post = (as: string) => send("/api/settings/billing/checkout", { as, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect((await post(MEMBER)).status).toBe(403);
  const r = await post(ADMIN);
  expect(await r.json()).toEqual({ url: "https://checkout.creem.io/ch_1" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://test-api.creem.io/v1/checkouts");
  expect(calls[0].headers["x-api-key"]).toBe("creem_test_abc");
  expect(calls[0].body).toMatchObject({ product_id: "prod_team", customer: { email: ADMIN }, success_url: `${ACME}/settings?billing=done`, metadata: { workspace: "acme" } });
  // Live keys use the live API; a provider error is a clean 503.
  env.CREEM_API_KEY = "creem_live_xyz";
  creemAnswer = () => new Response("down", { status: 500 });
  const failed = await post(ADMIN);
  expect(failed.status).toBe(503);
  expect(calls.at(-1)!.url).toBe("https://api.creem.io/v1/checkouts");
});

test("webhooks move the workspace between plans, and repeats or late events change nothing", async () => {
  Object.assign(env, KEYS);
  expect(h.hub.plan().id).toBe("free");
  // Wrong signature: refused, nothing changes.
  expect((await webhook(checkoutCompleted(), "deadbeef")).status).toBe(401);
  expect(h.hub.plan().id).toBe("free");

  const paid = checkoutCompleted();
  expect(await (await webhook(paid)).json()).toEqual({ ok: true, workspace: "acme", plan: "team" });
  expect(h.hub.plan().id).toBe("team");
  expect(h.directory.billing("acme")).toMatchObject({ provider: "creem", customerId: "cust_1", subscriptionId: "sub_1", status: "active" });
  // The same delivery again changes nothing: it re-applies what the record says.
  expect(await (await webhook(paid)).json()).toEqual({ ok: true, workspace: "acme", plan: "team" });

  // Later events find the workspace by subscription even without metadata.
  const scheduled = event("subscription.scheduled_cancel", sub("scheduled_cancel", {}));
  await webhook(scheduled);
  expect(h.hub.plan().id).toBe("team");
  expect(h.directory.billing("acme")?.status).toBe("scheduled_cancel");
  const settings = (await (await send("/api/settings", { as: ADMIN })).json()) as { billing: { subscription: { status: string; manageable: boolean } } };
  expect(settings.billing.subscription).toMatchObject({ status: "scheduled_cancel", manageable: true });

  // An older event arriving late can't undo a newer one. (Canceled with its period over: Free now.)
  const canceled = event("subscription.canceled", { ...sub("canceled", {}), current_period_end_date: "2020-01-01T00:00:00.000Z" });
  const stale = event("subscription.paid", sub("active", {}), 1_000);
  await webhook(canceled);
  expect(h.hub.plan().id).toBe("free");
  await webhook(stale);
  expect(h.hub.plan().id).toBe("free");

  // Events for a workspace we don't know are acknowledged and ignored.
  const elsewhere = event("subscription.paid", { ...sub("active", { workspace: "nope" }), id: "sub_other" });
  expect(await (await webhook(elsewhere)).json()).toMatchObject({ ignored: true });
});

test("the portal link is for workspaces with a subscription, from Creem", async () => {
  Object.assign(env, KEYS);
  const portal = () => send("/api/settings/billing/portal", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect((await portal()).status).toBe(400);
  await webhook(checkoutCompleted());
  creemAnswer = () => Response.json({ customer_portal_link: "https://creem.io/portal/cust_1" });
  expect(await (await portal()).json()).toEqual({ url: "https://creem.io/portal/cust_1" });
  expect(calls.at(-1)).toMatchObject({ url: "https://test-api.creem.io/v1/customers/billing", body: { customer_id: "cust_1" } });
  // Already on Team: no second checkout.
  const again = await send("/api/settings/billing/checkout", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect(again.status).toBe(400);
});

test("a retry heals a plan change that failed the first time", async () => {
  Object.assign(env, KEYS);
  const real = h.hub.setPlan.bind(h.hub);
  let fail = true;
  h.hub.setPlan = (async (plan: never) => {
    if (fail) throw new Error("hub overloaded");
    return real(plan);
  }) as never;
  const paid = checkoutCompleted();
  // A 500 (with an error code), which Creem retries.
  expect((await webhook(paid)).status).toBe(500);
  expect(h.hub.plan().id).toBe("free");
  fail = false;
  // Creem delivers the same event again.
  await webhook(paid);
  expect(h.hub.plan().id).toBe("team");
});

test("an old subscription's late events can't downgrade a newer one; a new paying one takes over", async () => {
  Object.assign(env, KEYS);
  await webhook(checkoutCompleted());
  const second = { ...sub("active"), id: "sub_2", customer: { id: "cust_1" } };
  await webhook(event("subscription.paid", second));
  expect(h.directory.billing("acme")?.subscriptionId).toBe("sub_2");
  // sub_1 is canceled afterwards: the workspace pays through sub_2, so it stays Team.
  await webhook(event("subscription.canceled", sub("canceled")));
  expect(h.hub.plan().id).toBe("team");
  expect(h.directory.billing("acme")).toMatchObject({ subscriptionId: "sub_2", status: "active" });
});

test("an operator-set Team isn't touched by events for a subscription it never had", async () => {
  Object.assign(env, KEYS);
  await h.hub.setPlan("team");
  expect(await (await webhook(event("subscription.canceled", sub("canceled")))).json()).toEqual({ ok: true, ignored: true });
  expect(h.hub.plan().id).toBe("team");
});

test("a paying workspace can't be deleted by accident, and a deleted one's subscription isn't inherited", async () => {
  Object.assign(env, KEYS);
  await webhook(checkoutCompleted());
  const del = () => worker.fetch(new Request(`${APEX}/api/admin/workspaces/acme`, { method: "DELETE", headers: { Authorization: "Bearer op-token" } }), env as never, ctx);
  expect((await del()).status).toBe(409);
  // (The forced HTTP delete also tears the workspace object down, which this harness can't; the record goes either way.)
  await h.directory.removeWorkspace("acme");
  expect(h.directory.billing("acme")).toBeNull();
});

test("canceling keeps Team until the paid period ends, then it lapses to Free by itself", async () => {
  Object.assign(env, KEYS);
  await webhook(checkoutCompleted());
  const end = new Date(Date.now() + 20 * 86_400_000).toISOString();
  // What Creem's portal sends: canceled, with the period's end still ahead.
  const r = await (await webhook(event("subscription.canceled", { ...sub("canceled", {}), current_period_end_date: end }))).json();
  expect(r).toEqual({ ok: true, workspace: "acme", plan: "team", until: end });
  expect(h.hub.plan()).toMatchObject({ id: "team", until: end });
  // When the period is over, the plan reads as Free without anything else happening.
  const realNow = Date.now;
  Date.now = () => Date.parse(end) + 1000;
  try {
    expect(h.hub.plan().id).toBe("free");
  } finally {
    Date.now = realNow;
  }
  // Resubscribing clears the end.
  await webhook(event("subscription.active", sub("active", {})));
  expect(h.hub.plan()).toMatchObject({ id: "team", until: null });
});

test("a failed payment keeps Team for two weeks past the period; a pause until the period ends", () => {
  const end = "2026-11-18T00:00:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  expect(planFor("past_due", end, at("2026-11-20T00:00:00.000Z"))).toEqual({ plan: "team", until: "2026-12-02T00:00:00.000Z" });
  expect(planFor("unpaid", end, at("2026-12-03T00:00:00.000Z"))).toEqual({ plan: "free", until: null });
  expect(planFor("paused", end, at("2026-11-01T00:00:00.000Z"))).toEqual({ plan: "team", until: end });
  expect(planFor("paused", end, at("2026-11-19T00:00:00.000Z"))).toEqual({ plan: "free", until: null });
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  expect(subscriptionLive("past_due", soon) && subscriptionLive("paused", soon) && !subscriptionLive("canceled", soon)).toBe(true);
  expect(subscriptionLive("expired", "2020-01-01T00:00:00.000Z")).toBe(false);
});

test("no second checkout while a subscription can still charge; a lapsed one can be replaced", async () => {
  Object.assign(env, KEYS);
  const checkout = () => send("/api/settings/billing/checkout", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  await webhook(checkoutCompleted());
  // Paused with time left: still Team, so no checkout.
  await webhook(event("subscription.paused", { ...sub("paused"), current_period_end_date: new Date(Date.now() + 5 * 86_400_000).toISOString() }));
  expect((await checkout()).status).toBe(400);
  // Overdue well past the grace: Free, and a fresh subscription may start.
  await webhook(event("subscription.past_due", { ...sub("past_due"), current_period_end_date: "2020-01-01T00:00:00.000Z" }));
  expect(h.hub.plan().id).toBe("free");
  creemAnswer = () => Response.json({ checkout_url: "https://checkout.creem.io/ch_2" });
  expect((await checkout()).status).toBe(200);
  // The new subscription pays, and takes over.
  await webhook(event("subscription.active", { ...sub("active"), id: "sub_2" }));
  expect(h.hub.plan().id).toBe("team");
});

test("if the plan drifted from a subscription that can still charge, checkout heals it instead of doubling up", async () => {
  Object.assign(env, KEYS);
  await webhook(checkoutCompleted());
  // Directory says paused with time left, but the workspace somehow reads Free: the server heals it instead of a checkout.
  await webhook(event("subscription.paused", { ...sub("paused"), current_period_end_date: new Date(Date.now() + 5 * 86_400_000).toISOString() }));
  await h.hub.setPlan("free");
  const r = await send("/api/settings/billing/checkout", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect(r.status).toBe(409);
  expect(h.hub.plan().id).toBe("team");
});

test("only the person who paid opens the billing portal; settings says who that is", async () => {
  Object.assign(env, KEYS);
  await h.hub.setMember("payer@example.com", "admin", ADMIN);
  await webhook(event("subscription.active", { ...sub("active"), customer: { id: "cust_1", email: "Payer@Example.com" } }));
  expect(h.directory.billing("acme")?.payerEmail).toBe("payer@example.com");
  // A later event without the email keeps it.
  await webhook(event("subscription.paid", { ...sub("active"), customer: "cust_1" }));
  expect(h.directory.billing("acme")?.payerEmail).toBe("payer@example.com");
  creemAnswer = () => Response.json({ customer_portal_link: "https://creem.io/portal/cust_1" });
  const portal = await send("/api/settings/billing/portal", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  expect(portal.status).toBe(403);
  expect(((await portal.json()) as { error: string }).error).toContain("payer@example.com");
  const settings = (await (await send("/api/settings", { as: ADMIN })).json()) as { billing: { subscription: { payer: string } } };
  expect(settings.billing.subscription.payer).toBe("payer@example.com");
  expect((await send("/api/settings/billing/portal", { as: "payer@example.com", method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(200);
  // Removing the payer doesn't hand their billing to whoever removed them.
  await h.hub.setMember("payer@example.com", null, ADMIN);
  expect((await send("/api/settings/billing/portal", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(403);
});

test("whoever made a self-serve workspace can delete it, once nothing is billed, and then make another", async () => {
  Object.assign(env, KEYS);
  const del = (confirm: string, as = ADMIN) => send("/api/settings/delete", { as, method: "POST", body: JSON.stringify({ confirm }), headers: { "Content-Type": "application/json" } });
  // Made by the operator: nobody deletes it from settings.
  expect(((await (await send("/api/settings", { as: ADMIN })).json()) as { canDelete: boolean }).canDelete).toBe(false);
  expect((await del("acme")).status).toBe(403);
  h.directory.ctx.storage.sql.exec(`UPDATE workspaces SET created_by = ? WHERE slug = 'acme'`, ADMIN);
  expect(h.directory.canMakeWorkspace(ADMIN)).toBe(false);
  expect(((await (await send("/api/settings", { as: ADMIN })).json()) as { canDelete: boolean }).canDelete).toBe(true);
  expect((await del("acme", MEMBER)).status).toBe(403);
  expect((await del("acm")).status).toBe(400);
  await webhook(checkoutCompleted());
  expect((await del("acme")).status).toBe(409);
  await webhook(event("subscription.canceled", { ...sub("canceled"), current_period_end_date: "2020-01-01T00:00:00.000Z" }));
  const r = await del("acme");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ location: `${APEX}/workspaces?deleted=Acme` });
  expect(h.directory.workspace("acme")).toBeNull();
  // The operator-made workspace wasn't in the self-serve log, so there's room for one.
  expect(h.directory.canMakeWorkspace(ADMIN)).toBe(true);
});

test("the operator hears when a workspace subscribes, cancels or fails a payment, once per change", async () => {
  Object.assign(env, KEYS);
  const sent: { to: string; subject: string }[] = [];
  env.EMAIL = { send: async (m: { to: string; subject: string }) => void sent.push(m) };
  const paid = checkoutCompleted();
  await webhook(paid);
  await webhook(paid);
  await webhook(event("subscription.paid", sub("active")));
  await webhook(event("subscription.past_due", sub("past_due")));
  await webhook(event("subscription.canceled", sub("canceled")));
  expect(sent.map((m) => m.subject.replace(/ \(billed to .*$|\. Plan now.*$/, ""))).toEqual([
    "[artifacts.boo] acme subscribed to Team",
    "[artifacts.boo] acme has a failed payment (Team kept while Creem retries)",
    "[artifacts.boo] acme canceled Team",
  ]);
  expect(sent.every((m) => m.to === "op@corp.com")).toBe(true);
});

test("canceled with paid time left: subscribing again is allowed, and the new subscription takes over", async () => {
  Object.assign(env, KEYS);
  await webhook(checkoutCompleted());
  await webhook(event("subscription.canceled", { ...sub("canceled"), current_period_end_date: new Date(Date.now() + 10 * 86_400_000).toISOString() }));
  expect(h.hub.plan().id).toBe("team");
  creemAnswer = () => Response.json({ checkout_url: "https://checkout.creem.io/ch_3" });
  expect((await send("/api/settings/billing/checkout", { as: ADMIN, method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(200);
  await webhook(event("subscription.active", { ...sub("active"), id: "sub_9" }));
  expect(h.hub.plan()).toMatchObject({ id: "team", until: null });
  expect(h.directory.billing("acme")?.subscriptionId).toBe("sub_9");
});

test("webhook trouble lands in the ops log, and Resync plan puts a drifted plan right", async () => {
  Object.assign(env, KEYS);
  await webhook({ id: "evt_x", eventType: "subscription.active", created_at: 1, object: sub("active") }, "bad");
  expect(h.directory.opsEvents({ kind: "billing_bad_signature" })).toHaveLength(1);
  // Unreadable (no created_at): its subscription can't be ordered, so nothing changes, but the operator hears.
  await webhook({ id: "evt_y", eventType: "subscription.active", object: sub("active") });
  expect(h.directory.opsEvents({ kind: "billing_event_unread" })).toHaveLength(1);
  await webhook(checkoutCompleted());
  await h.hub.setPlan("free");
  const resync = await worker.fetch(new Request(`${APEX}/api/admin/workspaces/acme/resync`, { method: "POST", headers: { Authorization: "Bearer op-token" } }), env as never, ctx);
  expect(await resync.json()).toEqual({ plan: "team", until: null });
  expect(h.hub.plan().id).toBe("team");
});
