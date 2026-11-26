/**
 * Critiqs's setup steps, shared by `critiqs init`, `critiqs doctor`, and the MCP
 * server so people and coding agents set up Critiqs the same way. Dependency-free
 * so it runs under Node and Bun without a build.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseWiring, connectionSettings, envTargetOf, isFile, packageOf, quoted, readLocalValue, readUsage, shown, UNRECOGNIZED, workspaceApps, workspaceRefusal, writeConnection } from "./app.mjs";
import { checkWritable, describeApp } from "./env.mjs";
import { isValidProjectId } from "./init.mjs";

/** Critiqs Cloud's deployment, the component's default backend. Matches `HOSTED_BACKEND_URL`. */
export const CLOUD_BACKEND_URL = "https://brazen-snail-591.convex.cloud";
/** The backend version this package needs. Matches `BACKEND_PROTOCOL`. */
export const BACKEND_PROTOCOL = 5;
/** The sign-in service version this package needs, unchanged since protocol 4. Matches `SIGN_IN_PROTOCOL`. */
export const SIGN_IN_PROTOCOL = 4;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class SetupError extends Error {}

/** The HTTP address Convex pairs with a deployment URL. */
export function siteUrlOf(backendUrl) {
  const url = new URL(backendUrl);
  // A server in the host app answers at the path it is mounted at.
  if (url.pathname !== "/" && !url.hostname.endsWith(".convex.cloud")) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (url.hostname.endsWith(".convex.cloud")) url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
  else if (url.port !== "") url.port = String(Number(url.port) + 1);
  return url.origin;
}

/**
 * Whether a URL's host name is this computer: exactly `localhost`, which Node
 * resolves to a loopback address, or a literal loopback address (127.0.0.0/8,
 * [::1]). Other names, `.localhost` ones included, depend on name resolution.
 */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether `site` is the address Convex Cloud pairs with the deployment at
 * `backend` (both origins): `<name>.convex.cloud` with `<name>.convex.site`.
 * Any other pair is a guess, so it is shown when signing in.
 */
export function isConvexCloudPair(backend, site) {
  const deployment = /^https:\/\/([a-z0-9-]+)\.convex\.cloud$/.exec(backend);
  return deployment !== null && site === `https://${deployment[1]}.convex.site`;
}

/** Raised when a request carrying a sign-in is answered with a redirect, which isn't followed. */
export class RedirectRefusedError extends SetupError {}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Sends a request that carries a sign-in (a token, refresh token, or device
 * secret) without following redirects: a 307 or 308 would send the same body
 * and headers to another address, even over plain http. A redirect is refused
 * with a message naming where it came from; other failures throw as `fetchFn` does.
 */
export async function sendCredential(fetchFn, url, init = {}) {
  const refused = () =>
    new RedirectRefusedError(`${new URL(url).origin} answered with a redirect, so Critiqs didn't follow it or send the sign-in anywhere else.`);
  let response;
  try {
    response = await fetchFn(url, { ...init, redirect: "error" });
  } catch (error) {
    // Node says "unexpected redirect"; Bun says "UnexpectedRedirect".
    if (/redirect/i.test(`${error?.message} ${error?.cause?.message} ${error?.code}`)) throw refused();
    throw error;
  }
  if (response.type === "opaqueredirect" || REDIRECTS.has(response.status)) throw refused();
  return response;
}

/**
 * Refuses an address a sign-in token must not travel to: anything but HTTPS,
 * except plain HTTP to this computer.
 */
export function requireSecureTokenTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SetupError(`${url} isn't a web address.`);
  }
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) return;
  throw new SetupError(
    `${parsed.origin} doesn't use HTTPS, so Critiqs won't send a sign-in to it. Only this computer (localhost, 127.0.0.1, or [::1]) may use plain http.`,
  );
}

async function getJson(url, fetchFn, unreachable) {
  let response;
  try {
    response = await fetchFn(url);
  } catch {
    throw new SetupError(`${unreachable}.`);
  }
  if (!response.ok) throw new SetupError(`${unreachable} (${response.status}).`);
  return await response.json();
}

/**
 * The backend's sign-in service, after checking both are recent enough for
 * this package, as the component does.
 */
export async function resolveBackend(backendUrl, { fetchFn = fetch } = {}) {
  const url = backendUrl.replace(/\/$/, "");
  const siteUrl = siteUrlOf(url);
  const config = await getJson(`${siteUrl}/critiqs/config`, fetchFn, `Can't reach the Critiqs backend at ${url}`);
  if (typeof config.protocol !== "number" || config.protocol < BACKEND_PROTOCOL) {
    throw new SetupError(
      url === CLOUD_BACKEND_URL
        ? "Critiqs Cloud isn't ready for this version of Critiqs yet."
        : `The Critiqs backend at ${url} runs an older version. Deploy the current Critiqs functions to it.`,
    );
  }
  const signInUrl = String(config.signInUrl).replace(/\/$/, "");
  const transport = config.transport === "http" ? "http" : "convex";
  if (transport === "convex" && new URL(signInUrl).origin !== siteUrl) {
    const signIn = await getJson(`${new URL(signInUrl).origin}/critiqs/config`, fetchFn, `Can't reach Critiqs's sign-in service at ${signInUrl}`);
    if (typeof signIn.protocol !== "number" || signIn.protocol < SIGN_IN_PROTOCOL) {
      throw new SetupError(`Critiqs's sign-in service at ${signInUrl} isn't ready for this version of Critiqs yet.`);
    }
  }
  return { backendUrl: url, siteUrl, signInUrl, transport };
}

// ---------------------------------------------------------------------------
// Signing in from the command line

/**
 * Tries to open a web address in the default browser; the address is also
 * printed, so failure is fine. Only http and https addresses are opened, and
 * never through a shell: the launcher gets the address as one argument.
 */
