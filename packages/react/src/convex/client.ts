import { ConvexReactClient, type ConvexReactClientOptions } from "convex/react";

/**
 * The Convex client for every Critiqs page that signs in with a `Session`.
 *
 * By default Convex asks for a new token as soon as the backend accepts the
 * saved one, so every page load would replace the refresh token even while
 * the access token is good for minutes more. Reusing the saved token until
 * shortly before it expires means a page load doesn't refresh at all.
 */
export function convexClient(url: string, options: Omit<ConvexReactClientOptions, "initialAuthTokenReuse"> = {}): ConvexReactClient {
  return new ConvexReactClient(url, { ...options, initialAuthTokenReuse: true });
}
