// Sign-in Worker. Cloudflare Access sits in front of this Worker and verifies
// the viewer's email with a one-time PIN. This Worker checks the Access JWT and
// hands the main Worker a short-lived signed code naming that email.
import { fromB64url, signToken } from "../worker/session.ts";

export type AuthEnv = {
  LOGIN_SECRET: string;
  /** e.g. https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience (AUD) tag. */
  ACCESS_AUD: string;
  /** Origin of the main Worker, e.g. https://artifacts.<sub>.workers.dev */
  MAIN_ORIGIN: string;
};

export default {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    const target = url.searchParams.get("return");
    if (!target) return new Response("missing return", { status: 400 });
    let returnUrl: URL;
    try {
      returnUrl = new URL(target);
    } catch {
      return new Response("bad return", { status: 400 });
    }
    if (returnUrl.origin !== env.MAIN_ORIGIN || returnUrl.pathname !== "/auth/callback") {
      return new Response("bad return", { status: 400 });
    }
    const email = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), env);
    if (!email) return new Response("Access identity missing or invalid", { status: 403 });
    const code = await signToken(env.LOGIN_SECRET, "login", 60, { e: email, aud: env.MAIN_ORIGIN });
    returnUrl.searchParams.set("code", code);
    return Response.redirect(returnUrl.href, 302);
  },
};

type Jwk = JsonWebKey & { kid: string };
let jwks: { keys: Jwk[]; at: number } | null = null;

async function keys(env: AuthEnv, refresh = false): Promise<Jwk[]> {
  if (!jwks || refresh || Date.now() - jwks.at > 3600_000) {
    const res = await fetch(`${env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
    jwks = { keys: ((await res.json()) as { keys: Jwk[] }).keys, at: Date.now() };
  }
  return jwks.keys;
}

export async function verifyAccessJwt(token: string | null, env: AuthEnv): Promise<string | null> {
  if (!token) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const dec = new TextDecoder();
  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(dec.decode(fromB64url(h)));
    payload = JSON.parse(dec.decode(fromB64url(p)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let jwk = (await keys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const now = Date.now() / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")) return null;
  if (!payload.exp || payload.exp < now || (payload.nbf && payload.nbf > now + 60)) return null;
  return payload.email ? payload.email.toLowerCase() : null;
}