export function openBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  let address;
  try {
    address = new URL(url);
  } catch {
    return;
  }
  if (address.protocol !== "https:" && address.protocol !== "http:") return;
  const href = address.href;
  const [command, args] =
    platform === "darwin"
      ? ["open", [href]]
      : platform === "win32"
        ? [`${env.SystemRoot || "C:\\Windows"}\\System32\\rundll32.exe`, ["url.dll,FileProtocolHandler", href]]
        : ["xdg-open", [href]];
  try {
    const child = spawnFn(command, args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function bridgePage(signInUrl, key, backendUrl) {
  const data = JSON.stringify({ signInUrl, key }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to set up Critiqs</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}
button{font:inherit;font-weight:600;background:#0d63f3;color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;cursor:pointer}
.note{color:#555}</style></head><body>
<h1>Set up Critiqs</h1>
<p id="status">Sign in so the command line can create your Critiqs project. Sign-in opens in a small window.</p>
<p><button id="go" type="button">Sign in to Critiqs</button></p>
<p class="note">Signing in from <strong>${escapeHtml(signInUrl)}</strong>${backendUrl ? ` for the Critiqs backend at <strong>${escapeHtml(new URL(backendUrl).origin)}</strong>` : ""}. Continue only if you recognize ${backendUrl ? "both" : "it"}. This page only works on this computer.</p>
<script>
const { signInUrl, key } = ${data};
const status = document.getElementById("status");
const button = document.getElementById("go");
button.addEventListener("click", () => {
  const state = crypto.randomUUID();
  const url = new URL("/auth/start", signInUrl);
  url.search = new URLSearchParams({ origin: location.origin, state }).toString();
  const popup = window.open(url, "critiqs-sign-in", "popup,width=480,height=640");
  if (popup === null) { status.textContent = "Your browser blocked the sign-in window. Allow pop-ups for this page and try again."; return; }
  const onMessage = async (event) => {
    const data = event.data;
    if (event.source !== popup || event.origin !== new URL(signInUrl).origin || data?.type !== "critiqs:sign-in" || data.state !== state) return;
    window.removeEventListener("message", onMessage);
    if (typeof data.accessToken !== "string") { status.textContent = "Sign-in was cancelled. Try again."; return; }
    const response = await fetch("/done/" + key, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: data.accessToken, refreshToken: data.refreshToken }) });
    button.hidden = true;
    status.textContent = response.ok ? "Signed in. Return to your terminal or coding agent; you can close this page." : "Setup stopped waiting. Run it again.";
  };
  window.addEventListener("message", onMessage);
});
</script></body></html>`;
}

/**
 * Serves a page on this computer that signs in through Critiqs's usual sign-in
 * window, then hands the tokens to this process. Sign-in sees the page as a
 * site at a loopback address, so it asks the person to allow it.
 * Returns the page's URL and a promise for the tokens; `close` stops waiting.
 */
export async function startBrowserSignIn({ signInUrl, backendUrl = null, timeoutMs = 10 * 60_000, port = 4874 } = {}) {
  const key = randomBytes(24).toString("hex");
  let settle;
  const tokens = new Promise((resolveTokens, reject) => {
    settle = { resolve: resolveTokens, reject };
  });
  let done = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === `/${key}`) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end(bridgePage(signInUrl, key, backendUrl));
      return;
    }
    if (request.method === "POST" && url.pathname === `/done/${key}` && !done) {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 20_000) request.destroy();
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") throw new Error("Bad tokens");
          done = true;
          response.writeHead(204);
          response.end();
          settle.resolve({ accessToken: parsed.accessToken, refreshToken: parsed.refreshToken });
          close();
        } catch {
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const listen = (candidate) =>
    new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(candidate, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  // A fixed port lets the sign-in window remember that this page was allowed.
  await listen(port).catch(() => listen(0));
  const timer = setTimeout(() => {
    settle.reject(new SetupError("Sign-in took too long. Run setup again."));
    close();
  }, timeoutMs);
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/${key}`,
    tokens,
    close: () => {
      if (!done) settle.reject(new SetupError("Setup stopped waiting for sign-in."));
      close();
    },
  };
}

/**
 * Whether this process probably can't open a browser the person sees: a
 * remote shell, or Linux without a desktop session. Setup then asks for
 * approval from another device, where the sign-in service supports it.
 */
export function isHeadless(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CODESPACES || env.GITPOD_WORKSPACE_ID) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Critiqs Cloud's sign-in service: Critiqs Cloud's own site address. */
export const CLOUD_SIGN_IN_URL = siteUrlOf(CLOUD_BACKEND_URL);
/** Critiqs Cloud's backend, and where it serves screenshots and page copies, as origins. */
export const CLOUD_BINDING = Object.freeze({ backend: new URL(CLOUD_BACKEND_URL).origin, site: new URL(CLOUD_SIGN_IN_URL).origin });

/**
 * Whether an approval is Critiqs Cloud's backend and site through Critiqs
 * Cloud's own sign-in service: the one approval that may go ahead with a
 * sign-in service too old to say what its approval page names.
 */
export function isLegacyCloudApproval(signInUrl, binding) {
  return signInUrl === CLOUD_SIGN_IN_URL && binding.backend === CLOUD_BINDING.backend && binding.site === CLOUD_BINDING.site;
}

/**
 * What a sign-in service's answer says its approval page names: `null` when
 * it says nothing (an older service), `{ backend, site }` as origins when it
 * names both, or `{ invalid: true }` when it names only one, or something that
 * isn't an http or https origin.
 */
function reportedShown(body) {
  const absent = (value) => value === undefined || value === null;
  if (absent(body?.backend) && absent(body?.site)) return null;
  const origin = (value) => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : null;
    } catch {
      return null;
    }
  };
  const backend = origin(body.backend);
  const site = origin(body.site);
  return backend === null || site === null ? { invalid: true } : { backend, site };
}

/** A binding as people read it: the backend, and its site unless Convex Cloud pairs the two. */
function describeBinding(binding) {
  return isConvexCloudPair(binding.backend, binding.site) ? binding.backend : `${binding.backend} (screenshots and page copies from ${binding.site})`;
}

/**
 * Why an approval for `binding` can't go ahead, given what the sign-in service
 * said its approval page names when it started (`started`) and, once
 * approved, with the tokens (`granted`, `undefined` before then), or null when
 * it can. A service must name exactly this backend and its site both times.
 * Only the legacy Critiqs Cloud approval may come from a service that names
 * nothing either time.
 */
export function approvalRefusal(signInUrl, binding, started, granted) {
  const where = describeBinding(binding);
  const compare = (shown) => {
    if (shown.invalid) {
      return `Critiqs's sign-in service at ${signInUrl} didn't say clearly which addresses its approval page names, so this sign-in for ${where} was stopped.`;
    }
    if (shown.backend === binding.backend && shown.site === binding.site) return null;
    return `Critiqs's sign-in service at ${signInUrl} names ${describeBinding(shown)} on its approval page, not ${where}, so this sign-in was stopped.`;
  };
  if (started === null) {
    if (!isLegacyCloudApproval(signInUrl, binding)) {
      return (
        `Critiqs's sign-in service at ${signInUrl} runs an older version that doesn't confirm its approval page names the backend, ` +
        `so this computer won't sign in through it for ${where}: the person approving couldn't check the address. ` +
        "Its operator needs to deploy the current Critiqs backend."
      );
    }
    // An older Critiqs Cloud names nothing with the tokens either; anything it does name must match.
    return granted === undefined || granted === null ? null : compare(granted);
  }
  const atStart = compare(started);
  if (atStart !== null || granted === undefined) return atStart;
  if (granted === null) {
    return `Critiqs's sign-in service at ${signInUrl} named ${where} when the approval started, but didn't confirm it with the approval, so this sign-in was stopped.`;
  }
  return compare(granted);
}

/**
 * Asks the sign-in service to approve this setup from any browser, on any
 * device: the person opens `url`, types `userCode`, signs in, and approves.
 * Meanwhile this process polls with a device secret it never shows. Resolves
 * `tokens` with a short-lived access token (no refresh token) once approved.
 * With `keepSignedIn`, the approval also starts a session for this computer
 * (`critiqs sign-in`), and `tokens` includes its refresh token.
 *
 * `backendUrl` is the backend the tokens are for. The approval page names it
 * and where it serves screenshots and page copies (`binding`), and the service
 * must say so when the approval starts and again with the tokens, as
 * `approvalRefusal` checks; otherwise it stops before a code is shown, or
 * ends the session the approval started and keeps nothing. `confirmed` is
 * false only for the legacy Critiqs Cloud approval, whose page doesn't name
 * the backend.
 *
 * `url` is always this sign-in service's own `/auth/device` page, whatever
 * address its answer suggests. Refuses clearly when the service doesn't offer
 * this yet.
 */
