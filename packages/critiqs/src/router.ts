// The shared convention framework packages use to report routes and show
// them again. A route's pattern is the screen, so every user's details page
// is one screen (`users/:id`), and its parameters are view state
// (`route.id`), so a thread left on one record's page names that record and
// its page can be built again.
import type { HostContext, RestoreRequest } from "../../react/src/host.ts";

/** A route parameter as routers give it: text, a typed value, or a repeated parameter's segments. */
export type RouteParam = string | number | boolean | readonly (string | number)[] | null | undefined;

/** View state keys that hold route parameters start with this. */
export const ROUTE_PARAM_PREFIX = "route.";

/**
 * Context for a route: `pattern` in `:name` form, such as `/users/:id` (convert
 * `[id]` or `:id()` first), and the route's decoded parameters. A repeated
 * parameter (`:path*`, `:path+`) is stored as its segments joined with `/`,
 * each segment's own `%` escaped as `%25` and, given as an array, its own `/`
 * as `%2F`; given as one string, its `/` separate segments. Other parameters
 * are stored as they are. The root route is the screen `/`.
 */
export function routeContext(pattern: string, params: Record<string, RouteParam>): Required<Pick<HostContext, "screen" | "viewState">> {
  const trimmed = pattern.replace(/^\/+|\/+$/g, "");
  const repeated = new Set([...trimmed.matchAll(/(?:^|\/):([\w-]+)[*+](?=\/|$)/g)].map((match) => match[1]));
  const viewState: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // Escaped the same way whether a router gives an array or a string, so routePath reads both back alike.
    const key = `${ROUTE_PARAM_PREFIX}${name}`;
    if (Array.isArray(value)) viewState[key] = value.map((part) => escapeSegment(String(part))).join("/");
    else {
      // Routers with typed matchers (SvelteKit's `[id=integer]`) can give numbers.
      const text = String(value);
      viewState[key] = repeated.has(name) ? text.split("/").map(escapeSegment).join("/") : text;
    }
  }
  return { screen: trimmed === "" ? "/" : trimmed, viewState };
}

/**
 * The path a thread's route was on, built from its screen and route
 * parameters, such as `/users/42`; null when the screen isn't a route
 * pattern or a required parameter is missing or empty. Only repeated
 * parameters (`:path*`, `:path+`) span several segments; every other value is
 * one encoded segment. Pass it to the router's navigate. Thread context comes
 * from other reviewers, so the result is always a path on this site.
 */
export function routePath(request: Pick<RestoreRequest, "screen" | "viewState">): string | null {
  if (request.screen === "/") return "/";
  if (request.screen.startsWith("/") || request.screen === "") return null;
  const segments: string[] = [];
  for (const segment of request.screen.split("/")) {
    const match = /^:([\w-]+)([*+?]?)$/.exec(segment);
    if (match === null) {
      // Browsers drop tabs and newlines from URLs, so "\t/evil.com" would leave the site; ? and # would change the query.
      if (segment === "" || /[\x00-\x1f\x7f\\?#]/.test(segment)) return null;
      segments.push(segment);
      continue;
    }
    const [, name, modifier] = match;
    const value = request.viewState[`${ROUTE_PARAM_PREFIX}${name}`];
    const parts = typeof value !== "string" ? [] : modifier === "*" || modifier === "+" ? value.split("/").filter((part) => part !== "").map(unescapePart) : value === "" ? [] : [value];
    if (parts.length === 0) {
      if (modifier === "?" || modifier === "*") continue;
      return null;
    }
    segments.push(...parts.map(encodeURIComponent));
  }
  const path = `/${segments.join("/")}`;
  return new URL(path, "https://critiqs.invalid").origin === "https://critiqs.invalid" ? path : null;
}

/** One segment of a repeated parameter, its own "%" and "/" escaped. */
function escapeSegment(segment: string): string {
  return segment.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** A repeated parameter's value as routeContext escaped it. */
function unescapePart(part: string): string {
  return part.replace(/%2F/gi, "/").replaceAll("%25", "%");
}
