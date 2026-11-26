import { CritiqsError, endTrackerSignIn, exchangeLinearCode, linearAdapter, linearAuthorizeUrl, readLinearWebhook, SIGN_IN_MINUTES, sealSignIn } from "@critiqs/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { readBoundedBody } from "./lib/body";
import { messagePage } from "./lib/pages";
import { siteUrl, ticketsDeployment } from "./lib/tickets";
import { hashSecret } from "./lib/tokens";

// Tracker sign-in's trip through the browser (Linear so far):
//
// 1. Your trackers starts a sign-in (`trackers:startSignIn`), which gives
//    only it the state and a binding secret, and posts both to
//    /trackers/linear/start from a window it opened. The secret never goes in
//    an address, so a forwarded link opens nothing. The start opens the
//    sign-in once, keeps the secret in a cookie, and sends the window to Linear.
// 2. Linear sends the person back to /trackers/linear/callback with a code
//    and the same state. Only the browser holding the secret may finish it;
//    the state is used once and expires after a few minutes.
// 3. The code (with its PKCE verifier) becomes tokens and Linear says whose
//    they are. They are stored encrypted for the person who started only
//    when the Linear account's email is that person's Critiqs email:
//    Critiqs keeps no session in this window, so it can't otherwise tell
//    that the person finishing is the one who started.

const MAX_STATE = 200;
/** The most of a sign-in start's form Critiqs reads: its state and binding secret fit many times over. */
const MAX_START_BYTES = 4 * 1024;

/**
 * The cookie that holds one sign-in's binding secret, named after its state's
 * hash, so sign-ins started in several windows of one browser keep their own.
 */
async function cookieName(state: string): Promise<string> {
  return `critiqs_tracker_sign_in_${(await hashSecret(state)).slice(0, 22)}`;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = siteUrl().startsWith("https:") ? "; Secure" : "";
  return `${name}=${value}; Path=/trackers; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Hash of this browser's cookie for a sign-in, or an empty string when it has none. */
async function browserBinding(request: Request, name: string): Promise<string> {
  const value = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([each]) => each === name)?.[1];
  return value === undefined || value === "" ? "" : await hashSecret(value);
}

/** The page shown when Linear wasn't connected; the window is otherwise done. */
function notConnected(message: string, status = 400): Response {
  return messagePage("Linear wasn't connected", message, status);
}

const startAgain = "This sign-in has expired or was already used. Close this window and choose Connect in Your trackers again.";
const fromYourTrackers = "This link only works in the window Your trackers opens. To connect your own Linear account, choose Connect Linear in Your trackers.";

/** A sign-in into a Linear account whose email isn't the Critiqs account's. It never names the Critiqs account's email: whoever is in this window may not own it. */
function otherEmail(identity: { accountName: string; email: string | null }): Response {
  const used = identity.email ?? identity.accountName;
  return notConnected(
    `The Linear account you signed in with (${used}) doesn't use the same email address as the Critiqs account that started connecting, so nothing was connected. Sign in to Linear with the email address you use for Critiqs, or connect with a Linear API key in Your trackers instead.`,
    403,
  );
}

const notSetUp = () => notConnected("Linear sign-in isn't set up on this deployment.", 404);

/** A start link opened on its own, as when it was forwarded: it never reaches Linear. */
export const linearStartLink = httpAction(async () => {
  const deployment = ticketsDeployment();
  if (deployment.linear === null || deployment.encryptionKey === null) return notSetUp();
  return notConnected(fromYourTrackers);
});

