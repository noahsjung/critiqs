/**
 * The inbox an address reaches, so its other spellings share one limit and
 * one opt-out: without a `+tag`, and for Gmail without dots. Case and
 * surrounding spaces are ignored. The server counts limits and suppressions
 * by it, and the website matches addresses with it the same way.
 */
export function inboxOf(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).split("+")[0]!;
  const domain = address.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com" ? `${local.replaceAll(".", "")}@gmail.com` : `${local}@${domain}`;
}
