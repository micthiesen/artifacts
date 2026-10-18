// Phone-width layout check (390 px) of every page against a deployed Worker,
// in a throwaway workspace: fails on anything that sticks out sideways.
// Usage: bun spikes/e2e-layout.ts   (reads DOMAIN and OPERATOR_TOKEN from .env; STAGE=<name> for a stage)
import { apex, call, check, cookieFor, finish, operator, origin, owner, setup, slug } from "./e2e-lib.ts";

await setup();
const guest = `guest-${slug}@example.com`;
const long = "A deliberately long title that keeps going to see whether it wraps on a phone screen";
const files = {
  "index.mdx": `# ${long}\n\n<Summary>Wide things below.</Summary>\n\n<Approval id="go" title="${long}" approvers={["${guest}"]} />\n\n<Form id="f" fields={[{ name: "team", label: "Team", type: "select", options: ["${long}"] }]} />\n`,
};
const created = await call("artifact_create", { title: long, description: long, files, share: [{ email: guest, role: "edit" }], notify: false });
const id = created.structuredContent?.id as string;
check("artifact for the layout check", Boolean(id), created);

const host = new URL(apex).hostname;
const ownerApex = await cookieFor(owner, host);
const ownerHere = await cookieFor(owner);
const guestHere = await cookieFor(guest);
const pages: [string, string, string | undefined][] = [
  ["splash", `${apex}/`, undefined],
  ["sign-in", `${apex}/login`, undefined],
  ["privacy", `${apex}/privacy`, undefined],
  ["terms", `${apex}/terms`, undefined],
  ["security", `${apex}/security`, undefined],
  ["your workspaces", `${apex}/workspaces`, ownerApex],
  ["account", `${apex}/me`, ownerApex],
  ["artifact list", `${origin}/`, ownerHere],
  ["archived list", `${origin}/archived`, ownerHere],
  ["workspace settings", `${origin}/settings`, ownerHere],
  ["workspace notifications", `${origin}/me`, ownerHere],
  ["artifact (owner)", `${origin}/a/${id}`, ownerHere],
  ["artifact (guest)", `${origin}/a/${id}`, guestHere],
];
for (const [name, url, cookie] of pages) {
  const r = await operator("/layout", { url, ...(cookie ? { cookie } : {}) });
  const detail = r.error ?? `${r.scrollWidth}px wide at ${r.width}px: ${r.offenders?.map((o: any) => `${o.el} → ${o.right}px “${o.text}”`).join("; ")}`;
  check(`no sideways overflow: ${name}`, r.ok === true, detail);
  if (r.screenshot) {
    const file = `/tmp/layout-${name.replace(/\W+/g, "-")}.jpg`;
    await Bun.write(file, Buffer.from(r.screenshot, "base64"));
    console.log(`  screenshot: ${file}`);
  }
}
await finish();
