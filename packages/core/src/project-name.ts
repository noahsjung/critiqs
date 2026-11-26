/**
 * Project names. Lists, menus, emails, and lookups across many projects read
 * every name they show, so a name's size must stay small.
 */

/**
 * Longest project name, in UTF-16 code units as a browser's `maxlength`
 * counts them. It matches the onboarding name field and fits the names
 * onboarding suggests.
 */
export const MAX_PROJECT_NAME_LENGTH = 200;

/** Code units the shortened name keeps from the start of the original. */
const KEPT = MAX_PROJECT_NAME_LENGTH - 13;

/**
 * A name longer than the limit, made to fit: its start, cut between
 * characters, then "… " and 11 letters and digits computed from the whole
 * name, so two long names sharing their start stay different, and a shortened
 * name never equals a name someone typed or `critiqs init` suggested that
 * fits. `critiqs init` shortens a long suggested name the same way (its copy
 * in `packages/react/bin/env.mjs` is tested against this one), so it finds a
 * project shortened by the backfill again. Names that fit are unchanged.
 */
export function shortenProjectName(name: string): string {
  if (name.length <= MAX_PROJECT_NAME_LENGTH) return name;
  let end = KEPT;
  const last = name.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${name.slice(0, end).trimEnd()}… ${nameHash(name)}`;
}

/** cyrb53, a fast 53-bit string hash, as 11 base-36 characters. Not for security. */
function nameHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}
