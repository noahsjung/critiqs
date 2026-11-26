import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { type ActionCtx, httpAction } from "./_generated/server";
import {
  CODE_MINUTES,
  cleanCode,
  codeDigest,
  generateCode,
  MailError,
  normalizeEmail,
  readPreferenceToken,
  readReportToken,
  REPORT_DONE,
  REPORT_PATH,
  REPORT_QUESTION,
  resendMailer,
  signInCodeMessage,
} from "@critiqs/server";
import {
  codePage,
  consentPage,
  deliverPage,
  deviceApprovalPage,
  deviceCodePage,
  emailPage,
  messagePage,
  namePage,
  preferencePage,
  reportPage,
} from "./lib/pages";
import { linkSecret } from "./lib/links";
import { developerEmailSetup } from "./onboarding";
import { threadPageWebsite } from "./notifications";
import { CAPTURE_CORS, downloadCapture, downloadSnapshot, uploadCapture, uploadSnapshot } from "./captureHttp";
import { captureStorageHealth } from "./lib/r2";
import { ATTEMPT_MINUTES } from "./signIn";
import { hashSecret, issueAccessToken, randomSecret, signingKey } from "./lib/tokens";
import { isLoopback, isPanelOrigin, normalizeOrigin } from "./lib/origins";
import { deployment } from "./lib/ai";
import { billingConfig, billingHealth, verifyWebhook } from "./lib/billing";
import { emailConfigured } from "./lib/email";
import { syncOrganization } from "./billing";

/** Which AI this deployment offers, without any key or address. */
function aiHealth() {
  const config = deployment();
  return { managed: config.managed !== null, defaultProvider: config.defaultProvider?.provider ?? null, keysStorable: config.encryptionKey !== null };
}

const http = httpRouter();

// Captures remain protected for both native Convex storage and private R2.
http.route({ path: "/capture", method: "GET", handler: downloadCapture });
http.route({ path: "/capture/upload", method: "POST", handler: uploadCapture });
// Mockups' page copies, read with the same access checks as their project's threads.
http.route({ path: "/mockup/snapshot", method: "GET", handler: downloadSnapshot });
http.route({ path: "/mockup/upload", method: "POST", handler: uploadSnapshot });
for (const path of ["/capture", "/capture/upload", "/mockup/snapshot", "/mockup/upload"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: CAPTURE_CORS })) });
}

// ---------------------------------------------------------------------------
// Deployment configuration

/** Critiqs's sign-in service. The hosted deployment names itself; own deployments name the hosted one. */
function signInUrl(): string {
  const issuer = process.env.CRITIQS_AUTH_ISSUER;
  if (issuer === undefined || issuer === "") throw new Error("CRITIQS_AUTH_ISSUER is not set.");
  return issuer.replace(/\/$/, "");
}

/** Tells the component where reviewers sign in for this deployment. */
http.route({
  path: "/critiqs/config",
  method: "GET",
  handler: httpAction(async () =>
    Response.json(
      // Raise `protocol` when the component needs functions or sign-in steps an older backend lacks.
      // `deviceSignIn`: this sign-in service lets setup on another device be approved in a browser (/auth/device).
      // `deviceSessions`: such an approval can also keep a command line signed in (`critiqs sign-in`).
      // `agentReplies`: replies may be marked as written by a coding agent (`critiqs_reply`), and reply emails go out.
      // `mockups`: Mockup mode's functions (`mockups:*`, `ai:mockupReply`, `/mockup/snapshot`) and mockup threads.
      // `personalAi`: each person's own AI settings (`aiSettings:getPersonal`, `aiSettings:removePersonal`,
      // `ai:savePersonalSettings`, `ai:testPersonalSettings`), their own Critiqs AI credits used (`aiSettings:myUsage`),
      // and projects' AI usage rules and Critiqs AI models.
      // `modelLists`: providers' model lists (`ai:listModels`, `ai:listPersonalModels`), the OpenRouter provider,
      // and the models a person's requests may choose among (`aiSettings:myChoice`, `model` on `ai:mockupReply`).
      // `organizations`: the organizations a person belongs to (`organizations:mine`), and `organization` on projects.
      // `organizationMembers`: an organization's members and invites (`organizations:get`, `rename`, `invite`,
      // `revokeInvite`, `setRole`, `removeMember`), `home` on organizations, and `organizationId` on `projects:create`.
      // `overageCap`: an organization's admins set its cap on extra Critiqs AI credits (`organizations:setOverageCap`).
      // `reviewAccess`: projects report who can review them (`reviewAccess` on projects), and their owners
      // limit them to their organization's members (`projects:setReviewAccess`).
      // `threadPages`: thread pages (`threads:page`, `threads:pageKey`, `threadPage` on `threads:reply`, and
      // `/capture?threadPage=<key>`). `website`: the Critiqs website that serves them for this deployment, where
      // **Share** and emails link (`<website>/t/<key>`); absent without `CRITIQS_WEB_URL`, where they link to the prototype.
      // `addressLists`: projects' address lists (`projects:addresses`, `projects:setAddresses`), recording projects a
      // person opened (`projects:recordOpened`), and the browser extension's lookup (`projects:findForOrigin`).
      // `addressEdits`: adding or removing one address (`projects:addAddress`, `projects:removeAddress`), and the
      // projects whose lists a person may change (`projects:manageable`).
      // `createKeys`: `idempotencyKey` on `projects:create`, so a retried create returns the same project.
      // `billing`: this deployment takes payment (`billing:status`, `billing:changePlan`, `billing:setStorageAddOn`, `billing:portal`).
      // `addressCheck`: onboarding's check of a prototype's address (`addressCheck:check`).
      // `onboardingAnswers`: onboarding saves the person's answers (`onboarding:saveAboutYou`), and `projects:create`
      // takes `onboarding` and `stack`.
      // `developerEmails`: a project's owners email its setup steps to developers (`onboarding:sendDeveloperSetup`,
      // `onboarding:developerSends`), and setup links show them (`onboarding:developerSetup`); false without email. A copied
      // message's setup page shows the project and its install commands (`onboarding:projectSetup`), with or without email.
      // `panelSignIn`: this deployment's own sign-in service lets Critiqs's own panels sign in without a popup
      // (`/auth/panel/email`, `/auth/panel/code`, `/auth/panel/name`), and its extension's origin may use
      // `/auth/refresh`, `/auth/profile`, and `/auth/sign-out`. It describes this deployment, not `signInUrl`:
      // a panel asks the sign-in service's own `/critiqs/config` before offering it.
      {
        signInUrl: signInUrl(),
        protocol: 5,
        ai: aiHealth(),
        deviceSignIn: true,
        deviceSessions: true,
        agentReplies: true,
        mockups: true,
        personalAi: true,
        modelLists: true,
        organizations: true,
        organizationMembers: true,
        overageCap: true,
        reviewAccess: true,
        threadPages: true,
        ...(threadPageWebsite() === null ? {} : { website: threadPageWebsite() }),
        panelSignIn: true,
        addressLists: true,
        addressEdits: true,
        createKeys: true,
        ...(billingConfig() === null ? {} : { billing: true }),
        addressCheck: true,
        onboardingAnswers: true,
        developerEmails: developerEmailSetup() !== null,
      },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
    ),
  ),
});

