/** The app's pages: onboarding, the developer's setup page for a send's or project's ID, and a thread page for its page key. */
export type Route = { page: "start" } | { page: "setup"; id: string } | { page: "thread"; key: string };

/** The page for a path. /t/<key> is a thread page, /setup/<id> a setup page, and anything else onboarding, at /start. */
export function routeOf(pathname: string): Route {
  const thread = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (thread !== null) return { page: "thread", key: thread[1]! };
  const setup = /^\/setup\/([^/]+)\/?$/.exec(pathname);
  if (setup !== null) {
    try {
      return { page: "setup", id: decodeURIComponent(setup[1]!) };
    } catch {
      return { page: "start" };
    }
  }
  return { page: "start" };
}
