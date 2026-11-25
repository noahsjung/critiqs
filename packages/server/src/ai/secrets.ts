// Provider keys entered in Critiqs are stored only encrypted, with AES-256-GCM
// under a key the deployment's operator supplies (`CRITIQS_AI_ENCRYPTION_KEY`
// on Convex, `ai.encryptionKey` for a server in the host app). Each ciphertext
// is bound to what owns it, a project or a person (`keyBinding`), so it can't
// be copied to another project or person, or between a project and a person.
// Web Crypto runs in Convex's default runtime, Node, and Bun alike.

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

/** An operator's key must carry at least 32 bytes of randomness, written in any form, such as `openssl rand -base64 32`. */
export function validEncryptionKey(key: string | null | undefined): key is string {
  return typeof key === "string" && key.trim().length >= 32;
}

async function derive(operatorKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(operatorKey.trim()), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("critiqs-ai-provider-keys"), info: encoder.encode("v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts a provider key bound to `binding` (see `keyBinding`). Returns base64 ciphertext and IV, and the last four characters as a hint. */
export async function encryptSecret(operatorKey: string, binding: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(binding) },
      await derive(operatorKey),
      encoder.encode(secret),
    ),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv), hint: secret.slice(-4) };
}

/** Decrypts a stored key, or returns null when the operator's key changed, the record was altered, or it is bound to something else. */
export async function decryptSecret(
  operatorKey: string,
  binding: string,
  stored: { ciphertext: string; iv: string },
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(stored.iv), additionalData: encoder.encode(binding) },
      await derive(operatorKey),
      fromBase64(stored.ciphertext),
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