/**
 * What `critiqs doctor` checks: whether this deployment can sign people in and
 * send email, and whether mention emails are actually going out. With
 * `projectId`, also whether that project exists here. Reveals no feedback.
 */
http.route({
  path: "/critiqs/health",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const state = await ctx.runQuery(internal.notifications.health, { projectId: projectId ?? undefined });
    const email = emailConfigured();
    const issuer = process.env.CRITIQS_AUTH_ISSUER?.replace(/\/$/, "") ?? "";
    const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
    return Response.json(
      {
        protocol: 5,
        // Whether this deployment runs sign-in itself, and how; or trusts another's.
        signIn: issuer === "" ? "unconfigured" : issuer !== site ? "external" : signInMode(),
        email,
        plans: process.env.CRITIQS_PLANS === "enabled",
        billing: billingHealth(),
        captures: captureStorageHealth(),
        ai: { ...aiHealth(), ...(deployment().managedProblem ? { managedProblem: deployment().managedProblem } : {}) },
        ...state,
      },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
    );
  }),
});

/**
 * Autumn's webhook. Register `<site>/critiqs/billing/autumn` in Autumn for
 * `billing.updated`. A verified message makes Critiqs read the customer from
 * Autumn again and record it before answering (canceling a storage add-on left
 * behind when the organization left Pro), whatever the event, so events
 * arriving late, out of order, or more than once still leave the latest
 * state. When Autumn can't be read or the add-on can't be canceled the answer
 * is 503, and Svix sends the message again later. Not found where the
 * deployment doesn't take payment.
 */
http.route({
  path: "/critiqs/billing/autumn",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const config = billingConfig();
    if (config === null) return new Response("Not found", { status: 404 });
    if (config.webhookSecret === null) {
      console.error("An Autumn webhook arrived, but AUTUMN_WEBHOOK_SECRET isn't set.");
      return new Response("Billing webhooks aren't set up", { status: 503 });
    }
    const body = await request.text();
    const check = await verifyWebhook(config.webhookSecret, request.headers, body, Date.now());
    if (!check.ok) {
      console.warn(`Refused an Autumn webhook: ${check.reason}.`);
      return new Response("Invalid signature", { status: 401 });
    }
    const organizationId = await ctx.runQuery(internal.billing.organizationOf, { customerId: customerOf(body) });
    if (organizationId !== null) {
      try {
        await syncOrganization(ctx, config, organizationId);
      } catch (error) {
        console.error(`Autumn webhook ${check.id}: couldn't sync the customer with Autumn:`, error instanceof Error ? error.message : String(error));
        return new Response("Autumn couldn't be read; send this again later", { status: 503 });
      }
    }
    return new Response(null, { status: 204 });
  }),
});