export async function startRemoteSignIn({ signInUrl, backendUrl, fetchFn = fetch, sleep = wait, now = Date.now, keepSignedIn = false } = {}) {
  requireSecureTokenTarget(signInUrl);
  if (typeof backendUrl !== "string" || backendUrl === "") throw new SetupError("Name the backend the approval is for.");
  const service = new URL(signInUrl).origin;
  const binding = { backend: new URL(backendUrl).origin, site: new URL(siteUrlOf(backendUrl)).origin };
  const config = await getJson(`${service}/critiqs/config`, fetchFn, `Can't reach Critiqs's sign-in service at ${signInUrl}`);
  if (keepSignedIn && config.deviceSessions !== true) {
    throw new SetupError(
      `Critiqs's sign-in service at ${signInUrl} runs an older version that can't keep this computer signed in with a code yet. ` +
        "Its operator needs to deploy the current Critiqs backend; until then, read feedback in the prototype's Critiqs sidebar.",
    );
  }
  if (config.deviceSignIn !== true) {
    throw new SetupError(
      `Critiqs's sign-in service at ${signInUrl} doesn't support approving setup from another device yet. ` +
        "Run setup where a browser can open on the same computer (with --browser), or create the project in the matching prototype's Critiqs sidebar, then run npx critiqs init <projectId> to write its ID, keeping the backend.",
    );
  }
  let response;
  try {
    response = await sendCredential(fetchFn, `${signInUrl}/auth/device/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Older sign-in services ignore `backend` and `site`: their approval page doesn't name them, and their answer doesn't repeat them.
      body: JSON.stringify({ ...(keepSignedIn ? { keepSignedIn: true } : {}), ...binding }),
    });
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(`Can't reach Critiqs's sign-in service at ${signInUrl}.`);
  }
  // `critiqs sign-in` uses this approval too; its messages name it, not setup.
  const again = keepSignedIn ? "Run sign-in again" : "Run setup again";
  if (response.status === 429) {
    throw new SetupError(`Too many ${keepSignedIn ? "sign-ins" : "setups"} are waiting for approval right now. Try again in a minute.`);
  }
  if (!response.ok) throw new SetupError(`Critiqs's sign-in service can't start an approval (${response.status}).`);
  const started = await response.json();
  // Checked before a code is shown, so no one approves what the page doesn't name.
  const startedShown = reportedShown(started);
  const refused = approvalRefusal(signInUrl, binding, startedShown, undefined);
  if (refused !== null) throw new SetupError(refused);
  // Shown to the person as it is, so it must look like a code.
  if (typeof started.userCode !== "string" || !/^[A-Z0-9]{2,16}(?:-[A-Z0-9]{2,16})?$/.test(started.userCode)) {
    throw new SetupError(`Critiqs's sign-in service at ${signInUrl} didn't send a code that can be shown. ${again}.`);
  }
  let stopped = false;
  const expiresAt = now() + started.expiresIn * 1000;
  const tokens = (async () => {
    let interval = Math.max(1, Number(started.interval) || 5);
    for (;;) {
      await sleep(interval * 1000);
      if (stopped) throw new SetupError(keepSignedIn ? "Sign-in stopped waiting for approval." : "Setup stopped waiting for approval.");
      if (now() > expiresAt) throw new SetupError(`The ${keepSignedIn ? "sign-in" : "setup"} code expired before it was approved. ${again}.`);
      let answer;
      try {
        const polled = await sendCredential(fetchFn, `${signInUrl}/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: started.deviceCode }),
        });
        answer = { status: polled.status, body: await polled.json() };
      } catch (error) {
        if (error instanceof SetupError) throw error;
        // The network may come back before the code expires.
        continue;
      }
      if (answer.status === 200 && typeof answer.body.accessToken === "string") {
        const refreshToken = typeof answer.body.refreshToken === "string" ? answer.body.refreshToken : null;
        // What the approval page named must be what was confirmed at the start.
        const mismatch = approvalRefusal(signInUrl, binding, startedShown, reportedShown(answer.body));
        if (mismatch !== null) {
          if (refreshToken !== null) await signOut(signInUrl, refreshToken, { origin: service, fetchFn });
          throw new SetupError(`${mismatch} ${keepSignedIn ? "This computer didn't keep the sign-in." : "Nothing was created."}`);
        }
        if (keepSignedIn && refreshToken === null) {
          throw new SetupError("Critiqs's sign-in service approved this computer without keeping it signed in. Run sign-in again.");
        }
        return {
          accessToken: answer.body.accessToken,
          expiresAt: typeof answer.body.expiresAt === "number" ? answer.body.expiresAt : now() + 10 * 60_000,
          refreshToken: keepSignedIn ? refreshToken : null,
          sessionEndsAt: keepSignedIn && typeof answer.body.sessionEndsAt === "number" ? answer.body.sessionEndsAt : null,
          reviewer: answer.body.reviewer ?? null,
        };
      }
      const error = answer.body?.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval = Math.max(interval + 5, Number(answer.body.interval) || 0);
        continue;
      }
      if (error === "access_denied") throw new SetupError(`${keepSignedIn ? "Sign-in" : "Setup"} was denied in the browser. ${again} to retry.`);
      if (error === "expired_token") throw new SetupError(`The ${keepSignedIn ? "sign-in" : "setup"} code expired before it was approved. ${again}.`);
      throw new SetupError(`The ${keepSignedIn ? "sign-in" : "setup"} approval is no longer valid. ${again}.`);
    }
  })();
  tokens.catch(() => {});
  return {
    // Built here, never taken from the answer: the page people are sent to is this service's own.
    url: `${service}/auth/device`,
    userCode: started.userCode,
    expiresAt,
    signInUrl,
    binding,
    // False only for the legacy Critiqs Cloud approval, whose page doesn't name the backend.
    confirmed: startedShown !== null,
    tokens,
    close: () => {
      stopped = true;
    },
  };
}

