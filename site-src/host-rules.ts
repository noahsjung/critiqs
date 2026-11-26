// How site/vercel.json's rules apply to a request path, as the host applies
// them: the first rewrite whose source matches, and the headers of every rule
// whose source matches. preview-site.ts serves with this, and the website
// app's tests check the review pages' headers with it.
//
// It covers only what site/vercel.json uses: `:name` segments, `(.*)`, and a
// `((?!a/|b/).*)` group, which matches what doesn't start with those.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface HostConfig {
  cleanUrls?: boolean;
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

/** The host file the landing site and the website app are served with. */
export function readHostConfig(site = join(import.meta.dir, "..", "site")): HostConfig {
  return JSON.parse(readFileSync(join(site, "vercel.json"), "utf8")) as HostConfig;
}

/** A source pattern as the host reads it: `:name` is one segment, `(.*)` anything, `((?!…).*)` anything not starting so. */
export function sourcePattern(source: string): RegExp {
  const body = source
    .split(/(\(\(\?![^()]*\)\.\*\)|\(\.\*\)|:[A-Za-z]+)/)
    .map((part) => (part === "(.*)" || part.startsWith("((?!") ? part : part.startsWith(":") ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** Where the first matching rewrite sends `path`, or null. */
export function rewriteFor(config: HostConfig, path: string): string | null {
  return (config.rewrites ?? []).find((rule) => sourcePattern(rule.source).test(path))?.destination ?? null;
}

/** Each header the host sends for `path`, with the source of every rule that sets it, in order. */
export function headerRules(config: HostConfig, path: string): Map<string, { value: string; sources: string[] }> {
  const sent = new Map<string, { value: string; sources: string[] }>();
  for (const rule of config.headers ?? []) {
    if (!sourcePattern(rule.source).test(path)) continue;
    for (const { key, value } of rule.headers) {
      const name = key.toLowerCase();
      sent.set(name, { value, sources: [...(sent.get(name)?.sources ?? []), rule.source] });
    }
  }
  return sent;
}
