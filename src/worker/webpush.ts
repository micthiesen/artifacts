// Web Push sending on WebCrypto only:
// - RFC 8291 message encryption with the RFC 8188 "aes128gcm" content coding
// - RFC 8292 VAPID (ES256 JWT + "vapid" Authorization scheme)

export type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
export type VapidEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
export type SendWebPushOptions = {
  /** Seconds the push service may hold the message. Default 86400. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Collapse key; must already be <= 32 base64url characters. */
  topic?: string;
  signal?: AbortSignal;
};

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

// The DOM and Workers typings disagree on BufferSource generics; every
// Uint8Array we pass is backed by a plain ArrayBuffer.
const buf = (u: Uint8Array) => u as unknown as ArrayBuffer;

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error("invalid base64url");
  const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function assertPoint(raw: Uint8Array, what: string) {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error(`${what} must be a 65-byte uncompressed P-256 point`);
}

/**
 * Import a P-256 private key from its 32-byte scalar `d` plus the matching
 * 65-byte uncompressed public point (WebCrypto has no raw private import).
 */
export async function importP256PrivateKey(
  publicRaw: Uint8Array,
  d: Uint8Array,
  alg: "ECDH" | "ECDSA",
): Promise<CryptoKey> {
  assertPoint(publicRaw, "public key");
  if (d.length !== 32) throw new Error("private key must be 32 bytes");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(publicRaw.slice(1, 33)),
    y: b64uEncode(publicRaw.slice(33, 65)),
    d: b64uEncode(d),
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: alg, namedCurve: "P-256" },
    false,
    alg === "ECDH" ? ["deriveBits"] : ["sign"],
  );
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt one push message (RFC 8291) as a single aes128gcm record (RFC 8188).
 * Returns header (salt, rs=4096, keyid=as_public) followed by the ciphertext.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dhB64u: string,
  authB64u: string,
  opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dhB64u);
  assertPoint(uaPublic, "p256dh");
  const authSecret = b64uDecode(authB64u);
  if (authSecret.length < 16) throw new Error("auth secret must be 16 bytes");
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload too large");

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  const serverKeys =
    opts.serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as never, serverKeys.privateKey, 256),
  );

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single, final record: plaintext followed by the 0x02 delimiter, no padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: 128 }, aesKey, buf(record)),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** RFC 8292 `Authorization: vapid t=<jwt>, k=<public key>` for one push endpoint. */
export async function vapidAuthorization(
  endpoint: string,
  publicKeyB64u: string,
  privateKeyB64u: string,
  subject: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const publicRaw = b64uDecode(publicKeyB64u);
  const key = await importP256PrivateKey(publicRaw, b64uDecode(privateKeyB64u), "ECDSA");
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA emits IEEE P1363 (raw r||s, 64 bytes), which is what JOSE wants.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(enc.encode(signingInput))),
  );
  return `vapid t=${signingInput}.${b64uEncode(sig)}, k=${b64uEncode(publicRaw)}`;
}

/** Encrypt and POST one message to a push subscription. Returns the push service's response. */
export async function sendWebPush(
  sub: PushSubscriptionJSON,
  payload: Uint8Array | string,
  env: VapidEnv,
  opts: SendWebPushOptions = {},
): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys are not configured");
  const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
  const body = await encryptPayload(bytes, sub.keys.p256dh, sub.keys.auth);
  const headers: Record<string, string> = {
    TTL: String(opts.ttl ?? 86400),
    Urgency: opts.urgency ?? "normal",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: await vapidAuthorization(
      sub.endpoint,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT || "mailto:admin@example.com",
    ),
  };
  if (opts.topic) headers.Topic = opts.topic;
  return fetch(sub.endpoint, { method: "POST", headers, body: buf(body), signal: opts.signal });
}
