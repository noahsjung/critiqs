/**
 * The app's pages: onboarding, the developer's setup page for a send's or
 * project's ID, a thread page for its page key, a review link's page for its
 * key, and a project's review links for its owners.
 */
export type Route =
  | { page: "start" }
  | { page: "setup"; id: string }
  | { page: "thread"; key: string }
  | { page: "review"; key: string }
  | { page: "review-links"; projectId: string }
  /** Allow Critiqs: how a site behind a bot wall lets review links in; for a project's origin when both are named (`?project=<id>&origin=<origin>`). */
  | { page: "allow-critiqs"; projectId: string | null; origin: string | null };

/** A review link's key: 26 base32 characters. Anything else opens nothing, the same as an unknown key. */
export const REVIEW_KEY = /^[a-z2-7]{26}$/;

/**
 * The page for a path. /t/<key> is a thread page, /setup/<id> a setup page,
 * /r/<key> a review link, /review-links/<project ID> a project's review links,
 * /allow-critiqs how to let review links past a firewall, and anything else
 * onboarding, at /start.
 */
export function routeOf(pathname: string, search = ""): Route {
  if (/^\/allow-critiqs\/?$/.test(pathname)) {
    const params = new URLSearchParams(search);
    const projectId = params.get("project");
    const origin = params.get("origin");
    return { page: "allow-critiqs", projectId: projectId !== null && projectId !== "" ? projectId : null, origin: origin !== null && origin !== "" ? origin : null };
  }
  const thread = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (thread !== null) return { page: "thread", key: thread[1]! };
  const review = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (review !== null) return { page: "review", key: review[1]! };
  const setup = /^\/setup\/([^/]+)\/?$/.exec(pathname);
  const links = /^\/review-links\/([^/]+)\/?$/.exec(pathname);
  for (const [match, make] of [
    [setup, (id: string): Route => ({ page: "setup", id })],
    [links, (projectId: string): Route => ({ page: "review-links", projectId })],
  ] as const) {
    if (match === null) continue;
    try {
      return make(decodeURIComponent(match[1]!));
    } catch {
      return { page: "start" };
    }
  }
  return { page: "start" };
}

/**
 * The prototype path a review link's address names after `#`, such as
 * `/r/<key>#/products/42`: a path on the prototype's own origin, without a
 * query, kept out of the address the server sees. Null for anything else.
 */
export function reviewPathOf(hash: string): string | null {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/__critiqs/")) return null;
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path)) return null;
  return path;
}