/** Calls a Convex function over Convex's HTTP API as the signed-in person. */
export async function callConvex(backendUrl, kind, path, args, accessToken, { fetchFn = fetch } = {}) {
  requireSecureTokenTarget(backendUrl);
  let response;
  try {
    response = await sendCredential(fetchFn, `${backendUrl}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ path, args, format: "json" }),
    });
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(`Can't reach the Critiqs backend at ${backendUrl}.`);
  }
  const result = await response.json().catch(() => null);
  if (result?.status === "success") return result.value;
  const message = result?.errorData?.message ?? result?.errorMessage ?? `The Critiqs backend answered ${response.status}.`;
  throw new SetupError(String(message));
}

/** Creates a project as the signed-in person; returns its ID. */
export async function createProject({ backendUrl, accessToken, name, reviewUrl = null, fetchFn = fetch }) {
  await callConvex(backendUrl, "mutation", "users:sync", {}, accessToken, { fetchFn });
  return await callConvex(backendUrl, "mutation", "projects:create", { name, reviewUrl }, accessToken, { fetchFn });
}

/** Complete discovery, or an error: partial results cannot establish that a project is absent. */
export async function listMyProjects({ backendUrl, accessToken, fetchFn = fetch }) {
  const projects = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    // The shared Convex/SQLite contract permits at most 40 items per page.
    const result = await callConvex(backendUrl, "query", "projects:listMine", { paginationOpts: { numItems: 40, cursor } }, accessToken, { fetchFn });
    if (!Array.isArray(result?.page) || typeof result.isDone !== "boolean") throw new SetupError("The backend returned an invalid project page.");
    projects.push(...result.page);
    if (result.isDone) return projects;
    if (typeof result.continueCursor !== "string" || result.continueCursor === "" || seen.has(result.continueCursor)) {
      throw new SetupError("Project discovery couldn't finish because its cursor didn't advance.");
    }
    seen.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new SetupError("Project discovery exceeded its page budget without finishing. Choose an existing project ID, or explicitly create a new project with --new-project.");
}

/**
 * Ends the command line's sign-in session; it is only needed to create the
 * project. `origin` is the sign-in page's, which the session belongs to.
 */
export async function signOut(signInUrl, refreshToken, { origin, fetchFn = fetch } = {}) {
  // Best effort: a redirect is refused, so the refresh token goes nowhere else.
  await sendCredential(fetchFn, `${signInUrl}/auth/sign-out`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// A team's own Convex deployment

/** The `convex` package this package depends on. */
function convexPackage() {
  const require = createRequire(join(PACKAGE_ROOT, "package.json"));
  const manifest = require.resolve("convex/package.json");
  return { cli: join(dirname(manifest), "bin", "main.js"), version: require(manifest).version };
}

function runConvex(args, { cwd, env, input }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [convexPackage().cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolveRun(output) : reject(new SetupError(`convex ${args[0]} failed:\n${output.trim()}`))));
    child.stdin.end(input ?? "");
  });
}

/**
 * The deployment a key or self-hosted address names: a production deploy key
 * (`prod:<name>|…`) from the Convex dashboard, or a self-hosted Convex backend.
 */
export function targetDeployment(env) {
  if (env.CONVEX_DEPLOYMENT_TOKEN && !env.CONVEX_DEPLOY_KEY) {
    throw new SetupError("Set CONVEX_DEPLOY_KEY rather than CONVEX_DEPLOYMENT_TOKEN, so it's clear which deployment Critiqs deploys to.");
  }
  if ((env.CONVEX_SELF_HOSTED_URL || env.CONVEX_SELF_HOSTED_ADMIN_KEY) && env.CONVEX_DEPLOY_KEY) {
    throw new SetupError("Set either CONVEX_DEPLOY_KEY, or CONVEX_SELF_HOSTED_URL with CONVEX_SELF_HOSTED_ADMIN_KEY, not both.");
  }
  if (env.CONVEX_SELF_HOSTED_URL && env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    return { backendUrl: env.CONVEX_SELF_HOSTED_URL.replace(/\/$/, ""), env: { CONVEX_SELF_HOSTED_URL: env.CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY: env.CONVEX_SELF_HOSTED_ADMIN_KEY } };
  }
  const key = env.CONVEX_DEPLOY_KEY ?? "";
  const match = /^prod:([a-z0-9-]+)\|/.exec(key);
  if (match === null) {
    throw new SetupError(
      key === ""
        ? "Set CONVEX_DEPLOY_KEY to a production deploy key from your Convex project's settings."
        : "CONVEX_DEPLOY_KEY must be a production deploy key (it starts with prod:).",
    );
  }
  return { backendUrl: `https://${match[1]}.convex.cloud`, env: { CONVEX_DEPLOY_KEY: key } };
}

/** The environment for the Convex CLI: only the chosen deployment's credentials, since the CLI would prefer any other it finds. */
export function convexEnv(target, base = process.env) {
  const env = { ...base };
  for (const name of [
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    // Convex treats this as another name for the deploy key, and prefers it.
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_URL",
  ]) {
    delete env[name];
  }
  return { ...env, ...target.env };
}

/**
 * Deploys Critiqs's functions to a team's own Convex deployment and sets the
 * only settings it needs: which sign-in service to trust (Critiqs Cloud's
 * unless `signInUrl` names another), and Resend's key and sender for mention
 * emails when given. Secrets go to Convex through standard input, never
 * command arguments. Returns the deployment URL.
 */
export async function deployOwnConvex({ env = process.env, signInUrl, resendApiKey, emailFrom, log = () => {} }) {
  const target = targetDeployment(env);
  const bundle = join(PACKAGE_ROOT, "dist", "backend", "convex");
  if (!existsSync(bundle)) throw new SetupError("This copy of critiqs has no backend functions. Build the package first.");
  const issuer = (signInUrl ?? (await resolveBackend(CLOUD_BACKEND_URL)).signInUrl).replace(/\/$/, "");
  // Inside the package, so the functions resolve `convex` from its dependencies.
  const work = mkdtempSync(join(PACKAGE_ROOT, ".deploy-"));
  const childEnv = convexEnv(target);
  try {
    cpSync(bundle, join(work, "convex"), { recursive: true });
    // The Convex CLI expects an app folder; `convex` itself resolves from this package's dependencies.
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "critiqs-backend", private: true, type: "module", dependencies: { convex: convexPackage().version } }));
    log("Configuring the deployment…");
    await runConvex(["env", "set", "CRITIQS_AUTH_ISSUER"], { cwd: work, env: childEnv, input: issuer });
    if (resendApiKey) await runConvex(["env", "set", "RESEND_API_KEY"], { cwd: work, env: childEnv, input: resendApiKey });
    if (emailFrom) await runConvex(["env", "set", "CRITIQS_EMAIL_FROM"], { cwd: work, env: childEnv, input: emailFrom });
    log("Deploying Critiqs's functions…");
    await runConvex(["deploy", "--typecheck", "disable", "--codegen", "disable", "-y"], { cwd: work, env: childEnv });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  await resolveBackend(target.backendUrl);
  return target.backendUrl;
}

// ---------------------------------------------------------------------------
// Checking a setup

/** What doctor did and didn't do, so a pass is read for what it proves. */
export const DOCTOR_NOTE =
  "Doctor reads the code and the backend's own health report. It doesn't send a sign-in code or email, upload a screenshot, or post a comment: " +
  '"configured" checks mean the settings are there, and "observed" checks report what the backend has actually done.';

/**
 * Whether an address only opens on this computer or a private network, such as
 * localhost, a LAN address, or a Tailscale address (`*.ts.net`, 100.64.0.0/10).
 * The same rule as `isPrivateReviewAddress` in the package; a test keeps them
 * equal. An address not recognized as private isn't thereby known to be public.
 */
export function isLocalAddress(address) {
  let host;
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host.includes(":")) return isPrivateIpv6(host);
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isPrivateIpv4(host);
  return host === "localhost" || !host.includes(".") || /\.(localhost|local|internal|home\.arpa|ts\.net)$/.test(host);
}

