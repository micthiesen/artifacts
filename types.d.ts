declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
// alchemy.run.ts runs under Bun; the Worker's types don't include Node's.
declare module "node:crypto" {
  export function createECDH(curve: string): {
    setPrivateKey(key: Uint8Array): void;
    getPublicKey(): { toString(encoding: "base64url"): string };
    getPrivateKey(): { toString(encoding: "base64url"): string };
  };
}
declare const Buffer: { from(data: string, encoding: "hex"): Uint8Array };
