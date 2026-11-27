import { expect, test } from "bun:test";
import { decryptSecret, decryptToken, encryptSecret, encryptToken, keyBinding, trackerTokenBinding } from "../src/ai/secrets.ts";

const KEY = "operator-encryption-key-".padEnd(48, "x");
const OTHER_KEY = "another-operator-key-".padEnd(48, "y");

test("a tracker token decrypts only for the person and tracker it was stored for", async () => {
  const stored = await encryptToken(KEY, trackerTokenBinding("linear", "dana"), "lin_api_secret");
  expect(Object.keys(stored).sort()).toEqual(["ciphertext", "iv"]);
  expect(stored.ciphertext).not.toContain("lin_api_secret");
  expect(await decryptToken(KEY, trackerTokenBinding("linear", "dana"), stored)).toBe("lin_api_secret");
  expect(await decryptToken(KEY, trackerTokenBinding("linear", "lee"), stored)).toBeNull();
  expect(await decryptToken(KEY, trackerTokenBinding("github", "dana"), stored)).toBeNull();
  expect(await decryptToken(OTHER_KEY, trackerTokenBinding("linear", "dana"), stored)).toBeNull();
});

test("a tracker token can't be read as an AI provider key, nor a provider key as a tracker token", async () => {
  const token = await encryptToken(KEY, trackerTokenBinding("jira", "dana"), "jira-token");
  // Even under the same binding text, each derives its own key.
  expect(await decryptSecret(KEY, trackerTokenBinding("jira", "dana"), token)).toBeNull();
  expect(await decryptSecret(KEY, keyBinding("personal", "dana"), token)).toBeNull();
  const key = await encryptSecret(KEY, keyBinding("personal", "dana"), "sk-person-5678");
  expect(await decryptToken(KEY, keyBinding("personal", "dana"), key)).toBeNull();
  expect(await decryptToken(KEY, trackerTokenBinding("jira", "dana"), key)).toBeNull();
});

test("AI provider keys stored before tracker tokens existed still decrypt", async () => {
  // Encrypted by the code before tracker tokens, with KEY and keyBinding("personal", "abc").
  const stored = { ciphertext: "Q0azZfCdzXy1Xuh8kAZdHO1UJB9cMoxczI/1xg8c", iv: "Z41T44Z4ANia8rTf" };
  expect(await decryptSecret(KEY, keyBinding("personal", "abc"), stored)).toBe("sk-person-5678");
});
