import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

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
      const auth = yield* Cloudflare.Worker("Auth", {
        name: authName,
        main: "./build/auth/index.js",
        bundle: false,
        compatibility: { date: "2026-10-01" },
        access: {
          // Anyone can prove an email with a one-time PIN; the main Worker's
          // per-artifact share list decides what they can open.
          policies: [{ decision: "allow", include: ["everyone"] }],
        },
        env: {
          LOGIN_SECRET: yield* Config.Redacted("LOGIN_SECRET"),
          ACCESS_TEAM_DOMAIN: accessTeam,
          ACCESS_AUD: yield* Config.String("ACCESS_AUD"),
          MAIN_ORIGIN: mainOrigin,
        },
      });
      authUrl = `https://${authName}.${subdomain}.workers.dev`;
      void auth;
    }

    const worker = yield* Cloudflare.Worker("Artifacts", {
      name,
      main: "./build/worker/index.js",
      bundle: false,
      compatibility: { date: "2026-10-01" },
      assets: "./dist/kit",
      env: {
        HUB: Cloudflare.DurableObject("ArtifactHub"),
        SESSION_SECRET: yield* Config.Redacted("SESSION_SECRET"),
        LOGIN_SECRET: yield* Config.Redacted("LOGIN_SECRET"),
        MCP_TOKEN: yield* Config.Redacted("MCP_TOKEN"),
        OWNER_EMAILS: yield* Config.String("OWNER_EMAILS"),
        AUTH_URL: authUrl,
      },
    });

    return { url: worker.url, mcp: `${mainOrigin}/mcp`, auth: authUrl || "not configured" };
  }),
);