function customerOf(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { data?: { customer_id?: unknown } } | null)?.data?.customer_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sign-in service (Critiqs's hosted deployment, or a local one in development)
//
// 1. The component opens /auth/start in a popup, naming its site and a nonce.
//    A cookie ties the attempt to that browser.
// 2. The reviewer enters their email; Critiqs sends a one-time code to it.
//    Development deployments show the code instead of sending it.
// 3. A matching code verifies the address. A new reviewer chooses a name.
// 4. The first time a reviewer signs in from a site, they allow that site.
// 5. The popup posts tokens to that site only. The component refreshes its
//    short-lived access token through /auth/refresh from the same site.

type SignInMode = "email" | "development" | "unavailable";

function signInMode(): SignInMode {
  // Codes and tokens are both keyed by the signing key; without it nobody can sign in.
  if (!process.env.CRITIQS_AUTH_PRIVATE_KEY) return "unavailable";
  if (emailConfigured()) return "email";
  // Development sign-in shows codes on screen, so anyone could claim any email; it only runs locally.
  if (process.env.CRITIQS_DEV_SIGN_IN === "enabled" && isLoopback(new URL(signInUrl()).hostname)) return "development";
  return "unavailable";
}

/** Key for code digests, derived from the signing key so deployments need no extra secret. */
function codeSecret(): string {
  const key = process.env.CRITIQS_AUTH_PRIVATE_KEY;
  if (key === undefined || key === "") throw new Error("CRITIQS_AUTH_PRIVATE_KEY is not set.");
  return `critiqs-sign-in-code:${key}`;
}

const ATTEMPT_COOKIE = "critiqs_sign_in";

function attemptCookie(value: string, maxAgeSeconds: number): string {
  const secure = signInUrl().startsWith("https:") ? "; Secure" : "";
  return `${ATTEMPT_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Hash of this browser's attempt cookie, or an empty string when it has none. */
async function browserBinding(request: Request): Promise<string> {
  const cookies = request.headers.get("Cookie") ?? "";
  const value = cookies
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === ATTEMPT_COOKIE)?.[1];
  return value === undefined || value === "" ? "" : await hashSecret(value);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.append(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => {
    const { publicJwk } = await signingKey();
    return Response.json({ keys: [publicJwk] }, { headers: { "Cache-Control": "public, max-age=300" } });
  }),
});

http.route({
  path: "/auth/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    const origin = normalizeOrigin(params.get("origin"));
    const clientState = params.get("state") ?? "";
    if (origin === null || clientState === "" || clientState.length > 200) {
      return messagePage(
        "Can't sign in",
        "This sign-in link is incomplete, or the prototype is not served over HTTPS. Close this window and try again.",
      );
    }
    const mode = signInMode();
    if (mode === "unavailable") {
      return messagePage("Sign-in unavailable", "This Critiqs deployment can't send sign-in codes yet.", 503);
    }
    const key = randomSecret();
    const binding = randomSecret();
    const start = await ctx.runMutation(internal.signIn.startAttempt, {
      key,
      origin,
      clientState,
      bindingHash: await hashSecret(binding),
    });
    if (!start.allowed) {
      return withHeaders(messagePage("Try sign-in again shortly", "Too many sign-in requests. Please wait a minute and try again.", 429),
        { "Retry-After": String(start.retryAfter) });
    }
    const cookie = { "Set-Cookie": attemptCookie(binding, ATTEMPT_MINUTES * 60) };
    return withHeaders(emailPage(key, origin, { development: mode === "development" }), cookie);
  }),
});

/** Sends a code to the address entered, or a new code to the same address. */
http.route({
  path: "/auth/email",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const mode = signInMode();
    if (mode === "unavailable") return messagePage("Sign-in unavailable", "This Critiqs deployment can't send sign-in codes yet.", 503);
    const form = new URLSearchParams(await request.text());
    const key = form.get("attempt") ?? "";
    const binding = await browserBinding(request);
    const typed = (form.get("email") ?? "").slice(0, 300);
    const email = normalizeEmail(typed);
    const context = await ctx.runMutation(internal.signIn.codeContext, { key, bindingHash: binding });
    if (email === null) {
      const origin = await attemptOrigin(ctx, key, binding);
      if (origin === null) return expiredPage();
      return emailPage(key, origin, { development: mode === "development", error: "Enter a valid email address.", email: typed });
    }
    const sent = await sendCode(ctx, { key, binding, email, mode, panel: false });
    switch (sent.status) {
      case "expired":
        return expiredPage();
      case "locked":
        return lockedPage();
      case "too-many-codes":
      case "rate-limited":
        // The current code, if any, still works.
        if (context !== null && context.email === email) {
          return codePage(key, context.origin, email, {
            development: mode === "development",
            canResend: false,
            error:
              sent.status === "too-many-codes"
                ? "No more codes can be sent from this window. Use the latest code, or close this window and start again."
                : "Too many codes were sent recently. Wait a few minutes before asking for another.",
          });
        }
        return withHeaders(
          messagePage("Try again shortly", "Too many codes were sent recently. Wait a few minutes, then close this window and start again.", 429),
          sent.status === "rate-limited" ? { "Retry-After": String(sent.retryAfter) } : {},
        );
      case "send-failed":
        return emailPage(key, sent.origin, {
          development: false,
          email,
          error: "The code couldn't be sent. Check the address, or try again in a minute.",
        });
      case "sent":
        return codePage(key, sent.origin, email, {
          development: mode === "development",
          ...(mode === "development" ? { developmentCode: sent.code } : {}),
          canResend: true,
        });
    }
  }),
});

type SendResult =
  | { status: "expired" | "locked" | "too-many-codes" }
  | { status: "rate-limited"; retryAfter: number }
  | { status: "send-failed"; origin: string }
  | { status: "sent"; origin: string; code: string };

/**
 * Sends a new code for an attempt to an address, within the attempt's and the
 * address's limits; a new code replaces the attempt's previous one. Email
 * sign-in emails it; development sign-in returns it to be shown instead.
 */
async function sendCode(
  ctx: ActionCtx,
  { key, binding, email, mode, panel }: { key: string; binding: string; email: string; mode: SignInMode; panel: boolean },
): Promise<SendResult> {
  const prepared = await ctx.runMutation(internal.signIn.prepareCode, { key, bindingHash: binding, email, panel });
  if (prepared.status !== "ready") return prepared;
  const code = generateCode();
  const digest = await codeDigest(codeSecret(), { attempt: key, email, generation: prepared.generation, code });
  const stored = await ctx.runMutation(internal.signIn.storeCode, {
    key,
    bindingHash: binding,
    generation: prepared.generation,
    digest,
    expiresAt: Date.now() + CODE_MINUTES * 60 * 1000,
    panel,
  });
  if (!stored) return { status: "expired" };
  if (mode === "email") {
    try {
      await resendMailer({ apiKey: process.env.RESEND_API_KEY!, from: process.env.CRITIQS_EMAIL_FROM! }).send(
        signInCodeMessage({
          to: email,
          code,
          site: siteName(prepared.origin),
          idempotencyKey: `${key}:${prepared.generation}`,
          ...(panel ? { where: "panel" as const } : {}),
        }),
      );
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      return { status: "send-failed", origin: prepared.origin };
    }
  }
  return { status: "sent", origin: prepared.origin, code };
}

/** How the sign-in email names the site asking. */
function siteName(origin: string): string {
  return origin.startsWith("chrome-extension:") ? "pages with Critiqs's browser extension" : origin;
}

/** Checks a typed code. */
http.route({
  path: "/auth/code",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const mode = signInMode();
    if (mode === "unavailable") return messagePage("Sign-in unavailable", "This Critiqs deployment can't send sign-in codes yet.", 503);
    const form = new URLSearchParams(await request.text());
    const key = form.get("attempt") ?? "";
    const binding = await browserBinding(request);
    const context = await ctx.runMutation(internal.signIn.codeContext, { key, bindingHash: binding });
    if (context === null) return expiredPage();
    const typed = cleanCode((form.get("code") ?? "").slice(0, 20));
    const codeError = (error: string) =>
      codePage(key, context.origin, context.email, { development: mode === "development", canResend: true, error });
    if (!/^\d{6}$/.test(typed)) return codeError("Enter the 6-digit code from the email.");
    const digest = await codeDigest(codeSecret(), { attempt: key, email: context.email, generation: context.generation, code: typed });
    const consent = randomSecret();
    const result = await ctx.runMutation(internal.signIn.verifyCode, {
      key,
      bindingHash: binding,
      generation: context.generation,
      digest,
      consentHash: await hashSecret(consent),
    });
    switch (result.status) {
      case "expired":
        return expiredPage();
      case "locked":
        return lockedPage();
      case "code-expired":
        return codeError("That code has expired. Send a new code.");
      case "wrong":
        return codeError(`That code doesn't match. ${result.guessesLeft} ${result.guessesLeft === 1 ? "try" : "tries"} left.`);
      case "needs-name":
        return namePage(key, {});
      case "verified":
        if (result.device) return deviceApprovalPage(key, consent, result.profile, { keepSignedIn: result.keepSignedIn, backend: result.backend, site: result.site });
        if (result.allowed) return await finishSignIn(ctx, key, binding, null, true);
        return consentPage(key, consent, result.origin, result.profile);
    }
  }),
});

