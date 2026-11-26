import { classifyAddress } from "@critiqs/core";
import { type AllowCheckResult, ALLOW_PROOF_PATH, hasAllowProof, proxyAuthorized } from "@critiqs/server/review-links";
import type { ProxyConfig } from "./config.ts";
import { readDecoded } from "./decompress.ts";
import type { Egress } from "./egress.ts";
import { charsetOf } from "./headers.ts";
import { decodeHtml } from "./html.ts";
import { windowCounter } from "./limits.ts";

// Allow Critiqs' **Check again**: the backend asks the proxy
// (`POST /__critiqs/probe`, with the shared secret) whether a site lets the
// proxy in now. Only the proxy can answer that: a site's rule lets in the
// proxy's own egress with the project's token, which the backend's network
// isn't. The probe fetches the site's root through the same egress review
// links use (every public-address, rebinding, redirect, self and reputation
// check), with that origin's token and nothing else, reads it within the
// page limits, and names what it found with onboarding's own reading of a
// response (`classifyAddress`). Then it looks for the project's proof file.
// It answers only `{ result, proof }`: never a status, a header, an address
// or an error. Anyone without the secret gets the same bare 404 as any other
// unknown path; checks are limited per origin and for the whole process.

/** The largest request body the probe reads. */
const MAX_BODY = 4 * 1024;
/** The proof file is read up to this many bytes. */
const PROOF_BYTES = 4 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{22,86}$/;
const PROOF = /^[A-Za-z0-9_-]{16,64}$/;

export interface ProbeLimits {
  /** Checks the whole process runs per minute, and for one origin. */
  perMinute: number;
  perOriginPerMinute: number;
}

export const DEFAULT_PROBE_LIMITS: ProbeLimits = { perMinute: 60, perOriginPerMinute: 6 };

/** The origin to check: `https://` (or `http://` on a `.localhost` proxy's tests), a bare origin with a host name. Null otherwise. */
function originOf(value: unknown, local: boolean): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  return url.origin;
}

export function createProbe(config: Pick<ProxyConfig, "secret" | "limits" | "local">, deps: { egress: Egress; now?: () => number; limits?: ProbeLimits }) {
  const limits = deps.limits ?? DEFAULT_PROBE_LIMITS;
  const all = windowCounter({ windowMs: 60_000, requests: limits.perMinute, bytes: Number.POSITIVE_INFINITY }, deps.now);
  const perOrigin = windowCounter({ windowMs: 60_000, requests: limits.perOriginPerMinute, bytes: Number.POSITIVE_INFINITY }, deps.now);
  const plain = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  const answer = (result: AllowCheckResult, proof = false) => Response.json({ result, proof }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

  /** What the site's root shows the proxy now, with the token. */
  const look = async (origin: string, token: string | null, signal: AbortSignal): Promise<AllowCheckResult> => {
    const outcome = await deps.egress.fetch({ url: new URL("/", origin), method: "GET", class: "document", origin, allowToken: token, signal });
    if (outcome.kind === "refused") return outcome.reason === "unsafe" ? "unsafe" : "unreachable";
    if (outcome.kind === "left") return outcome.signIn ? "sign-in" : "unreachable";
    let html: string | null = null;
    try {
      const bytes = await readDecoded(outcome.body, outcome.headers["content-encoding"], { wireBytes: config.limits.htmlInputBytes, decodedBytes: config.limits.htmlInputBytes, idleMs: config.limits.idleTimeoutMs, totalMs: config.limits.bodyTimeoutMs }, signal);
      html = decodeHtml(bytes, charsetOf(outcome.headers["content-type"]));
    } catch {
      // Too large, too slow, or a body that isn't readable: judged on its status and headers alone.
    }
    const found = classifyAddress({ hops: [{ url: outcome.url.href, status: outcome.status, headers: outcome.headers }], html });
    return found.kind === "public" ? "public" : found.kind === "blocked" ? "blocked" : found.kind === "sign-in" ? "sign-in" : "unreachable";
  };

  /** Whether the site publishes the project's proof, fetched the same way. */
  const proven = async (origin: string, token: string | null, proof: string, signal: AbortSignal): Promise<boolean> => {
    const outcome = await deps.egress.fetch({ url: new URL(ALLOW_PROOF_PATH, origin), method: "GET", class: "data", origin, allowToken: token, signal });
    if (outcome.kind !== "response" || outcome.status !== 200) {
      if (outcome.kind === "response") void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      return false;
    }
    try {
      const bytes = await readDecoded(outcome.body, outcome.headers["content-encoding"], { wireBytes: PROOF_BYTES, decodedBytes: PROOF_BYTES, idleMs: config.limits.idleTimeoutMs, totalMs: config.limits.bodyTimeoutMs }, signal);
      return hasAllowProof(new TextDecoder().decode(bytes), proof);
    } catch {
      return false;
    }
  };

  return async function probe(request: Request): Promise<Response> {
    // Without the secret, the same answer as any path that isn't there.
    if (!(await proxyAuthorized(request.headers.get("authorization"), config.secret))) return plain(404, "Not found");
    const length = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(length) || length > MAX_BODY) return plain(413, "");
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return plain(413, "");
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return plain(400, "");
    }
    if (body === null || typeof body !== "object") return plain(400, "");
    const origin = originOf(body.origin, config.local);
    const token = body.token === undefined ? null : typeof body.token === "string" && TOKEN.test(body.token) ? body.token : undefined;
    const proof = body.proof === undefined ? null : typeof body.proof === "string" && PROOF.test(body.proof) ? body.proof : undefined;
    if (origin === null || token === undefined || proof === undefined) return plain(400, "");
    if (!all.admit("all") || !perOrigin.admit(origin)) return plain(429, "");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.limits.headersTimeoutMs + config.limits.bodyTimeoutMs)]);
    try {
      const result = await look(origin, token, signal);
      return answer(result, result === "public" && proof !== null ? await proven(origin, token, proof, signal) : false);
    } catch {
      return answer("unreachable");
    }
  };
}
