import { expect, test } from "bun:test";
import {
  b64uDecode,
  b64uEncode,
  concat,
  encryptPayload,
  importP256PrivateKey,
  vapidAuthorization,
} from "../src/worker/webpush.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const join = (...parts: string[]) => parts.join("");

// RFC 8291 section 5 / appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: join("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx", "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: join("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg", "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: join(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ),
};

async function ecdhPairFrom(publicB64u: string, privateB64u: string): Promise<CryptoKeyPair> {
  const publicRaw = b64uDecode(publicB64u);
  return {
    publicKey: await crypto.subtle.importKey("raw", publicRaw, { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await importP256PrivateKey(publicRaw, b64uDecode(privateB64u), "ECDH"),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, n * 8));
}

/** Receiver side of RFC 8291, independent of the code under test. */
async function decryptPayload(body: Uint8Array, ua: CryptoKeyPair, authSecret: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(0x02); // last-record delimiter
  return padded.slice(0, end);
}

test("base64url round-trips", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(67));
  expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes);
  expect(() => b64uDecode("a")).toThrow();
});

test("RFC 8291 section 5 vector encrypts byte-for-byte", async () => {
  const serverKeys = await ecdhPairFrom(RFC.asPublic, RFC.asPrivate);
  const out = await encryptPayload(enc.encode(RFC.plaintext), RFC.uaPublic, RFC.authSecret, {
    salt: b64uDecode(RFC.salt),
    serverKeys,
  });
  expect(out.length).toBe(144); // 86-byte header + 41 + 1 + 16 (the RFC says Content-Length: 145, but its body is 144 bytes)
  expect(b64uEncode(out)).toBe(RFC.body);
});

test("RFC 8291 vector decrypts with the receiver key", async () => {
  const ua = await ecdhPairFrom(RFC.uaPublic, RFC.uaPrivate);
  const plain = await decryptPayload(b64uDecode(RFC.body), ua, b64uDecode(RFC.authSecret));
  expect(dec.decode(plain)).toBe(RFC.plaintext);
});

test("encrypt/decrypt round trip with fresh keys", async () => {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaPublic = b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const text = JSON.stringify({ title: "Héllo ✓", body: "x".repeat(2000), url: "https://example.com/a/1" });
  const a = await encryptPayload(enc.encode(text), uaPublic, b64uEncode(auth));
  const b = await encryptPayload(enc.encode(text), uaPublic, b64uEncode(auth));
  expect(b64uEncode(a)).not.toBe(b64uEncode(b)); // fresh salt + ephemeral key each time
  expect(dec.decode(await decryptPayload(a, ua, auth))).toBe(text);
});

test("encryptPayload rejects bad receiver keys", async () => {
  await expect(encryptPayload(enc.encode("x"), b64uEncode(new Uint8Array(33)), RFC.authSecret)).rejects.toThrow();
});

test("VAPID authorization: JWT shape and ES256 signature", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const d = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!;
  const pub = b64uEncode(publicRaw);
  const now = 1_700_000_000;

  const header = await vapidAuthorization(
    "https://fcm.googleapis.com/fcm/send/abc:def",
    pub,
    d,
    "mailto:me@example.com",
    now,
  );
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(m).not.toBeNull();
  const [, jwt, k] = m!;
  expect(k).toBe(pub);
  const [h, c, s] = jwt!.split(".");
  expect(JSON.parse(dec.decode(b64uDecode(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
  expect(JSON.parse(dec.decode(b64uDecode(c!)))).toEqual({
    aud: "https://fcm.googleapis.com",
    exp: now + 12 * 3600,
    sub: "mailto:me@example.com",
  });
  const sig = b64uDecode(s!);
  expect(sig.length).toBe(64); // JOSE raw r||s, not DER
  const verifyKey = await crypto.subtle.importKey("raw", publicRaw, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    sig,
    enc.encode(`${h}.${c}`),
  );
  expect(ok).toBe(true);
});