/** A new reviewer's display name, after their address is verified. */
http.route({
  path: "/auth/name",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const form = new URLSearchParams(await request.text());
    const key = form.get("attempt") ?? "";
    const binding = await browserBinding(request);
    const consent = randomSecret();
    const result = await ctx.runMutation(internal.signIn.registerReviewer, {
      key,
      bindingHash: binding,
      name: (form.get("name") ?? "").slice(0, 200),
      consentHash: await hashSecret(consent),
    });
    if (result.status === "expired") return expiredPage();
    if (result.status === "invalid-name") return namePage(key, { error: "Use a name of 1 to 60 characters." });
    if (result.device) return deviceApprovalPage(key, consent, result.profile, { keepSignedIn: result.keepSignedIn, backend: result.backend, site: result.site });
    if (result.allowed) return await finishSignIn(ctx, key, binding, null, true);
    return consentPage(key, consent, result.origin, result.profile);
  }),
});

http.route({
  path: "/auth/consent",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const form = new URLSearchParams(await request.text());
    const consent = form.get("consent") ?? "";
    if (consent === "") return expiredPage();
    return await finishSignIn(
      ctx,
      form.get("attempt") ?? "",
      await browserBinding(request),
      await hashSecret(consent),
      form.get("decision") === "allow",
    );
  }),
});

// ---------------------------------------------------------------------------
// Approving setup from another device (RFC 8628's device flow)
//
// 1. Setup (`critiqs init --remote`, or the MCP server) posts to
//    /auth/device/start and receives a device secret, a short setup code, and
//    this service's /auth/device address. It shows the code and the address.
// 2. In any browser, the person opens /auth/device, types the code, signs in
//    with an email code as usual, and approves or denies. A cookie ties these
//    pages to that browser, as with sign-in windows.
// 3. Setup polls /auth/device/token with its secret. Once approved, the poll
//    receives a 15-minute access token for the approver, once. No refresh
//    token is issued, so nothing outlives setup.
//
// `critiqs sign-in` starts the same flow with `{ "keepSignedIn": true }`. Its
// approval page says the command line stays signed in, and the poll that
// receives the approval also gets a refresh token for a session owned by this
// sign-in service's origin, which /auth/refresh and /auth/sign-out accept as
// they do a site's.

/** Letters that can't spell words or be misread as digits, for setup codes. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

function setupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  // 256 is a multiple of 20 plus 16; the slight bias leaves about 34 bits.
  const letters = Array.from(bytes, (byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** The code as typed, without spaces, dashes, or case; null when it can't be one. */
function cleanSetupCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 && [...letters].every((letter) => CODE_LETTERS.includes(letter)) ? letters : null;
}

/** Codes are short, so their stored hash is keyed by the signing key. */
async function setupCodeHash(letters: string): Promise<string> {
  return await hashSecret(`${codeSecret()}:device:${letters}`);
}

const DEVICE_HEADERS = { "Cache-Control": "no-store" };

function deviceError(error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: { ...DEVICE_HEADERS, ...headers } });
}

/** An address a command line names (its backend, or where that serves downloads), as an origin to show; undefined when absent or not an http(s) address. */
function shownOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

