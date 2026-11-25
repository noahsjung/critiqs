import { AiError } from "./model.ts";

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

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return false;
  if (address === "::" || address === "::1") return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  // Mapped addresses written in hex, such as ::ffff:7f00:1, are refused outright.
  if (address.startsWith("::ffff:")) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(address);
}

/** Whether a host names this computer or a private network, by name or address. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  );
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
