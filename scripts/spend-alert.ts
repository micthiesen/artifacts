// Creates (once) the Cloudflare notification that emails the operator when the month's spend passes a budget:
// the early warning for runaway costs, such as abuse of the free plan. Alchemy's typed API can't express this
// alert's filter, so it's made here. Usage: bun scripts/spend-alert.ts [dollars=20]. Reads the Cloudflare API token
// from Alchemy's profile and OPERATOR_EMAILS from .env.
const dollars = process.argv[2] ?? "20";
const profile = JSON.parse(await Bun.file(`${process.env.HOME}/.alchemy/profiles/default/cloudflare.json`).text()).values as { apiToken: string; accountId: string };
const operator = (process.env.OPERATOR_EMAILS ?? "").split(",")[0].trim();
if (!operator) throw new Error("set OPERATOR_EMAILS in .env");
const api = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}/alerting/v3/policies`;
const headers = { Authorization: `Bearer ${profile.apiToken}`, "Content-Type": "application/json" };
const name = "artifacts: monthly spend over budget";
const existing = ((await (await fetch(api, { headers })).json()) as { result: { id: string; name: string }[] }).result.find((p) => p.name === name);
const body = JSON.stringify({ name, alert_type: "billing_budget_alert", enabled: true, filters: { total_spend_dollars: [dollars] }, mechanisms: { email: [{ id: operator }] } });
const res = await fetch(existing ? `${api}/${existing.id}` : api, { method: existing ? "PUT" : "POST", headers, body });
const out = (await res.json()) as { success: boolean; errors: unknown[] };
console.log(out.success ? `${existing ? "updated" : "created"}: email ${operator} when the month's spend passes $${dollars}` : JSON.stringify(out.errors));