http.route({
  path: "/auth/device/start",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (signInMode() === "unavailable") return deviceError("unavailable", 503);
    let keepSignedIn = false;
    let backend: string | undefined;
    let site: string | undefined;
    try {
      const body = (await request.json()) as { keepSignedIn?: unknown; backend?: unknown; site?: unknown } | null;
      keepSignedIn = body?.keepSignedIn === true;
      backend = shownOrigin(body?.backend);
      // Shown only beside a backend.
      site = backend === undefined ? undefined : shownOrigin(body?.site);
    } catch {}
    const deviceCode = randomSecret();
    const deviceHash = await hashSecret(deviceCode);
    // A new code if one is already waiting; collisions are rare.
    for (let tries = 0; tries < 5; tries++) {
      const userCode = setupCode();
      const started = await ctx.runMutation(internal.deviceSignIn.start, {
        deviceHash,
        userCodeHash: await setupCodeHash(userCode.replace("-", "")),
        ...(keepSignedIn ? { keepSignedIn: true } : {}),
        ...(backend === undefined ? {} : { backend }),
        ...(site === undefined ? {} : { site }),
      });
      if (started.status === "rate-limited") {
        return deviceError("slow_down", 429, { retryAfter: started.retryAfter }, { "Retry-After": String(started.retryAfter) });
      }
      if (started.status === "started") {
        return Response.json(
          {
            deviceCode,
            userCode,
            verificationUrl: `${signInUrl()}/auth/device`,
            expiresIn: started.expiresIn,
            interval: started.interval,
            // What the approval page will name, so the command line knows this service shows it.
            backend: backend ?? null,
            site: site ?? null,
          },
          { headers: DEVICE_HEADERS },
        );
      }
    }
    return deviceError("unavailable", 503);
  }),
});

http.route({
  path: "/auth/device/token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let deviceCode: unknown;
    try {
      ({ deviceCode } = (await request.json()) as { deviceCode?: unknown });
    } catch {}
    if (typeof deviceCode !== "string" || deviceCode === "" || deviceCode.length > 200) return deviceError("invalid_request", 400);
    // Used only if the grant keeps the command line signed in.
    const refreshToken = randomSecret();
    const result = await ctx.runMutation(internal.deviceSignIn.poll, {
      deviceHash: await hashSecret(deviceCode),
      refreshHash: await hashSecret(refreshToken),
      origin: deviceTokenOrigin(),
    });
    switch (result.status) {
      case "pending":
        return deviceError("authorization_pending", 400, { interval: result.interval });
      case "slow-down":
        return deviceError("slow_down", 400, { interval: result.interval });
      case "denied":
        return deviceError("access_denied", 400);
      case "expired":
        return deviceError("expired_token", 400);
      case "invalid":
        return deviceError("invalid_grant", 400);
    }
    const { session } = result;
    const { accessToken, expiresAt } = await issueAccessToken(signInUrl(), result.profile, deviceTokenOrigin(), Date.now(), session?.endsAt);
    return Response.json(
      {
        accessToken,
        expiresAt,
        reviewer: { name: result.profile.name, email: result.profile.email },
        // What the approval page named.
        backend: result.backend,
        site: result.site,
        ...(session === null ? {} : { refreshToken, sessionEndsAt: session.endsAt }),
      },
      { headers: DEVICE_HEADERS },
    );
  }),
});

/**
 * The site a device approval's token names, and the origin its session (if
 * any) belongs to: this sign-in service, since no prototype is involved.
 */
function deviceTokenOrigin(): string {
  return new URL(signInUrl()).origin;
}

http.route({
  path: "/auth/device",
  method: "GET",
  handler: httpAction(async () => {
    if (signInMode() === "unavailable") return messagePage("Sign-in unavailable", "This Critiqs deployment can't send sign-in codes yet.", 503);
    return deviceCodePage();
  }),
});

http.route({
  path: "/auth/device",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const mode = signInMode();
    if (mode === "unavailable") return messagePage("Sign-in unavailable", "This Critiqs deployment can't send sign-in codes yet.", 503);
    const letters = cleanSetupCode((new URLSearchParams(await request.text()).get("user_code") ?? "").slice(0, 40));
    if (letters === null) return deviceCodePage({ error: "Enter the 8-letter code shown by setup, such as BCDF-GHJK.", status: 400 });
    const key = randomSecret();
    const binding = randomSecret();
    const begun = await ctx.runMutation(internal.deviceSignIn.begin, {
      userCodeHash: await setupCodeHash(letters),
      key,
      bindingHash: await hashSecret(binding),
      clientState: "device",
    });
    if (begun.status === "rate-limited") {
      return withHeaders(deviceCodePage({ error: "Too many codes were tried. Wait a minute, then try again.", status: 429 }), {
        "Retry-After": String(begun.retryAfter),
      });
    }
    if (begun.status === "unknown") {
      return deviceCodePage({ error: "That code isn't waiting for approval. Check it, or start setup again if it expired.", status: 400 });
    }
    return withHeaders(emailPage(key, begun.site, { development: mode === "development" }), {
      "Set-Cookie": attemptCookie(binding, ATTEMPT_MINUTES * 60),
    });
  }),
});

http.route({
  path: "/auth/device/decision",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const form = new URLSearchParams(await request.text());
    const consent = form.get("consent") ?? "";
    if (consent === "") return expiredPage();
    const result = await ctx.runMutation(internal.deviceSignIn.decide, {
      key: form.get("attempt") ?? "",
      bindingHash: await browserBinding(request),
      consentHash: await hashSecret(consent),
      allow: form.get("decision") === "approve",
    });
    const clear = { "Set-Cookie": attemptCookie("", 0) };
    if (result.status === "expired") {
      return messagePage("Setup approval expired", "This approval took too long, was already answered, or was started in another browser. Start setup again.");
    }
    if (result.status === "denied") {
      return withHeaders(messagePage(result.keepSignedIn ? "Access denied" : "Setup denied", "Nothing was signed in. You can close this page.", 200), clear);
    }
    if (result.keepSignedIn) {
      return withHeaders(
        messagePage(
          "Access approved",
          "Return to where you started; it continues on its own. To end this access, run critiqs sign-out on that computer. You can close this page.",
          200,
        ),
        clear,
      );
    }
    return withHeaders(
      messagePage("Setup approved", "Return to where you started setup; it continues on its own. You can close this page.", 200),
      clear,
    );
  }),
});

