// Billing end to end against a deployed stage with BILLING=on, in a throwaway
// workspace: sends signed webhook events the way Creem does and checks the
// workspace moves between Free and Team. With real Creem test keys
// (CREEM_API_KEY=creem_test_…) it also creates a sandbox checkout.
// Usage: CREEM_WEBHOOK_SECRET=<the stage's secret> STAGE=<name> bun spikes/e2e-billing.ts
import { apex, check, cookieFor, finish, operator, origin, owner, setup, slug } from "./e2e-lib.ts";

const secret = process.env.CREEM_WEBHOOK_SECRET;
if (!secret) throw new Error("set CREEM_WEBHOOK_SECRET to the deployed stage's webhook secret");
await setup();
await operator(`/workspaces/${slug}/plan`, { plan: "free" });

async function sign(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function send(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${apex}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "creem-signature": signature ?? (await sign(body)) }, body });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const cookie = await cookieFor(owner);
const settings = async () => (await (await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } })).json()) as any;
const subId = `sub_e2e_${slug}`;
const sub = (status: string, metadata: Record<string, unknown> = {}) => ({ id: subId, object: "subscription", customer: { id: `cust_${slug}` }, status, current_period_end_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), metadata });
let t = Date.now();
const ev = (eventType: string, object: unknown) => ({ id: `evt_${slug}_${++t}`, eventType, created_at: t, object });

const pricing = await fetch(`${apex}/pricing`);
check("pricing page is up", pricing.status === 200 && (await pricing.text()).includes("merchant of record"), pricing.status);
const before = await settings();
check("starts on Free, with billing in settings", before.plan?.id === "free" && before.billing !== null, { plan: before.plan?.id, billing: before.billing });

check("a bad signature is refused", (await send(ev("subscription.paid", sub("active", { workspace: slug })), "00")).status === 401);
const paid = ev("checkout.completed", { id: "ch_e2e", object: "checkout", status: "completed", metadata: { workspace: slug }, subscription: { ...sub("active", { workspace: slug }), customer: `cust_${slug}` } });
const first = await send(paid);
check("checkout.completed moves it to Team", first.status === 200 && first.body?.plan === "team" && (await settings()).plan.id === "team", first);
const again = await send(paid);
check("the same delivery again changes nothing", again.body?.plan === "team" && (await settings()).plan.id === "team", again);
// A late event from before the payment can't undo it.
const late = { ...ev("subscription.canceled", sub("canceled")), created_at: t - 3_600_000 };
await send(late);
check("an older event arriving late changes nothing", (await settings()).plan.id === "team");
const after = await settings();
check("settings shows a manageable subscription", after.billing?.subscription?.manageable === true && after.billing?.subscription?.status === "active", after.billing);
await send(ev("subscription.past_due", sub("past_due")));
check("a failed payment keeps Team while it's retried", (await settings()).plan.id === "team");
const canceled = await send(ev("subscription.canceled", sub("canceled")));
const midPeriod = await settings();
check("canceling keeps Team until the paid period ends", canceled.body?.plan === "team" && midPeriod.plan.id === "team" && Boolean(midPeriod.plan.until), { canceled: canceled.body, plan: midPeriod.plan });
await send(ev("subscription.canceled", { ...sub("canceled"), current_period_end_date: new Date(Date.now() - 1000).toISOString() }));
check("once the period is over, it's Free", (await settings()).plan.id === "free");

// A real sandbox checkout, when the stage has Creem test keys.
const checkout = await fetch(`${origin}/api/settings/billing/checkout`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
const out = (await checkout.json().catch(() => null)) as any;
if (before.billing?.ready) check("a sandbox checkout link comes back from Creem", checkout.status === 200 && /^https:\/\//.test(out?.url ?? ""), out);
else check("without keys, checkout says payments aren't set up", checkout.status === 503, out);
await finish();
