import type { TrackerId } from "@critiqs/core";
import type { StoredToken } from "../store.ts";

// Provider keys and tracker tokens entered in Critiqs are stored only
// encrypted, with AES-256-GCM under a key the deployment's operator supplies
// (`CRITIQS_AI_ENCRYPTION_KEY` on Convex, `ai.encryptionKey` for a server in
// the host app). Provider keys and tracker tokens each derive their own AES key
// from it, so one can't be read as the other. Each ciphertext is bound to what
// owns it: a project or a person (`keyBinding`) for a provider key, a person
// and tracker (`trackerTokenBinding`) for a tracker token, so it can't be
// copied to another owner. Web Crypto runs in Convex's default runtime, Node,
// and Bun alike.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** What a stored key is bound to: `project:<id>` for a project's key, `user:<id>` for a person's own key. */
export function keyBinding(source: "project" | "personal", ownerId: string): string {
  return source === "project" ? `project:${ownerId}` : `user:${ownerId}`;
}

/** What a stored tracker token is bound to: the person who connected it and the tracker it is for. */
export function trackerTokenBinding(tracker: TrackerId, userId: string): string {
  return `tracker:${tracker}:user:${userId}`;
}

/** An operator's key must carry at least 32 bytes of randomness, written in any form, such as `openssl rand -base64 32`. */
export function validEncryptionKey(key: string | null | undefined): key is string {
  return typeof key === "string" && key.trim().length >= 32;
}

/** What a derived AES key protects: provider keys, or tracker tokens. */
type Purpose = "critiqs-ai-provider-keys" | "critiqs-tracker-tokens";

async function derive(operatorKey: string, purpose: Purpose): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(operatorKey.trim()), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(purpose), info: encoder.encode("v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts a provider key bound to `binding` (see `keyBinding`). Returns base64 ciphertext and IV, and the last four characters as a hint. */
export async function encryptSecret(operatorKey: string, binding: string, secret: string) {
  return { ...(await encrypt(operatorKey, "critiqs-ai-provider-keys", binding, secret)), hint: secret.slice(-4) };
}

/** Decrypts a stored key, or returns null when the operator's key changed, the record was altered, or it is bound to something else. */
export async function decryptSecret(operatorKey: string, binding: string, stored: { ciphertext: string; iv: string }): Promise<string | null> {
  return await decrypt(operatorKey, "critiqs-ai-provider-keys", binding, stored);
}

/** Encrypts a tracker token bound to `binding` (see `trackerTokenBinding`). Returns base64 ciphertext and IV, with no hint. */
export async function encryptToken(operatorKey: string, binding: string, token: string): Promise<StoredToken> {
  return await encrypt(operatorKey, "critiqs-tracker-tokens", binding, token);
}

/** Decrypts a stored tracker token, or returns null when the operator's key changed, the record was altered, or it is bound to another person or tracker. */
export async function decryptToken(operatorKey: string, binding: string, stored: StoredToken): Promise<string | null> {
  return await decrypt(operatorKey, "critiqs-tracker-tokens", binding, stored);
}

async function encrypt(operatorKey: string, purpose: Purpose, binding: string, plain: string): Promise<StoredToken> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(binding) }, await derive(operatorKey, purpose), encoder.encode(plain)),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

async function decrypt(operatorKey: string, purpose: Purpose, binding: string, stored: StoredToken): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(stored.iv), additionalData: encoder.encode(binding) },
      await derive(operatorKey, purpose),
      fromBase64(stored.ciphertext),
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
