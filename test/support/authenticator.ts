// A software passkey (WebAuthn platform authenticator) for tests: makes real
// ES256 registrations ("none" attestation) and assertions, so the server's
// checks run exactly as they would against a phone or a password manager.
import { isoCBOR } from "@simplewebauthn/server/helpers";

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

/** WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
}

export async function softAuthenticator(origin: string, aaguid = new Uint8Array(16)) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64u(credentialId);
  let counter = 0;
  let userHandle = "";

  const clientData = (type: string, challenge: string, from = origin) => enc.encode(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }));

  return {
    id,
    /** Answer navigator.credentials.create() for these options. */
    async create(options: { challenge: string; rp: { id: string }; user: { id: string } }, from = origin) {
      userHandle = options.user.id;
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
          [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
        ]),
      );
      const authData = concat(await sha256(enc.encode(options.rp.id)), new Uint8Array([0x45]), u32(counter), aaguid, new Uint8Array([0, credentialId.length]), credentialId, cose);
      const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64u(clientData("webauthn.create", options.challenge, from)), attestationObject: b64u(attestation), transports: ["internal"] },
        clientExtensionResults: {},
      };
    },
    /** Answer navigator.credentials.get() for these options. */
    async get(options: { challenge: string; rpId: string }, from = origin) {
      counter++;
      const authData = concat(await sha256(enc.encode(options.rpId)), new Uint8Array([0x05]), u32(counter));
      const cd = clientData("webauthn.get", options.challenge, from);
      const signed = concat(authData, await sha256(cd));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(der(raw)), userHandle },
        clientExtensionResults: {},
      };
    },
  };
}
