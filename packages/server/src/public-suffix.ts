import { PUBLIC_SUFFIX_RULES } from "./public-suffixes.ts";

// Whether a host is a public suffix: a name under which unrelated people get
// their own sites, such as `co.uk` or, from the list's private section,
// `vercel.app` and `github.io`. Address patterns use it so a project can't
// list a whole shared domain. Only names of two or more labels are answered
// (see scripts/update-public-suffixes.ts); every one-label name is one.

/** Each last label's rules, read from the compact form on first use. */
let rules: Map<string, Set<string>> | null = null;

function rulesFor(last: string): Set<string> | undefined {
  if (rules === null) {
    rules = new Map();
    for (const group of PUBLIC_SUFFIX_RULES.split(";")) {
      const [tld, rests] = group.split(":");
      rules.set(tld!, new Set(rests!.split(",")));
    }
  }
  return rules.get(last);
}

/**
 * Whether `host` (lowercase, in its `xn--` form, as the URL parser writes it)
 * is a public suffix, by the list's rules: its own rule, or a wildcard over
 * its parent, unless an exception names it.
 */
export function isPublicSuffix(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2) return true;
  const last = labels.at(-1)!;
  const known = rulesFor(last);
  if (known === undefined) return false;
  const rest = labels.slice(0, -1).join(".");
  if (known.has(`!${rest}`)) return false;
  if (known.has(rest)) return true;
  // A wildcard rule is kept as `*.` and its name without the last label: `*.ck` as `*.`, `*.compute.amazonaws.com` as `*.compute.amazonaws`.
  const parent = labels.slice(1, -1).join(".");
  return known.has(parent === "" ? "*." : `*.${parent}`);
}