/** The site an attempt signs in to, for the browser that started it. */
async function attemptOrigin(ctx: ActionCtx, key: string, binding: string): Promise<string | null> {
  return await ctx.runMutation(internal.signIn.attemptOrigin, { key, bindingHash: binding });
}

async function finishSignIn(
  ctx: ActionCtx,
  key: string,
  binding: string,
  consentHash: string | null,
  allow: boolean,
): Promise<Response> {
  const refreshToken = randomSecret();
  const result = await ctx.runMutation(internal.signIn.finishAttempt, {
    key,
    bindingHash: binding,
    consentHash,
    allow,
    refreshHash: await hashSecret(refreshToken),
  });
  if (result === null) return expiredPage();
  const clear = { "Set-Cookie": attemptCookie("", 0) };
  const { origin, clientState, profile } = result;
  if (profile === null) {
    return withHeaders(deliverPage(origin, { type: "critiqs:sign-in", state: clientState, error: "cancelled" }), clear);
  }
  const { accessToken, expiresAt } = await issueAccessToken(signInUrl(), profile, origin);
  return withHeaders(
    deliverPage(origin, { type: "critiqs:sign-in", state: clientState, accessToken, refreshToken, expiresAt }),
    clear,
  );
}

function lockedPage(): Response {
  return messagePage(
    "Too many wrong codes",
    "This sign-in is locked after too many wrong codes. Close this window and start again.",
    429,
  );
}

function expiredPage(): Response {
  return messagePage(
    "Sign-in expired",
    "This sign-in took too long, was already used, or was started in another browser. Close this window and try again.",
  );
}

/** Returns a fresh access token for a session, only to the site that owns it. */
http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = normalizeOrigin(request.headers.get("Origin"));
    const headers = sessionCors(origin);
    const body = await readRefreshBody(request);
    if (origin === null || body === null) return new Response("Bad request", { status: 400, headers });
    // Clients save the token they choose before sending it, so a refresh
    // whose answer never arrives (the page closed, the network dropped) can
    // be sent again. Older clients send none and get one chosen here.
    const nextRefreshToken = body.nextRefreshToken ?? randomSecret();
    const session = await ctx.runMutation(internal.signIn.refreshSession, {
      refreshHash: await hashSecret(body.refreshToken),
      nextRefreshHash: await hashSecret(nextRefreshToken),
      origin,
    });
    if (session === "invalid") return new Response("Bad request", { status: 400, headers });
    if (session === null) return new Response("Signed out", { status: 401, headers });
    const { accessToken, expiresAt } = await issueAccessToken(signInUrl(), session.profile, origin, Date.now(), session.endsAt);
    return Response.json({ accessToken, refreshToken: nextRefreshToken, expiresAt }, { headers });
  }),
});

/** Changes the signed-in reviewer's display name; the component then refreshes its token. */
http.route({
  path: "/auth/profile",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = normalizeOrigin(request.headers.get("Origin"));
    const headers = sessionCors(origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad request", { status: 400, headers });
    }
    if (typeof body !== "object" || body === null) return new Response("Bad request", { status: 400, headers });
    const { refreshToken, name } = body as { refreshToken?: unknown; name?: unknown };
    if (origin === null || typeof refreshToken !== "string" || refreshToken === "" || typeof name !== "string") {
      return new Response("Bad request", { status: 400, headers });
    }
    const result = await ctx.runMutation(internal.signIn.renameReviewer, {
      refreshHash: await hashSecret(refreshToken),
      origin,
      name,
    });
    if (result === "signed-out") return new Response("Signed out", { status: 401, headers });
    if (result === "invalid") {
      return Response.json({ error: "Use a name of 1 to 60 characters." }, { status: 400, headers });
    }
    return new Response(null, { status: 204, headers });
  }),
});

http.route({
  path: "/auth/sign-out",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = normalizeOrigin(request.headers.get("Origin"));
    const headers = sessionCors(origin);
    let body: { refreshToken?: unknown; onlyIfCurrent?: unknown } = {};
    try { body = (await request.json()) ?? {}; } catch {}
    const refreshToken = typeof body.refreshToken === "string" && body.refreshToken !== "" ? body.refreshToken : null;
    let ended = false;
    if (origin !== null && refreshToken !== null) {
      // `onlyIfCurrent`: a late clean-up after a refresh, which must not end a session that has moved on.
      ended = await ctx.runMutation(internal.signIn.endSession, { refreshHash: await hashSecret(refreshToken), origin, onlyIfCurrent: body.onlyIfCurrent === true });
    }
    // `critiqs sign-out` reports a session it couldn't find, such as one replaced by a renewal whose answer was lost.
    return new Response(null, { status: 204, headers: { ...headers, "Critiqs-Session-Ended": String(ended) } });
  }),
});

for (const path of ["/auth/refresh", "/auth/profile", "/auth/sign-out"]) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async (_, request) =>
      new Response(null, { status: 204, headers: sessionCors(normalizeOrigin(request.headers.get("Origin"))) }),
    ),
  });
}

function sessionCors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Lets a page on another origin read whether sign-out found the session.
    "Access-Control-Expose-Headers": "Critiqs-Session-Ended",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

/** A refresh token the client chose: as random as the ones this service makes (32 bytes, base64url). */
const CHOSEN_REFRESH_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

async function readRefreshBody(request: Request): Promise<{ refreshToken: string; nextRefreshToken?: string } | null> {
  try {
    const { refreshToken, nextRefreshToken } = (await request.json()) as { refreshToken?: unknown; nextRefreshToken?: unknown };
    if (typeof refreshToken !== "string" || refreshToken === "") return null;
    if (nextRefreshToken === undefined) return { refreshToken };
    if (typeof nextRefreshToken !== "string" || !CHOSEN_REFRESH_TOKEN.test(nextRefreshToken) || nextRefreshToken === refreshToken) return null;
    return { refreshToken, nextRefreshToken };
  } catch {
    return null;
  }
}

