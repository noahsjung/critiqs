/** The app's pages: onboarding, and the developer's setup page for a send's or project's ID. */
export type Route = { page: "start" } | { page: "setup"; id: string };

/** The page for a path. Anything that isn't /setup/<id> is onboarding, at /start. */
export function routeOf(pathname: string): Route {
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
