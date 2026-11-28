import type { ProjectInfo, ProjectLookup } from "@critiqs/core";

// A stand-in for a Convex deployment and its sign-in service, behind
// `fetch`: `/critiqs/config`, the panel sign-in routes, renewals, and the
// project functions the worker calls. Every request is recorded.

export const BACKEND = "https://backend.convex.cloud";
export const SIGN_IN = "https://backend.convex.site";
export const DEVELOPMENT_CODE = "123456";

/** A token shaped like the service's: three parts, the middle one naming the reviewer. */
export function accessToken(name: string, serial: number): string {
  const payload = btoa(JSON.stringify({ sub: "dana", name, email: "dana@example.com", serial })).replace(/=+$/, "");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature-${serial}`;
}

export const project = (id: string, name = id): ProjectInfo => ({ _id: id, name, tags: [], createdAt: 1, reviewUrl: null }) as ProjectInfo;

export interface FakeBackend {
  requests: { url: string; body: Record<string, unknown> }[];
  /** Convex function calls: [path, args]. */
  calls: [string, Record<string, unknown>][];
  lookups: Map<string, ProjectLookup>;
  manageable: ProjectInfo[];
  projects: Map<string, ProjectInfo>;
  /** Emails whose next correct code asks for a name. */
  newPeople: Set<string>;
  refreshes: number;
  restore(): void;
}

export function fakeBackend(): FakeBackend {
  const realFetch = globalThis.fetch;
  const backend: FakeBackend = {
    requests: [],
    calls: [],
    lookups: new Map(),
    manageable: [],
    projects: new Map(),
    newPeople: new Set(),
    refreshes: 0,
    restore: () => void (globalThis.fetch = realFetch),
  };
  let attempts = 0;
  /** The reviewer's display name on the service: a rename changes it, and renewals carry it. */
  let name = "Dana";
  const attemptEmails = new Map<string, string>();
  const signedIn = (name: string) => ({
    accessToken: accessToken(name, ++backend.refreshes),
    refreshToken: `refresh-${backend.refreshes}-${"r".repeat(40)}`,
    expiresAt: Date.now() + 15 * 60_000,
    sessionEndsAt: Date.now() + 30 * 86_400_000,
    reviewer: { id: "dana", name, email: "dana@example.com" },
  });
  const convex = (path: string, args: Record<string, unknown>): unknown => {
    backend.calls.push([path, args]);
    switch (path) {
      case "projects:findForOrigin":
        return backend.lookups.get(String(args.origin)) ?? { status: "none" };
      case "projects:manageable":
        return { projects: backend.manageable, complete: true };
      case "projects:create": {
        const made = project("p-new", String(args.name));
        backend.projects.set(made._id, made);
        return made._id;
      }
      case "projects:addAddress":
        return [args.address];
      case "projects:get":
        return backend.projects.get(String(args.projectId)) ?? backend.manageable.find((one) => one._id === args.projectId) ?? project(String(args.projectId));
      case "threads:list":
        return { page: [], isDone: true, continueCursor: "" };
    }
    throw new Error(`No fake for ${path}`);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    backend.requests.push({ url: url.toString(), body });
    if (url.pathname === "/critiqs/config") return Response.json({ signInUrl: SIGN_IN, protocol: 5, transport: "convex", addressLists: true, addressEdits: true, createKeys: true });
    if (url.origin === SIGN_IN) {
      switch (url.pathname) {
        case "/auth/panel/email": {
          const attempt = typeof body.attempt === "string" ? body.attempt : `attempt-key-${++attempts}-secret`;
          attemptEmails.set(attempt, String(body.email));
          return Response.json({ attempt, email: String(body.email).toLowerCase(), developmentCode: DEVELOPMENT_CODE });
        }
        case "/auth/panel/code": {
          if (!attemptEmails.has(String(body.attempt))) return Response.json({ error: "expired", message: "Start again." }, { status: 400 });
          if (body.code !== DEVELOPMENT_CODE) return Response.json({ error: "wrong-code", message: "That code isn't right.", guessesLeft: 2 }, { status: 400 });
          if (backend.newPeople.has(attemptEmails.get(String(body.attempt))!)) return Response.json({ status: "needs-name" });
          return Response.json({ status: "signed-in", ...signedIn(name) });
        }
        case "/auth/panel/name":
          name = String(body.name);
          return Response.json(signedIn(name));
        case "/auth/refresh": {
          const { accessToken: token, refreshToken, expiresAt } = signedIn(name);
          return Response.json({ accessToken: token, refreshToken: typeof body.nextRefreshToken === "string" ? body.nextRefreshToken : refreshToken, expiresAt });
        }
        case "/auth/profile":
          name = String(body.name).trim();
          return new Response(null, { status: 204 });
        case "/auth/sign-out":
          return new Response(null, { status: 200, headers: { "Critiqs-Session-Ended": "true" } });
      }
    }
    if (url.origin === BACKEND && url.pathname.startsWith("/api/")) {
      try {
        return Response.json({ status: "success", value: convex(String(body.path), (body.args as Record<string, unknown>[] | Record<string, unknown> | undefined) instanceof Array ? (body.args as Record<string, unknown>[])[0]! : ((body.args ?? {}) as Record<string, unknown>)), logLines: [] });
      } catch (error) {
        return Response.json({ status: "error", errorMessage: String(error), logLines: [] });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return backend;
}