function isPrivateIpv4(host) {
  const [a, b] = host.split(".").map(Number);
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

function isPrivateIpv6(host) {
  if (host === "::" || host === "::1") return true;
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = Number.parseInt(host.split(":")[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/**
 * Checks that the prototype's Critiqs setup works, not only that it connects:
 * the component and its settings, the backend and its version, sign-in, the
 * project, email, and that scheduled mention emails are going out.
 * Each check is pass, warn, fail, or info (an optional feature that is off),
 * with what to do. `stage` says which part of setup it is about, and `basis`
 * whether it reports configuration or something the backend observed.
 */
/** A project limited to its organization's members: the backend tells doctor, which doesn't sign in, nothing about it. */
function restrictedProject(project) {
  return `doctor can't check ${project}: the backend describes projects limited to their organization only to signed-in members. Check it in the Critiqs sidebar's Project setup.`;
}

export async function doctor({ root, cwd = root, backendUrl: chosenBackend, fetchFn = fetch, now = Date.now(), env: shell = process.env, envFile = null }) {
  const checks = [];
  const add = (status, name, detail, stage, basis = "configuration") => checks.push({ status, name, detail, stage, basis });
  let apps = null;
  try {
    apps = workspaceApps(root);
  } catch {}
  if (apps !== null && apps.length > 0) {
    const commands = apps.map((dir) => `  npx critiqs doctor --dir ${quoted(shown(cwd, dir))}`).join("\n");
    add("fail", "Component", `${shown(cwd, root)} is a workspace; each app has its own Critiqs setup. Check one app:\n${commands}`, "code");
    return checks;
  }
  let located;
  try {
    located = readUsage(root, cwd);
  } catch {
    located = { error: `Couldn't read the code in ${shown(cwd, root)}.` };
  }
  if ("error" in located) {
    add("fail", "Component", `${located.error}${located.missing ? " Run npx critiqs init to add it." : ""}`, "code");
    return checks;
  }
  const props = located.usage;
  const at = `${shown(cwd, props.file)}:${props.line}`;
  add("pass", "Component", `Critiqs is set up at ${at}.`, "code");

  let backendUrl = CLOUD_BACKEND_URL;
  if (chosenBackend !== undefined) {
    backendUrl = chosenBackend;
  } else if (props.backend?.kind === "expression") {
    add("warn", "Backend", `${at} sets backend from code, so doctor checks Critiqs Cloud. Run doctor with --backend <url> to check another.`, "service");
  } else if (props.backend?.kind === "literal" && props.backend.value.startsWith("/")) {
    add("fail", "Backend", `${at} uses Critiqs inside your app's server at ${props.backend.value}. Start the app and run doctor with --backend http://localhost:<port>${props.backend.value}.`, "service");
    return checks;
  } else if (props.backend?.kind === "literal") {
    backendUrl = props.backend.value;
  }
  let resolved;
  try {
    resolved = await resolveBackend(backendUrl, { fetchFn });
    add("pass", "Backend", `${resolved.backendUrl === CLOUD_BACKEND_URL ? "Critiqs Cloud" : resolved.backendUrl} answered and runs a current version.`, "service", "observed");
  } catch (error) {
    add("fail", "Backend", error.message, "service", "observed");
    return checks;
  }

  // An environment-backed ID: what this computer's .env files (or, where the framework loads none, this shell) set. Deployments set their own, which doctor can't see.
  let setting = null;
  if (props.projectId?.kind === "env") {
    const wiring = chooseWiring(root, { envFile, cwd });
    if (wiring.mode === "env") {
      const fromShell = envTargetOf(wiring).files.length === 0;
      let found = null;
      let problem = wiring.problem;
      if (problem === null) {
        try {
          found = readLocalValue(wiring, shell);
        } catch (error) {
          problem = error?.file === undefined ? error.message : `Couldn't read ${shown(cwd, error.file)}.`;
        }
      }
      const where = found === null ? null : found.file === null ? "this shell's environment" : shown(cwd, found.file);
      setting = { variable: wiring.env.variable, env: wiring.env, root, fromShell, found, problem, where };
    }
  }
  const projectId = props.projectId?.kind === "literal" ? props.projectId.value : setting?.found?.value ?? null;
  const query = projectId !== null && isValidProjectId(projectId) ? `?projectId=${encodeURIComponent(projectId)}` : "";
  let health;
  try {
    health = await getJson(`${resolved.siteUrl}/critiqs/health${query}`, fetchFn, "Can't read the backend's health");
  } catch (error) {
    add("fail", "Health", error.message, "service", "observed");
    return checks;
  }

  const hidden = props.requireProjectId ? "Critiqs stays hidden" : "Critiqs shows project setup";
  if (props.projectId === null) add("fail", "Project", `${at} has no project ID. Run npx critiqs init to create a project and write its ID.`, "project");
  else if (setting !== null && setting.problem !== null) {
    add("warn", "Project", `${at} reads ${setting.variable}, but doctor can't determine its local value: ${setting.problem} Check with doctor --project-env-file <the .env file this app loads>.`, "project");
  } else if (setting !== null && setting.found === null) {
    add("warn", "Project", `${at} reads its project ID from ${setting.variable}, which ${setting.fromShell ? "this shell's environment doesn't set" : "no .env file here sets"}, so ${hidden} on this computer. Run npx critiqs init to create or connect a project and set it.`, "project");
  } else if (setting !== null && !isValidProjectId(projectId)) {
    add("fail", "Project", `${setting.variable} in ${setting.where} is ${JSON.stringify(projectId.slice(0, 80))}, not a Critiqs project ID, so ${hidden} wherever it's used. Set it to the ID from project setup in the Critiqs sidebar, or run npx critiqs init.`, "project");
  } else if (setting !== null && health.project === undefined) {
    add("warn", "Project", restrictedProject(`${projectId} (${setting.variable} in ${setting.where})`), "project", "observed");
  } else if (setting !== null && health.project === "found") {
    add("pass", "Project", `${projectId} (${setting.variable} in ${setting.where}) exists on this backend.`, "project", "observed");
  } else if (setting !== null) {
    add("fail", "Project", `${projectId} (${setting.variable} in ${setting.where}) doesn't exist on this backend. Check the ID, or the backend it points to.`, "project", "observed");
  } else if (props.projectId.kind !== "literal") add("warn", "Project", `${at} sets its project ID from code, so doctor can't check it.`, "project");
  else if (!isValidProjectId(projectId)) add("fail", "Project", `"${projectId}" is not a Critiqs project ID.`, "project");
  else if (health.project === "found") add("pass", "Project", `${projectId} exists on this backend.`, "project", "observed");
  else if (health.project === undefined) add("warn", "Project", restrictedProject(projectId), "project", "observed");
  else add("fail", "Project", `${projectId} doesn't exist on this backend. Check the ID, or the backend it points to.`, "project", "observed");

  if (setting !== null) {
    const local = setting.env.localFile === null ? null : resolve(setting.root, setting.env.localFile);
    const committed = setting.found?.file != null && setting.found.file !== local && !/\.local$/.test(setting.found.file);
    const overridden = !setting.fromShell && typeof shell[setting.variable] === "string" && shell[setting.variable] !== setting.found?.value;
    const settings = setting.env.readsAt === "build" ? "build settings" : "environment";
    add(
      committed ? "warn" : "info",
      "Deployments",
      ((committed
        ? `${setting.variable} is set in ${setting.where}, which is usually committed, so deployments built from this repository use it unless their ${settings} override it. Move it to ${setting.env.localFile ?? "each deployment's settings"} and set it per deployment. `
        : `Each deployment reads ${setting.variable} from its own ${settings}, which doctor can't see; where it's unset, ${hidden}. `) +
        (overridden ? `This shell also sets ${setting.variable}, which builds started here use instead of the .env files. ` : "") +
        (props.requireProjectId ? "" : "Turn on requireProjectId in the app's Critiqs setup so copies without a project show nothing instead of project setup.")
      ).trim(),
      "reviewers",
    );
  }

  if (health.project === "found") {
    if (health.reviewAddress === false) {
      add("warn", "Review address", "The project has no review address, so mention emails can't link to comments. Run npx critiqs init --review-url https://<deployed address>, or add it in the Critiqs sidebar's Project setup.", "reviewers");
    } else if (health.reviewAddressLocal === true) {
      add("warn", "Review address", "The project's review address only opens on one computer or private network (such as localhost or a Tailscale address), so reviewers elsewhere can't follow mention emails. If reviewers use a deployed copy, run npx critiqs init --review-url https://<deployed address>.", "reviewers");
    } else if (health.reviewAddressLocal === false) {
      add("pass", "Review address", "Mention emails link to the project's review address, which isn't a local or private address. Check reviewers can open it, and deploy the commit with this project ID there.", "reviewers");
    }
  }

  // A backend that trusts another's sign-in is only as ready as that service.
  let signIn = health.signIn;
  if (signIn === "external") {
    try {
      signIn = (await getJson(`${new URL(resolved.signInUrl).origin}/critiqs/health`, fetchFn, "Can't read the sign-in service's health")).signIn;
    } catch {
      signIn = "unreachable";
    }
  }
  const via = health.signIn === "external" ? `Critiqs's sign-in service at ${resolved.signInUrl}` : "The backend";
  const signInCheck = (status, detail) => add(status, "Sign-in", detail, "service");
  if (signIn === "unconfigured") signInCheck("fail", `${via} doesn't name a sign-in service. Set CRITIQS_AUTH_ISSUER on it.`);
  else if (signIn === "unreachable") signInCheck("fail", `Can't reach Critiqs's sign-in service at ${resolved.signInUrl}.`);
  else if (signIn === "unavailable" || signIn === "external") {
    signInCheck(
      "fail",
      resolved.transport === "http"
        ? "Your app's Critiqs server can't sign anyone in: pass email to createCritiqsHandler, or identify to use your app's own sign-in."
        : `${via} can't sign anyone in. It needs CRITIQS_AUTH_PRIVATE_KEY, RESEND_API_KEY, and CRITIQS_EMAIL_FROM.`,
    );
  } else if (signIn === "host") signInCheck("pass", "Reviewers are whoever is signed in to your app.");
  else if (signIn === "development") signInCheck("warn", `${via} shows sign-in codes on screen; use it only on this computer.`);
  else signInCheck("pass", `${via} is configured to email sign-in codes.`);

  if (health.captures) {
    add(
      health.captures.configured ? "pass" : "fail",
      "Screenshots",
      health.captures.configured
        ? `Screenshot storage is configured (${health.captures.provider}); the first comment with a screenshot exercises it.`
        : "Screenshot storage is not configured. Check CRITIQS_CAPTURE_STORAGE and the CRITIQS_R2_* settings on the backend.",
      "service",
    );
  }
  if (health.ai) {
    const provider = health.ai.defaultProvider;
    const aiCheck = (status, detail) => add(status, "AI", detail, "optional");
    if (health.ai.managedProblem) aiCheck("warn", `Critiqs-managed AI is turned on but off because of its settings: ${health.ai.managedProblem}`);
    else if (health.ai.managed) aiCheck("pass", "Critiqs-managed AI is configured; project owners can also connect their own provider.");
    else if (provider) aiCheck("pass", `Projects use ${provider} as configured on the backend${health.ai.keysStorable ? "; owners can connect their own provider too" : ""}.`);
    else if (health.ai.keysStorable) aiCheck("pass", "Project owners can connect their own AI provider in Critiqs. Search and grouping work without one.");
    else {
      const off = "AI is off, which is fine: comments work, search matches words and tags, and tags are grouped by hand.";
      aiCheck(
        "info",
        resolved.transport === "http"
          ? `${off} Pass ai to createCritiqsHandler to add a provider.`
          : resolved.backendUrl === CLOUD_BACKEND_URL
            ? `${off} Critiqs Cloud hasn't turned AI on; there's nothing to set up in your app.`
            : `${off} Set CRITIQS_AI_ENCRYPTION_KEY on the backend so owners can connect a provider.`,
      );
    }
  }
  const mentions = health.mentionEmails ?? {};
  if (!health.email) {
    add(
      "warn",
      "Email",
      resolved.transport === "http"
        ? "Mention emails are off: pass email: { resendApiKey, from } to createCritiqsHandler to send them."
        : "Mention emails are off: set RESEND_API_KEY and CRITIQS_EMAIL_FROM on the backend to send them.",
      "service",
    );
  } else if (mentions.overdue) {
    const minutes = Math.round((now - mentions.waitingSince) / 60_000);
    add("fail", "Email", `Mention emails have waited ${minutes} minutes, so scheduled sending isn't running. Check the deployment's scheduled functions.`, "service", "observed");
  } else if (mentions.last?.status === "failed") {
    add("fail", "Email", "The last mention email failed. Check the Resend key and that the sender's domain is verified in Resend.", "service", "observed");
  } else if (mentions.last?.status === "sent") {
    add("pass", "Email", "Mention emails are going out: the last one was sent.", "service", "observed");
  } else {
    add("pass", "Email", "Email is configured; no mention email has been sent yet, so delivery isn't proven.", "service");
  }
  return checks;
}

/** A doctor report for agents and scripts: every check, whether any failed, and what doctor didn't do. */
export function doctorReport(checks) {
  return { ok: !checks.some((check) => check.status === "fail"), checks, note: DOCTOR_NOTE };
}

/**
 * Where setup stands after init, in stages: the code, the project, finishing
 * setup in the app (installing its framework's package), trying it locally,
 * and reviewers on other computers. Each is pass, warn, fail, or next (a step
 * only the person can take, such as deploying).
 */
export function readiness({ written, projectId, projectName, backendUrl, reviewAddress, reused = false, connected = false }) {
  const stages = [];
  const add = (status, name, detail) => stages.push({ status, name, detail });
  if (written.ok) add("pass", "Code", written.message);
  else add("fail", "Code", `${written.message}\nThe project ${projectId} already exists on ${backendUrl}. Preserve both its project ID and backend when reconnecting.`);
  const where = backendUrl === CLOUD_BACKEND_URL ? "Critiqs Cloud" : backendUrl;
  add("pass", "Project", `${connected ? "Already connected to" : reused ? "Reusing your project" : "Created"} "${projectName}" (${projectId}) on ${where}.`);
  if (written.ok && written.next?.length > 0) add("next", "Finish setup", written.next.map((step) => `${step.replace(/\.$/, "")}.`).join(" "));
  add("next", "Try it locally", `Start the app's dev server${written.env ? " (restart it if it's running, so it reads the new setting)" : ""}, open it in a browser, and sign in from the Critiqs toolbar to leave a comment.`);
  if (written.env) add("next", "Deployments", written.env.advice);
  if (reviewAddress === null || reviewAddress === undefined) {
    add("warn", "Reviewers elsewhere", "Commit and deploy this change. The project has no review address, so mention emails can't link to comments: once deployed, run npx critiqs init --review-url https://<deployed address>.");
  } else if (isLocalAddress(reviewAddress)) {
    add("warn", "Reviewers elsewhere", `Commit and deploy this change. The review address ${reviewAddress} only opens on this computer or a private network (such as a Tailscale network): if reviewers use a deployed copy, run npx critiqs init --review-url https://<deployed address>.`);
  } else {
    add("next", "Reviewers elsewhere", `Commit and deploy this change to ${reviewAddress}; every copy with this project ID (local, preview, deployed) shares its feedback.`);
  }
  return stages;
}

// ---------------------------------------------------------------------------
// The whole setup

/**
 * A name for the project: the app's package name, or its folder's. In a
 * workspace it also names the workspace, and the app's path when another
 * package shares its name, so each app finds and reuses only its own project.
 */
export function defaultProjectName(root) {
  return describeApp(root).projectName;
}

/**
 * The project the code already names: a literal ID, or for environment-backed
 * wiring (see `chooseWiring`), the ID this computer gives it, with where: its
 * `.env` files, or the shell's environment for a framework that loads none,
 * as doctor reads it. A missing or malformed setting names no project.
 */
function connectedProject(root, wiring, shell) {
  const located = readUsage(root);
  if ("error" in located) return null;
  const { projectId: id, backend } = located.usage;
  if (backend !== null && backend.kind !== "literal") return null;
  const backendUrl = backend?.value.replace(/\/$/, "") ?? CLOUD_BACKEND_URL;
  if (id?.kind === "literal") return isValidProjectId(id.value) ? { projectId: id.value, backendUrl } : null;
  if (wiring.mode !== "env" || id?.kind !== "env" || id.variable !== wiring.env.variable) return null;
  const found = readLocalValue(wiring, shell);
  if (found === null || !isValidProjectId(found.value)) return null;
  return { projectId: found.value, backendUrl, env: { name: wiring.env.variable, file: found.file } };
}

/**
 * Sets up Critiqs for the prototype in `root`, in two halves so a coding agent
 * can hand the sign-in to a person between them:
 * - `beginSetup` checks the code can take the result (adding Critiqs where
 *   the app renders when it has none, through its framework's adapter), deploys to the team's own Convex
 *   when asked (`target: "own-convex"`), checks the backend, and starts
 *   sign-in: a page on this computer (`signIn: "browser"`), or approval from
 *   any device (`"remote"`); `"auto"` picks remote when this computer seems to
 *   have no browser and the service supports it.
 *   `target: "cloud"` uses Critiqs Cloud; a URL uses an existing Critiqs backend.
 * - `finish()` waits for sign-in, reuses the person's project with this name
 *   (unless `newProject`) or creates one, ends the command line's session,
 *   and writes `projectId` (and `backend`, unless Critiqs Cloud).
 * When the code already names a project, it is kept: setup returns
 * `{ connected }` without signing in, or with `reviewUrl`, signs in only to
 * set that project's review address.
 */
export async function beginSetup({
  root,
  cwd = root,
  target = null,
  name,
  reviewUrl,
  keys = {},
  env = process.env,
  log = () => {},
  fetchFn = fetch,
  entry = null,
  mount = null,
  newProject = false,
  signIn: method = "browser",
  envFile = null,
  sleep,
}) {
  if (reviewUrl !== undefined && reviewUrl !== null && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(reviewUrl)) {
    throw new SetupError("The review address must be the prototype's https:// address (or http://localhost while testing).");
  }
  // Which app, and how its code names the project, before anything is read from or sent to a backend.
  let apps = null;
  try {
    apps = workspaceApps(root);
  } catch {}
  if (apps !== null && apps.length > 0) throw new SetupError(workspaceRefusal(apps, shown(cwd, root), (dir) => shown(cwd, dir), "npx critiqs init"));
  const wiring = chooseWiring(root, { envFile, cwd, entry, mount });
  if (wiring.problem) throw new SetupError(wiring.problem);
  let configured;
  try {
    configured = connectedProject(root, wiring, env);
  } catch (error) {
    throw new SetupError(`Couldn't read ${error?.file === undefined ? "this app's .env files" : shown(cwd, error.file)}. Restore access, then run setup again; no project was created.`);
  }
  const existing = newProject ? null : configured;
  let usage = null;
  try {
    usage = readUsage(root).usage ?? null;
  } catch {}
  const configuredBackend = usage?.backend?.kind === "literal" ? usage.backend.value.replace(/\/$/, "") : null;
  // Without an explicit choice, a project the code names stays where it is, and a new one goes to Critiqs Cloud.
  const explicit = target !== null && target !== undefined;
  target = explicit ? target : (configuredBackend ?? "cloud");
  if (existing !== null) {
    const asked = target === "cloud" ? CLOUD_BACKEND_URL : target;
    if (explicit && (target === "own-convex" || asked.replace(/\/$/, "") !== existing.backendUrl)) {
      throw new SetupError(
        `The code already uses project ${existing.projectId} on ${existing.backendUrl === CLOUD_BACKEND_URL ? "Critiqs Cloud" : existing.backendUrl}, so setup didn't create another. Pass --new-project to replace it with a new one.`,
      );
    }
    if (reviewUrl === undefined || reviewUrl === null) return { connected: existing, backendUrl: existing.backendUrl };
  }

  // Check the code can take the settings before anyone signs in or anything is created.
  // Capture this before sign-in; source permissions may change while approval
  // is pending, and a later read failure must not discard a created project.
  const named = usage !== null && usage.backend !== null;
  const backendSetting = (backendUrl) => (backendUrl === CLOUD_BACKEND_URL && !named ? undefined : backendUrl);
  const settings = (projectId, backendUrl) => connectionSettings(wiring, projectId, backendSetting(backendUrl));
  const connect = (projectId, backendUrl, placed = {}) => writeConnection({ root, cwd, wiring, projectId, backend: backendSetting(backendUrl), shell: env, ...placed });
  if (existing === null) {
    // The entry only says where to add Critiqs, so code that has it already doesn't need one.
    if (entry !== null && wiring.usages.length === 0 && !isFile(resolve(root, entry))) {
      throw new SetupError(`${entry} is not a file in ${shown(cwd, root)}. Name the file where the app renders, relative to that folder.`);
    }
    const planned = target === "cloud" ? CLOUD_BACKEND_URL : target === "own-convex" ? "https://example.convex.cloud" : target;
    const precheck = connect("p".repeat(32), planned, { dryRun: true, entry, mount });
    if (!precheck.ok) {
      const message = precheck.message.replaceAll("p".repeat(32), "<the new project ID>");
      if (message.startsWith("Can't write")) throw new SetupError(message.replace(/\.$/, "; no project was created."));
      throw new SetupError(precheck.reason === "manual" && !wiring.detected ? `${message}\n${UNRECOGNIZED}` : message);
    }
    // Wiring that is already in place leaves the source as it is.
    for (const write of precheck.writes) {
      try {
        checkWritable(write.file);
      } catch {
        throw new SetupError(`Can't write ${shown(cwd, write.file)}. Check the file's permissions, then run setup again; no project was created.`);
      }
    }
  }

  let backendUrl;
  if (existing !== null) backendUrl = existing.backendUrl;
  else if (target === "cloud") backendUrl = CLOUD_BACKEND_URL;
  else if (target === "own-convex") {
    backendUrl = await deployOwnConvex({
      env: { ...env, ...(keys.convexDeployKey ? { CONVEX_DEPLOY_KEY: keys.convexDeployKey } : {}) },
      signInUrl: env.CRITIQS_SIGN_IN_URL,
      resendApiKey: keys.resendApiKey ?? env.RESEND_API_KEY,
      emailFrom: keys.emailFrom ?? env.CRITIQS_EMAIL_FROM,
      log,
    });
  } else backendUrl = target;
  if (backendUrl.startsWith("/")) {
    throw new SetupError(
      `The app uses Critiqs inside its own server at ${backendUrl}. ${existing !== null ? "Change this project's review address" : "Create a new project"} in the Critiqs sidebar on the running app${existing !== null ? "." : `, then run npx critiqs init <projectId> to write its ID, keeping the backend setting ${JSON.stringify(backendUrl)}.`} No Cloud project was created.`,
    );
  }
  const backend = await resolveBackend(backendUrl, { fetchFn });
  if (backend.transport === "http") {
    throw new SetupError(
      `${backend.backendUrl} is Critiqs inside your app's own server. Give the app's Critiqs the backend setting ${JSON.stringify(backend.backendUrl)}: on the existing one, or if the app has none, add Critiqs once with only that setting (${wiring.adapter.name}: ${packageOf(wiring.adapter)}). ` +
        "Create the project in its Critiqs sidebar on the running app, then run npx critiqs init <projectId> to write its ID, keeping the backend.",
    );
  }

  // Checked before anyone approves: the token goes to the backend, and comes from the sign-in service.
  requireSecureTokenTarget(backend.backendUrl);
  requireSecureTokenTarget(backend.signInUrl);
  let remote = method === "remote";
  if (method === "auto" && isHeadless(env)) {
    try {
      const config = await getJson(`${new URL(backend.signInUrl).origin}/critiqs/config`, fetchFn, "Can't reach the sign-in service");
      remote = config.deviceSignIn === true;
      if (!remote) log("This computer may not show a browser, and the sign-in service can't approve setup from another device yet; opening sign-in here.");
    } catch {}
  }
  const signIn = remote
    ? await startRemoteSignIn({ signInUrl: backend.signInUrl, backendUrl: backend.backendUrl, fetchFn, ...(sleep ? { sleep } : {}) })
    : await startBrowserSignIn({ signInUrl: backend.signInUrl, backendUrl: backend.backendUrl });
  const projectName = (name ?? defaultProjectName(root)).trim() || "Prototype";
  return {
    url: signIn.url,
    method: remote ? "remote" : "browser",
    userCode: signIn.userCode ?? null,
    backendUrl: backend.backendUrl,
    cancel: signIn.close,
    finish: async () => {
      const { accessToken, refreshToken, reviewer = null } = await signIn.tokens;
      try {
        if (existing !== null) {
          log("Setting the review address…");
          await callConvex(backend.backendUrl, "mutation", "projects:setReviewUrl", { projectId: existing.projectId, reviewUrl }, accessToken, { fetchFn });
          const project = await callConvex(backend.backendUrl, "query", "projects:get", { projectId: existing.projectId }, accessToken, { fetchFn });
          const written = connect(existing.projectId, backend.backendUrl);
          return { projectId: existing.projectId, projectName: project.name, backendUrl: backend.backendUrl, written, reviewAddress: reviewUrl, reused: true, connected: true, approvedBy: reviewer };
        }
        let projectId = null;
        let reused = false;
        let reviewAddress = reviewUrl ?? null;
        if (!newProject) {
          // A retry after a failed write finds the project the first try created.
          let mine = [];
          try {
            mine = (await listMyProjects({ backendUrl: backend.backendUrl, accessToken, fetchFn })).filter((project) => project.name === projectName);
          } catch {
            throw new SetupError("Couldn't check your existing projects. Run setup again when the backend is reachable; no new project was created.");
          }
          if (mine.length > 1) {
            const placement = entry === null ? "where the app renders" : `in ${shown(cwd, resolve(root, entry))}${mount === null ? "" : ` beside <${mount}>`}`;
            throw new SetupError(
              `You already have ${mine.length} projects named "${projectName}". No project or source was changed. ` +
                `Choose one and add Critiqs ${placement} with its ID, preserving the backend; update an existing Critiqs setup instead of adding another` +
                (wiring.mode === "env" ? `, and set ${wiring.env.variable} to that project's ID in this app's ${envTargetOf(wiring).local === null ? "environment" : shown(cwd, envTargetOf(wiring).local)}` : "") +
                ". Or pass --new-project to create another.\n" +
                (wiring.mode === "env"
                  ? `${wiring.adapter.manual(settings(mine[0]._id, backend.backendUrl))}\n${mine.map((project) => `${wiring.env.variable}=${project._id}`).join("\n")}`
                  : mine.map((project) => `For ${project._id}:\n${wiring.adapter.manual(settings(project._id, backend.backendUrl))}`).join("\n\n")),
            );
          }
          if (mine.length === 1) {
            projectId = mine[0]._id;
            reused = true;
            reviewAddress = mine[0].reviewUrl ?? null;
            if (reviewUrl !== undefined && reviewUrl !== null && reviewUrl !== reviewAddress) {
              await callConvex(backend.backendUrl, "mutation", "projects:setReviewUrl", { projectId, reviewUrl }, accessToken, { fetchFn });
              reviewAddress = reviewUrl;
            }
            log(`Reusing your project "${projectName}" (${projectId}). Pass --new-project to create another.`);
          }
        }
        if (projectId === null) {
          log("Creating the project…");
          projectId = await createProject({ backendUrl: backend.backendUrl, accessToken, name: projectName, reviewUrl: reviewUrl ?? null, fetchFn });
        }
        const written = connect(projectId, backend.backendUrl, { entry, mount });
        return { projectId, projectName, backendUrl: backend.backendUrl, written, reviewAddress, reused, connected: false, approvedBy: reviewer };
      } finally {
        if (refreshToken) await signOut(backend.signInUrl, refreshToken, { origin: new URL(signIn.url).origin, fetchFn });
      }
    },
  };
}
