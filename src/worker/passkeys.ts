// Passkeys (WebAuthn): sign in without an emailed code. They belong to the apex,
// where everyone signs in, so the relying party is APEX_HOST and workspaces get
// the same hand-off as after a code. Challenges are stateless signed tokens, so
// showing the sign-in page costs no storage; the directory spends each one when
// it's used, so a captured response can't sign in twice.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { PRODUCT } from "../shared/brand.ts";
import type { DirectoryApi } from "./directory.ts";
import { b64url, fromB64url, signToken, verifyToken } from "./session.ts";

type PasskeyEnv = { APEX_HOST: string; LOGIN_SECRET: string };

/** How long someone has to answer the passkey prompt. */
const CHALLENGE_TTL = 5 * 60;

export class PasskeyError extends Error {}

function origin(env: PasskeyEnv): string {
  return `https://${env.APEX_HOST}`;
}

/** The WebAuthn user handle: stable per person, and not their email (authenticators may show or sync it). */
async function userHandle(env: PasskeyEnv, email: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.LOGIN_SECRET}\npasskey-user\n${email}`));
  return new Uint8Array(digest);
}

/** Options for a sign-in prompt (the browser offers any passkey saved for this site). */
export async function signInOptions(env: PasskeyEnv): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; token: string }> {
  const options = await generateAuthenticationOptions({ rpID: env.APEX_HOST, userVerification: "required", timeout: CHALLENGE_TTL * 1000 });
  return { options, token: await signToken(env.LOGIN_SECRET, "passkey", CHALLENGE_TTL, { c: options.challenge, u: "get" }) };
}

/** Check a sign-in response; returns who signed in. */
export async function verifySignIn(env: PasskeyEnv, dir: DirectoryApi, token: string, response: AuthenticationResponseJSON): Promise<string> {
  const claims = await verifyToken<{ c: string; u: string }>(env.LOGIN_SECRET, "passkey", token);
  if (!claims || claims.u !== "get") throw new PasskeyError("The passkey prompt expired. Try again.");
  // Credential ids are at most 1023 bytes; anything else isn't worth a directory lookup.
  const plausible = typeof response?.id === "string" && /^[A-Za-z0-9_-]{16,1400}$/.test(response.id);
  const stored = plausible ? await dir.passkey(response.id) : null;
  if (!stored) throw new PasskeyError("That passkey isn't saved on this site anymore. Sign in with your email, then add it again from your account.");
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claims.c,
      expectedOrigin: origin(env),
      expectedRPID: env.APEX_HOST,
      credential: { id: stored.id, publicKey: fromB64url(stored.publicKey), counter: stored.counter, transports: stored.transports as never },
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("That passkey couldn't be checked. Try again, or sign in with your email.");
  }
  if (!verified.verified) throw new PasskeyError("That passkey couldn't be checked. Try again, or sign in with your email.");
  const email = await dir.usePasskey(stored.id, verified.authenticationInfo.newCounter, claims.c, claims.exp * 1000);
  if (!email) throw new PasskeyError("The passkey prompt expired. Try again.");
  return email;
}

/** Options for saving a new passkey for someone signed in. */
export async function registrationOptions(
  env: PasskeyEnv,
  dir: DirectoryApi,
  email: string,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; token: string }> {
  const existing = await dir.passkeys(email);
  const options = await generateRegistrationOptions({
    rpName: PRODUCT,
    rpID: env.APEX_HOST,
    userName: email,
    userDisplayName: email,
    userID: await userHandle(env, email),
    attestationType: "none",
    // A device that already holds one of yours says so instead of saving a duplicate.
    excludeCredentials: existing.map((p) => ({ id: p.id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: CHALLENGE_TTL * 1000,
  });
  return { options, token: await signToken(env.LOGIN_SECRET, "passkey", CHALLENGE_TTL, { c: options.challenge, u: "create", e: email }) };
}

/** Check and save a new passkey. `userAgent` names it when the authenticator isn't a known one. */
export async function verifyRegistration(env: PasskeyEnv, dir: DirectoryApi, email: string, token: string, response: RegistrationResponseJSON, userAgent: string) {
  const claims = await verifyToken<{ c: string; u: string; e: string }>(env.LOGIN_SECRET, "passkey", token);
  if (!claims || claims.u !== "create" || claims.e !== email) throw new PasskeyError("The passkey prompt expired. Try again.");
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: claims.c,
      expectedOrigin: origin(env),
      expectedRPID: env.APEX_HOST,
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("That passkey couldn't be saved. Try again.");
  }
  if (!verified.verified) throw new PasskeyError("That passkey couldn't be saved. Try again.");
  const { credential, aaguid } = verified.registrationInfo;
  return dir.addPasskey(
    email,
    { id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [] },
    passkeyName(aaguid, userAgent),
  );
}

/** Password managers that keep passkeys, by the AAGUID they register with. */
const PROVIDERS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

/** A name people recognise in their account: the password manager, or else the device and browser. */
export function passkeyName(aaguid: string, userAgent: string): string {
  const provider = PROVIDERS[aaguid.toLowerCase()];
  if (provider) return provider;
  const ua = userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  if (device && browser) return `${browser} on ${device}`;
  return device ?? browser ?? "Passkey";
}
