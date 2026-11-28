// People and saved data for the acceptance checks: reviewers signed in through
// the sign-in service the way the extension's worker signs in (from the
// extension's origin), and what the backend saved, read back through its API.
import { api } from "@critiqs/backend/api";
import { panelSignIn } from "@critiqs/core";
import { ConvexHttpClient } from "convex/browser";
import { resolveDeployment } from "../../../react/src/deployment.ts";
import { type Browser, EXTENSION_ID } from "./browser.ts";

export interface SignedIn {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sessionEndsAt: number;
  reviewer: { id: string; name: string; email: string };
}

export interface Person {
  email: string;
  name: string;
  convex: ConvexHttpClient;
  signedIn: SignedIn;
}

export interface Deployment {
  backend: string;
  signInUrl: string;
  /** The Convex site: `/critiqs/config`, `/capture`, sign-in. */
  site: string;
  website: string | undefined;
}

export async function deployment(backend: string): Promise<Deployment> {
  const { signInUrl, website } = await resolveDeployment(backend);
  return { backend, signInUrl, site: signInUrl, website };
}

/** Signs someone in through the sign-in service the way the extension does, for data the run needs from a second person. */
export async function signInDirectly(where: Deployment, email: string, name: string): Promise<Person> {
  const client = panelSignIn(where.signInUrl, { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: `chrome-extension://${EXTENSION_ID}` } }) });
  const { attempt, developmentCode } = await client.sendCode(email);
  if (developmentCode === undefined) throw new Error("Development sign-in is off on this backend.");
  const checked = await client.checkCode(attempt, developmentCode);
  const signedIn = (checked.status === "needs-name" ? await client.chooseName(attempt, name) : checked) as unknown as SignedIn;
  const convex = new ConvexHttpClient(where.backend);
  convex.setAuth(signedIn.accessToken);
  return { email, name, convex, signedIn };
}

/** The session the extension keeps for a deployment, read in its worker (a context storage stays open to). */
export async function storedSession(browser: Browser, where: Deployment): Promise<(SignedIn & { nextRefreshToken?: string }) | null> {
  const key = `session:${where.signInUrl}`;
  return await browser.inWorker((name: string) => (globalThis as any).chrome.storage.local.get(name).then((items: Record<string, unknown>) => items[name] ?? null), key);
}

/** Puts a session where the extension keeps it, as a sign-in would. Used only when signing in on the page failed, so later cases can still run. */
export async function seedSession(browser: Browser, where: Deployment, signedIn: SignedIn) {
  const key = `session:${where.signInUrl}`;
  const session = { accessToken: signedIn.accessToken, refreshToken: signedIn.refreshToken, expiresAt: signedIn.expiresAt, sessionEndsAt: signedIn.sessionEndsAt, reviewer: signedIn.reviewer };
  await browser.inWorker(({ name, value }: { name: string; value: unknown }) => (globalThis as any).chrome.storage.local.set({ [name]: value }), { name: key, value: session });
}

/** A client acting as the reviewer whose session the extension holds. */
export async function asStoredReviewer(browser: Browser, where: Deployment): Promise<ConvexHttpClient | null> {
  const session = await storedSession(browser, where);
  if (session?.accessToken === undefined) return null;
  const convex = new ConvexHttpClient(where.backend);
  convex.setAuth(session.accessToken);
  return convex;
}

export async function createProject(person: Person, name: string, addresses: string[]): Promise<string> {
  const id = (await person.convex.mutation(api.projects.create, { name, reviewUrl: null })) as string;
  if (addresses.length > 0) await person.convex.mutation(api.projects.setAddresses, { projectId: id as never, addresses });
  return id;
}

/** The project's threads, newest first, as the API lists them. */
export async function threads(convex: ConvexHttpClient, projectId: string): Promise<any[]> {
  const list = (await convex.query(api.threads.list, { projectId: projectId as never, paginationOpts: { numItems: 40, cursor: null } })) as any;
  return list.page;
}

/** One thread with its messages. */
export async function thread(convex: ConvexHttpClient, threadId: string): Promise<any> {
  return await convex.query(api.threads.get, { threadId: threadId as never, paginationOpts: { numItems: 40, cursor: null } });
}

/** What the thread's page says about it: where it was made (`madeWith`) and whether its project ever reported Connected. */
export async function threadPage(convex: ConvexHttpClient, threadId: string): Promise<{ madeWith: string | null; connectedAt: number | null }> {
  const key = (await convex.mutation(api.threads.pageKey, { threadId: threadId as never })) as string;
  const page = (await convex.query(api.threads.page, { key, paginationOpts: { numItems: 1, cursor: null } })) as any;
  return { madeWith: page?.prototype?.madeWith ?? null, connectedAt: page?.project?.connectedAt ?? null };
}

/** The text of a thread's first message, whatever the list calls it. */
export function firstText(summary: any): string {
  return String(summary?.preview?.body ?? summary?.firstMessage?.body ?? summary?.body ?? "");
}

/** A comment by `person` on the test page's button, through the API. */
export async function postThread(person: Person, projectId: string, pageUrl: string, body: string, purposeId = "team.save"): Promise<string> {
  const url = new URL(pageUrl);
  return (await person.convex.mutation(api.threads.create, {
    projectId: projectId as never,
    body,
    tags: [],
    capture: { status: "failed", failureReason: "made through the API by the acceptance run" },
    anchor: {
      screen: url.pathname,
      viewState: {},
      scope: "shared",
      target: { purposeId, recordKey: null, clues: { tagName: "button", role: null, label: "Save changes", path: "body > section > button" } },
      evidence: { url: url.toString(), viewport: { width: 1400, height: 900 }, marker: null, capturedAt: Date.now(), revision: null, persona: null, userAgent: null },
    },
  } as never)) as string;
}

/** Signs `person` in again, for a fresh access token on a long run. */
export async function refreshed(where: Deployment, person: Person): Promise<Person> {
  return await signInDirectly(where, person.email, person.name);
}

/** The saved screenshot of a thread, as PNG bytes, or why there is none. */
export async function captureImage(where: Deployment, accessToken: string, threadId: string): Promise<{ bytes: ArrayBuffer | null; status: number }> {
  const response = await fetch(`${where.site}/capture?threadId=${encodeURIComponent(threadId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return { bytes: response.ok ? await response.arrayBuffer() : null, status: response.status };
}
