import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// Secrets and owner emails come from the deployer's environment (see
// docs/DEPLOY.md); nothing account-specific is committed.
export default Alchemy.Stack(
  "artifacts",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const name = stage === "prod" ? "artifacts" : `artifacts-${stage}`;
    const subdomain = yield* Config.String("WORKERS_SUBDOMAIN");
    const mainOrigin = `https://${name}.${subdomain}.workers.dev`;
    const accessTeam = yield* Config.String("ACCESS_TEAM_DOMAIN").pipe(Config.withDefault(""));

    let authUrl = "";
    if (accessTeam) {
      const authName = `${name}-auth`;
      const authHost = `${authName}.${subdomain}.workers.dev`;
      const otp = Cloudflare.Access.getIdentityProvider({ type: "onetimepin" });
      // Anyone can prove an email with a one-time PIN; the main Worker's
      // per-artifact share list decides what they can open.
      const signIn = yield* Cloudflare.Access.Application("SignIn", {
        type: "self_hosted",
        name: stage === "prod" ? "Shared Artifacts sign-in" : `Shared Artifacts sign-in (${stage})`,
        policies: [{ decision: "allow", include: ["everyone"] }],
        allowedIdps: [otp.identityProviderId as unknown as string],
        autoRedirectToIdentity: true,
        sessionDuration: "24h",
      });
      yield* Cloudflare.Worker("Auth", {
        name: authName,
        main: "./build/auth/index.js",
        bundle: false,
        compatibility: { date: "2026-10-01" },
        access: signIn,
        env: {
          LOGIN_SECRET: yield* Config.Redacted("LOGIN_SECRET"),
          ACCESS_TEAM_DOMAIN: accessTeam,
          ACCESS_AUD: signIn.aud,
          MAIN_ORIGIN: mainOrigin,
        },
      });
      authUrl = `https://${authHost}`;
    }

    // Nightly offsite backups need R2 permission on the deploy token; opt in with R2_BACKUPS=1.
    const r2Backups = (yield* Config.String("R2_BACKUPS").pipe(Config.withDefault(""))) === "1";
    const backups: Record<string, Cloudflare.R2.Bucket> = r2Backups ? { BACKUPS: yield* Cloudflare.R2.Bucket("Backups") } : {};

    // Notifications: Web Push keys (`bun scripts/vapid.ts`) and one Pushover
    // application token shared by every user's Pushover channel. All optional.
    const optional = (key: string) => Config.String(key).pipe(Config.withDefault(""));
    const vapidPublic = yield* optional("VAPID_PUBLIC_KEY");
    const vapidPrivate = yield* optional("VAPID_PRIVATE_KEY");
    const pushoverToken = yield* optional("PUSHOVER_TOKEN");
    const ownerEmails = yield* Config.String("OWNER_EMAILS");
    const notify: Record<string, string | Redacted.Redacted<string>> = {
      ...(vapidPublic && vapidPrivate
        ? {
            VAPID_PUBLIC_KEY: vapidPublic,
            VAPID_PRIVATE_KEY: Redacted.make(vapidPrivate),
            VAPID_SUBJECT: (yield* optional("VAPID_SUBJECT")) || `mailto:${ownerEmails.split(",")[0].trim()}`,
          }
        : {}),
      ...(pushoverToken ? { PUSHOVER_TOKEN: Redacted.make(pushoverToken) } : {}),
    };

    const worker = yield* Cloudflare.Worker("Artifacts", {
      name,
      main: "./build/worker/index.js",
      bundle: false,
      compatibility: { date: "2026-10-01" },
      assets: "./dist/kit",
      // Live data sources refresh on this schedule (each source has its own interval).
      crons: ["*/15 * * * *"],
      env: {
        HUB: Cloudflare.DurableObject("ArtifactHub"),
        ...backups,
        SESSION_SECRET: yield* Config.Redacted("SESSION_SECRET"),
        LOGIN_SECRET: yield* Config.Redacted("LOGIN_SECRET"),
        MCP_TOKEN: yield* Config.Redacted("MCP_TOKEN"),
        BROWSER: Cloudflare.Browser(),
        OWNER_EMAILS: ownerEmails,
        AUTH_URL: authUrl,
        ...notify,
      },
    });

    return { url: worker.url, mcp: `${mainOrigin}/mcp`, auth: authUrl || "not configured" };
  }),
);