async function readRefreshToken(request: Request): Promise<string | null> {
  try {
    const { refreshToken } = (await request.json()) as { refreshToken?: unknown };
    return typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signing in inside Critiqs's own panels, without a popup
//
// Critiqs's website and its browser extension's side panel (lib/origins.ts)
// sign in with the same email codes and limits as the popup, as JSON. Every
// request must come from one of those exact origins: any other gets no CORS
// headers and is refused before anything happens. The attempt key travels in
// the request body rather than a cookie, so it works across sites, and it is
// bound to the origin that started it. These origins are Critiqs's own, so
// there is no allow page and no site grant.
//
// 1. POST /auth/panel/email { email } starts an attempt and sends a code;
//    the answer carries the attempt key. With { email, attempt }, it sends a
//    new code for the same attempt, whose wrong-code count carries over.
// 2. POST /auth/panel/code { attempt, code } checks the code. A returning
//    reviewer receives the tokens; a new one is asked for a display name.
// 3. POST /auth/panel/name { attempt, name } registers a new reviewer, then
//    returns the tokens.
// The session then renews and ends through /auth/refresh, /auth/profile, and
// /auth/sign-out from the same origin, as a site's does.

/** Largest panel request body, in bytes; the fields are an email, a code, a name, and an attempt token. */
const PANEL_BODY_LIMIT = 4096;

function panelHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Access-Control-Expose-Headers": "Retry-After",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

/** For an origin that isn't one of Critiqs's panels: no CORS headers, so a browser shows the page nothing. */
function refusedOrigin(): Response {
  return Response.json({ error: "origin-not-allowed" }, { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } });
}

function panelError(
  origin: string,
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, message, ...extra }, { status, headers: { ...panelHeaders(origin), ...headers } });
}

const panelExpired = (origin: string) =>
  panelError(origin, 410, "expired", "This sign-in took too long or was already used. Start again.");

/**
 * The panel holds the attempt token; only digests of it are stored. The
 * attempt's key (which code digests and the mail provider's idempotency key
 * name) is one, and its binding, which also covers the panel's origin, is
 * another: a request from another origin finds nothing.
 */
async function panelAttempt(origin: string, token: string): Promise<{ key: string; binding: string }> {
  return { key: await hashSecret(`panel-attempt\n${token}`), binding: await hashSecret(`panel\n${origin}\n${token}`) };
}

function attemptToken(body: Record<string, unknown>): string | null {
  const { attempt } = body;
  return typeof attempt === "string" && attempt !== "" && attempt.length <= 200 ? attempt : null;
}

function panelRoute(
  path: string,
  handler: (ctx: ActionCtx, origin: string, body: Record<string, unknown>, mode: SignInMode) => Promise<Response>,
) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const origin = request.headers.get("Origin");
      if (!isPanelOrigin(origin)) return refusedOrigin();
      const mode = signInMode();
      if (mode === "unavailable") return panelError(origin, 503, "unavailable", "This Critiqs deployment can't send sign-in codes yet.");
      const text = await readLimited(request, PANEL_BODY_LIMIT);
      let body: unknown = null;
      try {
        if (text !== null) body = JSON.parse(text);
      } catch {}
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return panelError(origin, 400, "invalid-request", "This sign-in request is incomplete.");
      }
      return await handler(ctx, origin, body as Record<string, unknown>, mode);
    }),
  });
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async (_, request) => {
      const origin = request.headers.get("Origin");
      return isPanelOrigin(origin) ? new Response(null, { status: 204, headers: panelHeaders(origin) }) : refusedOrigin();
    }),
  });
}


/** The body as text, or null once it is longer than `limit` bytes; stops reading there. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Whether a panel can sign in from here: answered only to Critiqs's own
 * origins (a browser hides it from any other page), and 503 where the service
 * can't send codes. A POST, since browsers send `Origin` with every POST, even
 * from the sign-in service's own origin.
 */
panelRoute("/auth/panel/status", async (_, origin) => Response.json({ ready: true }, { headers: panelHeaders(origin) }));

panelRoute("/auth/panel/email", async (ctx, origin, body, mode) => {
  const email = typeof body.email === "string" ? normalizeEmail(body.email.slice(0, 300)) : null;
  if (email === null) return panelError(origin, 400, "invalid-email", "Enter a valid email address.");
  let token: string;
  if (body.attempt === undefined) {
    token = randomSecret();
    const { key, binding } = await panelAttempt(origin, token);
    const start = await ctx.runMutation(internal.signIn.startAttempt, { key, origin, clientState: "panel", bindingHash: binding, panel: true, email });
    if (!start.allowed) {
      const message = start.scope === "email"
        ? "Too many codes were sent to this address recently. Try again later."
        : start.scope === "codes"
          ? "Too many codes were sent recently. Try again later."
          : "Too many sign-in requests. Wait a minute and try again.";
      return panelError(origin, 429, "rate-limited", message, { retryAfter: start.retryAfter }, { "Retry-After": String(start.retryAfter) });
    }
  } else {
    const given = attemptToken(body);
    if (given === null) return panelError(origin, 400, "invalid-request", "This sign-in request is incomplete.");
    token = given;
  }
  const sent = await sendCode(ctx, { ...(await panelAttempt(origin, token)), email, mode, panel: true });
  switch (sent.status) {
    case "expired":
      return panelExpired(origin);
    case "locked":
      return panelLocked(origin);
    case "too-many-codes":
      return panelError(origin, 429, "too-many-codes", "No more codes can be sent for this sign-in. Use the latest code, or start again.");
    case "rate-limited":
      return panelError(origin, 429, "rate-limited", "Too many codes were sent recently. Wait a few minutes before asking for another.",
        { retryAfter: sent.retryAfter }, { "Retry-After": String(sent.retryAfter) });
    case "send-failed":
      return panelError(origin, 502, "send-failed", "The code couldn't be sent. Check the address, or try again in a minute.");
    case "sent":
      return Response.json(
        { attempt: token, email, ...(mode === "development" ? { developmentCode: sent.code } : {}) },
        { headers: panelHeaders(origin) },
      );
  }
});

