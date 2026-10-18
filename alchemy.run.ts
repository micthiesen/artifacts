import { createECDH } from "node:crypto";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// Everything this deployment needs, created and kept in sync by Alchemy:
// the Worker and its Durable Objects, DNS for every workspace subdomain, the
// sign-in email sender, OAuth storage, backups and generated secrets. The
// deployer's .env names the domain, who operates it and the operator token
// local scripts use (docs/DEPLOY.md).
export default Alchemy.Stack(
  "artifacts",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const prod = stage === "prod";
    const name = prod ? "artifacts" : `artifacts-${stage}`;
    const domain = yield* Config.String("DOMAIN");
    const optional = (key: string) => Config.String(key).pipe(Config.withDefault(""));
    const operators = yield* Config.String("OPERATOR_EMAILS");

    // The apex is the front door; workspaces live one label below it, so the
    // zone's Universal SSL certificate (*.domain) covers them: <slug>.domain in
    // prod, <slug>--<stage>.domain for other stages.
    const apexHost = prod ? domain : `${stage}.${domain}`;
    const workspaceSuffix = prod ? `.${domain}` : `--${stage}.${domain}`;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: domain }).pipe(Effect.orDie);
    if (!zone) return yield* Effect.die(new Error(`no zone ${domain} in this account`));
    if (prod) {
      // Proxied wildcard so every workspace subdomain reaches the Worker route.
      yield* Cloudflare.DNS.Record("WorkspacesDns", { zoneId: zone.id, name: `*.${domain}`, type: "AAAA", content: "100::", proxied: true, ttl: 1 });
    }

    const mailHost = prod ? `mail.${domain}` : `mail-${stage}.${domain}`;
    yield* Cloudflare.Email.SendingSubdomain("Mail", { zoneId: zone.id, name: mailHost });
    const mailFrom = `sign-in@${mailHost}`;

    const secret = (id: string) => Alchemy.Random(id).pipe(Effect.map((r) => r.text));
    // Web Push keys: a P-256 key pair derived from a generated seed, so it stays
    // stable across deploys (changing it would invalidate every subscription).
    const vapidSeed = yield* secret("VapidSeed");
    const vapid = (part: "public" | "private") =>
      Output.map(vapidSeed, (seed: Redacted.Redacted<string>) => {
        const ecdh = createECDH("prime256v1");
        ecdh.setPrivateKey(Buffer.from(Redacted.value(seed), "hex"));
        return (part === "public" ? ecdh.getPublicKey() : ecdh.getPrivateKey()).toString("base64url");
      });
    const pushoverToken = yield* optional("PUSHOVER_TOKEN");

    const worker = yield* Cloudflare.Worker("Artifacts", {
      name,
      main: "./build/worker/index.js",
      bundle: false,
      // Client ID Metadata Documents (OAuth) fetch only public addresses.
      compatibility: { date: "2026-10-01", flags: ["global_fetch_strictly_public"] },
      assets: "./dist/kit",
      domain: { name: apexHost, aliases: prod ? [`www.${domain}`] : [] },
      workersDev: false,
      // Prod's wildcard route also matches a stage's apex (<stage>.domain) and
      // outranks its custom domain, so stages route their apex explicitly.
      routes: [{ pattern: `*${workspaceSuffix}/*`, zoneId: zone.id }, ...(prod ? [] : [{ pattern: `${apexHost}/*`, zoneId: zone.id }])],
      // Workers Logs, so sign-in and email failures can be looked up afterwards.
      observability: { enabled: true },
      env: {
        WORKSPACE: Cloudflare.DurableObject("Workspace"),
        DIRECTORY: Cloudflare.DurableObject("Directory"),
        OAUTH_KV: yield* Cloudflare.KV.Namespace("OAuth"),
        BACKUPS: yield* Cloudflare.R2.Bucket("Backups"),
        EMAIL: yield* Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [mailFrom] }),
        BROWSER: Cloudflare.Browser(),
        SESSION_SECRET: yield* secret("SessionSecret"),
        LOGIN_SECRET: yield* secret("LoginSecret"),
        CONSENT_SECRET: yield* secret("ConsentSecret"),
        // Local operator scripts (export, import, e2e) read it from .env too.
        OPERATOR_TOKEN: yield* Config.Redacted("OPERATOR_TOKEN"),
        OPERATOR_EMAILS: operators,
        APEX_HOST: apexHost,
        APEX_ORIGIN: `https://${apexHost}`,
        WORKSPACE_SUFFIX: workspaceSuffix,
        MAIL_FROM: mailFrom,
        VAPID_PUBLIC_KEY: vapid("public"),
        VAPID_PRIVATE_KEY: Output.map(vapid("private"), Redacted.make),
        VAPID_SUBJECT: `mailto:${operators.split(",")[0].trim()}`,
        ...(pushoverToken ? { PUSHOVER_TOKEN: Redacted.make(pushoverToken) } : {}),
      },
    });

    return { url: worker.url, apex: `https://${apexHost}`, workspaces: `https://<slug>${workspaceSuffix}`, mail: mailFrom };
  }),
);
