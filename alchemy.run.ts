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

    // support@<domain> forwards to the first operator (prod only): the address the site gives for help.
    // Cloudflare emails that operator once to confirm the forwarding destination; until it's confirmed (and
    // the next deploy sees that), the site keeps giving the operator's own address.
    // SUPPORT_ROUTING: unset, off; "address" registers the destination (Cloudflare emails the operator to confirm
    // it); "on" also adds the forwarding rule, which Cloudflare refuses until the address is confirmed. Email Routing
    // itself is switched on once in the dashboard, which also replaces the apex's "no mail" records (docs/DEPLOY.md).
    let supportEmail: Output.Output<string> | undefined;
    const supportRouting = yield* optional("SUPPORT_ROUTING");
    if (prod && (supportRouting === "address" || supportRouting === "on")) {
      const operator = operators.split(",")[0].trim();
      const inbox = yield* Cloudflare.Email.Address("SupportInbox", { email: operator });
      if (supportRouting === "on") {
        yield* Cloudflare.Email.Rule("SupportForward", {
          zone: zone.id,
          name: "support",
          matchers: [{ type: "literal", field: "to", value: `support@${domain}` }],
          actions: [{ type: "forward", value: [operator] }],
        });
        supportEmail = Output.map(inbox.verified, (verified: boolean) => (verified ? `support@${domain}` : ""));
      }

    }

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
    // "on" opens self-serve workspace signup; off unless set in .env.
    const selfServe = yield* optional("SELF_SERVE");
    // Billing (docs/BILLING.md): off unless BILLING=on, with the Creem keys.
    const billing = yield* optional("BILLING");
    const creemKey = yield* optional("CREEM_API_KEY");
    const creemSecret = yield* optional("CREEM_WEBHOOK_SECRET");
    const creemProduct = yield* optional("CREEM_PRODUCT_ID");

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
        ...(supportEmail ? { SUPPORT_EMAIL: supportEmail } : {}),
        APEX_HOST: apexHost,
        APEX_ORIGIN: `https://${apexHost}`,
        WORKSPACE_SUFFIX: workspaceSuffix,
        MAIL_FROM: mailFrom,
        VAPID_PUBLIC_KEY: vapid("public"),
        VAPID_PRIVATE_KEY: Output.map(vapid("private"), Redacted.make),
        VAPID_SUBJECT: `mailto:${operators.split(",")[0].trim()}`,
        ...(pushoverToken ? { PUSHOVER_TOKEN: Redacted.make(pushoverToken) } : {}),
        ...(selfServe ? { SELF_SERVE: selfServe } : {}),
        ...(billing ? { BILLING: billing } : {}),
        ...(creemKey ? { CREEM_API_KEY: Redacted.make(creemKey) } : {}),
        ...(creemSecret ? { CREEM_WEBHOOK_SECRET: Redacted.make(creemSecret) } : {}),
        ...(creemProduct ? { CREEM_PRODUCT_ID: creemProduct } : {}),
      },
    });

    return { url: worker.url, apex: `https://${apexHost}`, workspaces: `https://<slug>${workspaceSuffix}`, mail: mailFrom };
  }),
);
