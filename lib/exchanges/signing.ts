import crypto from "node:crypto";

export function signEd25519Base64(secret: string, message: string) {
  const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
  const seed = raw.subarray(0, 32);
  if (seed.length !== 32) throw new Error("NOBITEX_API_SECRET must be a 32-byte base64url Ed25519 seed");
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(message), key).toString("base64");
}

