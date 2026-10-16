// Creates a demo report artifact and prints short-lived login links for QA.
import { signToken } from "../src/worker/session.ts";
const origin = process.argv[2];
async function call(name: string, args: unknown) {
  const res = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return ((await res.json()) as any).result;
}
const mdx = `---
title: GitHub alternatives
---
<Summary>Forgejo wins for self-hosting; GitLab if CI matters most.</Summary>

## Shortlist
<Table data="repos.json" columns="name price selfHost ci" sort="price" search />

| Criterion | Weight |
|---|---|
| Self-hosting | High |
| CI | Medium |

## Decide
<Poll id="pick" options={["Forgejo", "GitLab", "Gitea"]} />
<Checklist id="next" items={["Trial Forgejo on Boris", "Price GitLab Premium"]} allowAdd />

## Notes
<Notes id="notes" placeholder="Shared notes" />

<Comments />
`;
const repos = [
  { name: "Forgejo", price: 0, selfHost: true, ci: "Actions-compatible", url: "https://forgejo.org" },
  { name: "GitLab", price: 29, selfHost: true, ci: "Excellent" },
  { name: "Gitea", price: 0, selfHost: true, ci: "Actions-compatible" },
  { name: "GitHub", price: 4, selfHost: false, ci: "Excellent" },
];
const r = await call("artifact_create", {
  title: "GitHub alternatives (demo)",
  description: "Demo report for QA",
  files: { "index.mdx": mdx, "data/repos.json": JSON.stringify(repos, null, 2) },
  share: [{ email: "qa-editor@example.com", role: "edit" }, { email: "qa-viewer@example.com", role: "view" }],
});
if (r.isError) throw new Error(r.content[0].text);
const id = r.structuredContent.id;
const link = async (email: string) =>
  `${origin}/auth/callback?code=${encodeURIComponent(await signToken(process.env.LOGIN_SECRET!, "login", 3600, { e: email, aud: origin }))}&next=${encodeURIComponent(`/a/${id}`)}`;
console.log(JSON.stringify({ id, url: `${origin}/a/${id}`, owner: await link(process.env.OWNER_EMAILS!.split(",")[0]), editor: await link("qa-editor@example.com"), viewer: await link("qa-viewer@example.com") }, null, 1));