panelRoute("/auth/panel/code", async (ctx, origin, body) => {
  const token = attemptToken(body);
  if (token === null) return panelError(origin, 400, "invalid-request", "This sign-in request is incomplete.");
  const { key, binding } = await panelAttempt(origin, token);
  const context = await ctx.runMutation(internal.signIn.codeContext, { key, bindingHash: binding, panel: true });
  if (context === null) return panelExpired(origin);
  const typed = typeof body.code === "string" ? cleanCode(body.code.slice(0, 20)) : "";
  // A malformed code uses up no guess.
  if (!/^\d{6}$/.test(typed)) return panelError(origin, 400, "invalid-code", "Enter the 6-digit code from the email.");
  const digest = await codeDigest(codeSecret(), { attempt: key, email: context.email, generation: context.generation, code: typed });
  const result = await ctx.runMutation(internal.signIn.verifyCode, {
    key,
    bindingHash: binding,
    generation: context.generation,
    digest,
    // Panels have no allow page, so this token is never used.
    consentHash: await hashSecret(randomSecret()),
    panel: true,
  });
  switch (result.status) {
    case "expired":
      return panelExpired(origin);
    case "locked":
      return panelLocked(origin);
    case "code-expired":
      return panelError(origin, 400, "code-expired", "That code has expired. Send a new code.");
    case "wrong":
      return panelError(origin, 400, "wrong-code",
        `That code doesn't match. ${result.guessesLeft} ${result.guessesLeft === 1 ? "try" : "tries"} left.`,
        { guessesLeft: result.guessesLeft });
    case "needs-name":
      return Response.json({ status: "needs-name" }, { headers: panelHeaders(origin) });
    case "verified":
      return await finishPanelSignIn(ctx, origin, key, binding);
  }
});

panelRoute("/auth/panel/name", async (ctx, origin, body) => {
  const token = attemptToken(body);
  if (token === null) return panelError(origin, 400, "invalid-request", "This sign-in request is incomplete.");
  const { key, binding } = await panelAttempt(origin, token);
  const result = await ctx.runMutation(internal.signIn.registerReviewer, {
    key,
    bindingHash: binding,
    name: typeof body.name === "string" ? body.name.slice(0, 200) : "",
    consentHash: await hashSecret(randomSecret()),
    panel: true,
  });
  if (result.status === "expired") return panelExpired(origin);
  if (result.status === "invalid-name") return panelError(origin, 400, "invalid-name", "Use a name of 1 to 60 characters.");
  return await finishPanelSignIn(ctx, origin, key, binding);
});

function panelLocked(origin: string): Response {
  return panelError(origin, 429, "locked", "This sign-in is locked after too many wrong codes. Start again.");
}

/** Starts the session and answers with its tokens. Critiqs's own origins need no grant. */
async function finishPanelSignIn(ctx: ActionCtx, origin: string, key: string, binding: string): Promise<Response> {
  const refreshToken = randomSecret();
  const result = await ctx.runMutation(internal.signIn.finishAttempt, {
    key,
    bindingHash: binding,
    consentHash: null,
    allow: true,
    refreshHash: await hashSecret(refreshToken),
    panel: true,
  });
  // Also when the origin stopped being one of Critiqs's own since the attempt began.
  if (result?.profile == null) return panelExpired(origin);
  const { profile, endsAt } = result;
  const { accessToken, expiresAt } = await issueAccessToken(signInUrl(), profile, origin, Date.now(), endsAt);
  return Response.json(
    {
      status: "signed-in",
      accessToken,
      refreshToken,
      expiresAt,
      sessionEndsAt: endsAt,
      reviewer: { id: profile.subject, name: profile.name, email: profile.email },
    },
    { headers: panelHeaders(origin) },
  );
}

// ---------------------------------------------------------------------------
// Mute and unsubscribe links from mention emails

http.route({
  path: "/notifications/preferences",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const scope = await readPreferenceToken(await linkSecret(ctx), token);
    if (scope === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    return preferencePage(
      token,
      scope.projectId === null
        ? "Stop all emails from Critiqs, for mentions and replies? You can turn them back on from the account menu."
        : "Mute emails from this project? You can unmute it from the account menu.",
    );
  }),
});

http.route({
  path: "/notifications/preferences",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = new URLSearchParams(await request.text()).get("token") ?? "";
    const scope = await readPreferenceToken(await linkSecret(ctx), token);
    if (scope === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    await ctx.runMutation(internal.notifications.applyLink, scope);
    return messagePage(
      "Done",
      scope.projectId === null ? "You won't get emails from Critiqs any more." : "This project's emails are muted.",
      200,
    );
  }),
});

// ---------------------------------------------------------------------------
// Report links from developer setup emails

http.route({
  path: REPORT_PATH,
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const sendId = await readReportToken(await linkSecret(ctx), token);
    if (sendId === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    return reportPage(token, REPORT_QUESTION);
  }),
});

http.route({
  path: REPORT_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = new URLSearchParams(await request.text()).get("token") ?? "";
    const sendId = await readReportToken(await linkSecret(ctx), token);
    if (sendId === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    await ctx.runMutation(internal.onboarding.reportUnwantedEmail, { sendId });
    return messagePage("Done", REPORT_DONE, 200);
  }),
});

export default http;
