// Print a fresh VAPID key pair for Web Push (RFC 8292).
//   bun scripts/vapid.ts
// VAPID_PUBLIC_KEY is the 65-byte uncompressed P-256 point, VAPID_PRIVATE_KEY the
// 32-byte scalar d, both base64url without padding.

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;

console.log(`VAPID_PUBLIC_KEY=${b64u(publicRaw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
