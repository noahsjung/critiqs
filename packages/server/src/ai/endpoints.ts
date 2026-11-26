import { isLocalHost } from "@critiqs/core";
import { AiError } from "./model.ts";

// Core owns the rule, shared with onboarding. Exported here so `@critiqs/server` callers keep it.
export { isLocalHost };

// Custom provider addresses are a server-side request boundary: the server
// sends a provider key to whatever address a project names. So an address
// someone enters must match an endpoint the deployment's operator allowed,
// use HTTPS, carry no credentials, and not name a private, loopback, or
// link-local address unless the operator allowed local endpoints (only for a
// server they run themselves). Requests never follow redirects, and every
// request must stay under the configured address.

/** OpenRouter's address. Critiqs sets it, so it is treated as a provider's own address, not a custom one. */
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";

export interface EndpointPolicy {
  /** Address prefixes the operator allowed, such as `https://llm.example.com/v1`. */
  allowed: string[];
  /** Whether `http://` and private addresses may be allowed, for a server the operator runs, such as a local Ollama. */
  allowLocal: boolean;
}

/** Normalized prefix: no trailing slash, no query or fragment. */
function normalize(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Whether `url` is the prefix `base` or under it, at a path segment. */
export function isUnder(url: URL, base: string): boolean {
  const prefix = new URL(base);
  if (url.protocol !== prefix.protocol || url.host !== prefix.host) return false;
  const path = prefix.pathname.replace(/\/+$/, "");
  return url.pathname === path || url.pathname.startsWith(`${path}/`) || path === "";
}

/**
 * Checks an address a project wants to send requests to. `trusted` is for an
 * address the operator configured themselves, which needs no allowlist entry.
 * Returns the normalized address, or why it isn't allowed.
 */
export function checkEndpoint(raw: string, policy: EndpointPolicy, trusted = false): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Enter the endpoint's full address, starting with https://." };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "Endpoint addresses can't contain a username or password; enter the key separately." };
  if (url.search !== "" || url.hash !== "") return { ok: false, reason: "Endpoint addresses can't contain a query or fragment." };
  const local = isLocalHost(url.hostname);
  if (url.protocol === "http:") {
    if (!(policy.allowLocal && (trusted || local))) return { ok: false, reason: "Endpoints must use HTTPS." };
  } else if (url.protocol !== "https:") {
    return { ok: false, reason: "Endpoints must use HTTPS." };
  }
  if (local && !policy.allowLocal) return { ok: false, reason: "This deployment doesn't allow private or local network addresses." };
  const normalized = normalize(url);
  if (trusted) return { ok: true, url: normalized };
  const allowed = policy.allowed.some((entry) => {
    try {
      const prefix = new URL(entry.trim());
      if (prefix.protocol === "http:" && !policy.allowLocal) return false;
      return isUnder(url, normalize(prefix));
    } catch {
      return false;
    }
  });
  if (!allowed) return { ok: false, reason: "This endpoint isn't on this deployment's list of allowed AI endpoints. Ask its operator to add it." };
  return { ok: true, url: normalized };
}

/**
 * A `fetch` for one provider connection: requests must stay under `base`
 * when one is set (otherwise use HTTPS to the provider's own address), never
 * follow redirects, and end after `timeoutMs`. `send` is the underlying
 * fetch, for tests.
 */
export function guardedFetch(base: string | null, timeoutMs: number, allowHttp = false, send: typeof fetch = globalThis.fetch): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (base !== null ? !isUnder(url, base) : url.protocol !== "https:") {
      throw new AiError("config", "The provider tried to reach an address outside its configured endpoint.");
    }
    if (url.protocol !== "https:" && !(allowHttp && base !== null)) throw new AiError("config", "Endpoints must use HTTPS.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await send(input, { ...init, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new AiError("network", "The provider answered with a redirect, which Critiqs doesn't follow.");
    }
    return response;
  };
  return guarded as typeof fetch;
}