/** The window Your trackers opened posts the sign-in's state and binding secret here. */
export const linearStart = httpAction(async (ctx, request) => {
  const deployment = ticketsDeployment();
  if (deployment.linear === null || deployment.encryptionKey === null) return notSetUp();
  const body = await readBoundedBody(request, MAX_START_BYTES);
  if (body === "too-large") return notConnected(fromYourTrackers, 413);
  if (body === "invalid") return notConnected(fromYourTrackers);
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const state = form.get("state") ?? "";
  const binding = form.get("binding") ?? "";
  if (state === "" || state.length > MAX_STATE || binding === "" || binding.length > MAX_STATE) return notConnected(fromYourTrackers);
  const opened = await ctx.runMutation(internal.trackers.openSignIn, { tracker: "linear", state, bindingHash: await hashSecret(binding) });
  if (opened.status === "other-browser") return notConnected(fromYourTrackers);
  if (opened.status !== "opened") return notConnected(startAgain);
  const location = linearAuthorizeUrl(deployment.linearAppUrl, {
    clientId: deployment.linear.clientId,
    redirectUri: `${siteUrl()}/trackers/linear/callback`,
    state,
    challenge: await hashSecret(opened.verifier),
  });
  return new Response(null, {
    // See Other: the window follows with a GET.
    status: 303,
    headers: {
      Location: location,
      "Set-Cookie": cookie(await cookieName(state), binding, SIGN_IN_MINUTES * 60),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      // Linear's pages never get a handle on the prototype that opened this window.
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  });
});

export const linearCallback = httpAction(async (ctx, request) => {
  const deployment = ticketsDeployment();
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  if (deployment.linear === null || deployment.encryptionKey === null) return notSetUp();
  if (state === "" || state.length > MAX_STATE) return notConnected(startAgain);
  // Only this sign-in's own cookie is read and cleared; another window's sign-in keeps its.
  const name = await cookieName(state);
  const clear = { "Set-Cookie": cookie(name, "", 0) };
  const claimed = await ctx.runMutation(internal.trackers.claimSignIn, { tracker: "linear", state, bindingHash: await browserBinding(request, name) });
  if (claimed.status === "other-browser") {
    return withHeaders(notConnected("Finish connecting Linear in the same browser window that started it. Close this window and choose Connect in Your trackers again."), clear);
  }
  if (claimed.status === "expired") return withHeaders(notConnected(startAgain), clear);
  // Whatever else happens, this sign-in is over: only a saved one ends by saving.
  const end = async (response: Response) => {
    await ctx.runMutation(internal.trackers.dropSignIn, { tracker: "linear", state });
    return withHeaders(response, clear);
  };
  const error = params.get("error");
  if (error !== null) {
    return await end(
      notConnected(error === "access_denied" ? "You didn't allow Critiqs to use your Linear account. You can close this window." : "Linear didn't finish the sign-in. Close this window and try again."),
    );
  }
  const code = params.get("code") ?? "";
  if (code === "") return await end(notConnected("Linear didn't finish the sign-in. Close this window and try again."));
  try {
    const endpoint = { baseUrl: deployment.linearApiUrl };
    const tokens = await exchangeLinearCode(endpoint, deployment.linear, { code, redirectUri: `${siteUrl()}/trackers/linear/callback`, verifier: claimed.verifier }, Date.now());
    const identity = await linearAdapter(endpoint).verify({ method: "oauth", value: tokens.access });
    const account = await sealSignIn(deployment, "linear", claimed.userId, identity, tokens);
    const saved = await ctx.runMutation(internal.trackers.saveSignedIn, { userId: claimed.userId, account, state });
    if (saved.status === "other-email") return withHeaders(otherEmail(identity), clear);
    if (saved.status === "cancelled") {
      // Disconnected while this window was signing in: the tokens it got are ended, not kept.
      await endTrackerSignIn(deployment, "linear", { access: tokens.access, refresh: tokens.refresh });
      return withHeaders(notConnected("You disconnected Linear while this window was signing in, so Critiqs didn't connect it. Close this window, and connect Linear again in Your trackers if you meant to.", 409), clear);
    }
  } catch (failure) {
    // Linear's refusals and Critiqs's own say what to do; anything else stays vague, never echoing tokens.
    return await end(notConnected(failureMessage(failure), 502));
  }
  return withHeaders(messagePage("Linear is connected", "You can close this window.", 200), clear);
});

/** What a failed sign-in says: Critiqs's own refusals as written, anything else vaguely, never echoing tokens. */
export function failureMessage(failure: unknown): string {
  if (failure instanceof CritiqsError) return failure.message;
  const data: unknown = failure instanceof ConvexError ? failure.data : null;
  if (typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string") return (data as { message: string }).message;
  return "Something went wrong while connecting Linear. Close this window and try again.";
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.append(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

/** The most bytes a webhook delivery may hold; Linear's issue events are a few kilobytes. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Linear's webhooks for the operator's Linear app (set its webhook address to
 * `<deployment site>/trackers/linear/webhook`, with Issues events): each
 * delivery's signature is checked with `CRITIQS_LINEAR_WEBHOOK_SECRET`, and
 * its timestamp must be within a minute, before anything in it is used. An
 * issue's new status reaches every thread that links it, up to the
 * workspace's updates for the minute (429 past them); other events are
 * answered 200 and ignored, so Linear doesn't retry them.
 */
export const linearWebhook = httpAction(async (ctx, request) => {
  const secret = ticketsDeployment().linearWebhookSecret;
  if (secret === null) return new Response("Linear webhooks aren't set up on this deployment.", { status: 404 });
  // The signature covers the body's exact bytes, so they are read as bytes, never as text first.
  const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  if (body === "invalid") return new Response("Content-Length isn't a number.", { status: 400 });
  if (body === "too-large") return new Response("Too large.", { status: 413 });
  const read = await readLinearWebhook(secret, body, request.headers.get("Linear-Signature"), Date.now());
  if (read.status === "refused") return new Response("Not a current delivery from Linear.", { status: 401 });
  if (read.status === "update" && (await ctx.runMutation(internal.ticketStatus.apply, { update: read.update })).limited) return tooManyUpdates();
  return new Response(null, { status: 200 });
});

/** The answer to a delivery past its site's updates for the minute: a tracker that retries sends it again later. */
function tooManyUpdates(): Response {
  return new Response("Too many status updates from this site this minute. Send it again later.", { status: 429, headers: { "Retry-After": "60" } });
}
