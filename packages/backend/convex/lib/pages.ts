import { randomSecret, type ReviewerProfile } from "./tokens";

/** What a sign-in is for, as the pages name it. Match `DEVICE_SITE` and `DEVICE_ACCESS_SITE` in deviceSignIn.ts. */
const DEVICE_SITE = "Critiqs setup on another device";
const DEVICE_ACCESS_SITE = "Critiqs access for a command line";

function purpose(origin: string): string {
  if (origin === DEVICE_SITE) return "approve Critiqs setup started on another device";
  if (origin === DEVICE_ACCESS_SITE) return "approve Critiqs access for a command line or coding agent";
  return `review <strong>${escape(origin)}</strong>`;
}

// Pages shown in Critiqs's sign-in popup. They are never framed, load nothing
// external, and post forms only back to this deployment.

const STYLE = `
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #f5f5f4; }
  main { max-width: 360px; margin: 48px auto; padding: 28px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: #444; }
  strong { color: #1a1a1a; word-break: break-all; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; font-size: 13px; }
  input { box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit; border: 1px solid #ccc; border-radius: 6px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  button { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  button.primary { background: #0d63f3; border-color: #0d63f3; color: #fff; }
  .warning { padding: 8px 10px; border-radius: 6px; background: #fff4d6; color: #6b4e00; font-size: 13px; }
  .error { padding: 8px 10px; border-radius: 6px; background: #fdecec; color: #a61b1b; font-size: 13px; }
  .note { margin-top: 16px; font-size: 13px; color: #666; }
  .secondary { margin-top: 12px; }
  .secondary button { border: 0; background: none; color: #0d63f3; padding: 0; font-weight: 500; }
`;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string, nonce?: string): Response {
  const script = nonce === undefined ? "" : ` script-src 'nonce-${nonce}';`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; frame-ancestors 'none';${script}`,
      },
    },
  );
}

export function messagePage(title: string, message: string, status = 400): Response {
  const response = page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
  return new Response(response.body, { status, headers: response.headers });
}

const DEV_WARNING = `<p class="warning">Development sign-in: no email is sent, and the code appears below. Never enable this on a shared deployment.</p>`;

function attemptField(attemptKey: string): string {
  return `<input type="hidden" name="attempt" value="${escape(attemptKey)}">`;
}

/** First step: the reviewer's email address. The same page serves new and returning reviewers. */
export function emailPage(attemptKey: string, origin: string, options: { development: boolean; error?: string; email?: string }): Response {
  return page(
    "Sign in to Critiqs",
    `<h1>Sign in to Critiqs</h1>
     ${options.development ? DEV_WARNING : ""}
     <p>To ${purpose(origin)}, enter your email. We'll send you a code; there's no password.</p>
     ${options.error === undefined ? "" : `<p class="error">${escape(options.error)}</p>`}
     <form method="post" action="/auth/email">
       ${attemptField(attemptKey)}
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" required autofocus value="${escape(options.email ?? "")}">
       <div class="actions"><button class="primary" type="submit">Send code</button></div>
     </form>`,
  );
}

/** Second step: the code. It never says whether the address already has an account. */
export function codePage(
  attemptKey: string,
  origin: string,
  email: string,
  options: { development: boolean; developmentCode?: string; error?: string; canResend: boolean },
): Response {
  return page(
    "Enter your code",
    `<h1>Check your email</h1>
     ${options.development ? DEV_WARNING : ""}
     <p>If <strong>${escape(email)}</strong> can receive email, a 6-digit code is on its way. It works for 10 minutes.</p>
     ${options.developmentCode === undefined ? "" : `<p>Development code: <strong id="development-code">${escape(options.developmentCode)}</strong></p>`}
     ${options.error === undefined ? "" : `<p class="error">${escape(options.error)}</p>`}
     <form method="post" action="/auth/code">
       ${attemptField(attemptKey)}
       <label for="code">Code</label>
       <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus>
       <div class="actions"><button class="primary" type="submit">Sign in</button></div>
     </form>
     ${
       options.canResend
         ? `<form method="post" action="/auth/email" class="secondary">${attemptField(attemptKey)}<input type="hidden" name="email" value="${escape(email)}"><button type="submit">Send a new code</button></form>`
         : ""
     }
     <p class="note">Signing in to ${purpose(origin).replace(/<\/?strong>/g, "")}. Only type the code here.</p>`,
  );
}

/** For a new reviewer after their address is verified: the name others will see. */
export function namePage(attemptKey: string, options: { error?: string }): Response {
  return page(
    "Choose your name",
    `<h1>Choose your display name</h1>
     <p>Everyone in the projects you review sees this name on your comments. Your email address is never shown. You can change it later.</p>
     ${options.error === undefined ? "" : `<p class="error">${escape(options.error)}</p>`}
     <form method="post" action="/auth/name">
       ${attemptField(attemptKey)}
       <label for="name">Display name</label>
       <input id="name" name="name" autocomplete="name" maxlength="60" required autofocus>
       <div class="actions"><button class="primary" type="submit">Continue</button></div>
     </form>`,
  );
}

/** Asked the first time a reviewer signs in from a site, so another site cannot borrow their access. */
export function consentPage(attemptKey: string, consentToken: string, origin: string, profile: ReviewerProfile): Response {
  const field = `<input type="hidden" name="attempt" value="${escape(attemptKey)}"><input type="hidden" name="consent" value="${escape(consentToken)}">`;
  return page(
    "Allow this site?",
    `<h1>Allow this site to use Critiqs?</h1>
     <p><strong>${escape(origin)}</strong> wants to show and post feedback as
       <strong>${escape(profile.name)}</strong> (${escape(profile.email)}).</p>
     <p>Only allow sites you use for reviewing prototypes. You will not be asked again for this site.</p>
     <div class="actions">
       <form method="post" action="/auth/consent">${field}<input type="hidden" name="decision" value="cancel"><button type="submit">Cancel</button></form>
       <form method="post" action="/auth/consent">${field}<input type="hidden" name="decision" value="allow"><button class="primary" type="submit">Allow this site</button></form>
     </div>`,
  );
}

/**
 * Hands the result to the component that opened the popup. `postMessage` names
 * the allowed origin, so the browser delivers it to no other site.
 */
export function deliverPage(origin: string, message: Record<string, unknown>): Response {
  const nonce = randomSecret(16);
  const data = JSON.stringify({ message, origin }).replace(/</g, "\\u003c");
  return page(
    "Signing in…",
    `<h1>Returning to the prototype…</h1>
     <p>You can close this window if it stays open.</p>
     <script nonce="${nonce}">
       const { message, origin } = ${data};
       if (window.opener) window.opener.postMessage(message, origin);
       window.close();
     </script>`,
    nonce,
  );
}

/**
 * Confirms a mute or unsubscribe link before changing anything, so a mail
 * scanner that opens links can't change a reviewer's choices.
 */
export function preferencePage(token: string, description: string): Response {
  return page(
    "Email notifications",
    `<h1>Email notifications</h1>
     <p>${escape(description)}</p>
     <form method="post" action="/notifications/preferences">
       <input type="hidden" name="token" value="${escape(token)}">
       <div class="actions"><button class="primary" type="submit">Confirm</button></div>
     </form>`,
  );
}

/** Where a person approves setup running on another device: first, the code it shows. */
export function deviceCodePage(options: { error?: string; status?: number } = {}): Response {
  const response = page(
    "Approve Critiqs setup",
    `<h1>Approve Critiqs setup</h1>
     <p>Enter the code shown where you started setting up Critiqs, such as a terminal or a coding agent. You'll sign in next.</p>
     ${options.error === undefined ? "" : `<p class="error">${escape(options.error)}</p>`}
     <form method="post" action="/auth/device">
       <label for="user-code">Setup code</label>
       <input id="user-code" name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="XXXX-XXXX" required autofocus>
       <div class="actions"><button class="primary" type="submit">Continue</button></div>
     </form>
     <p class="note">Only enter a code from setup you started yourself. Critiqs never asks for it by email or chat.</p>`,
  );
  return new Response(response.body, { status: options.status ?? 200, headers: response.headers });
}

/** After sign-in: approve or deny the setup, as this reviewer. Asked every time. */
export function deviceApprovalPage(
  attemptKey: string,
  consentToken: string,
  profile: ReviewerProfile,
  { keepSignedIn = false, backend = null, site = null }: { keepSignedIn?: boolean; backend?: string | null; site?: string | null } = {},
): Response {
  const field = `<input type="hidden" name="attempt" value="${escape(attemptKey)}"><input type="hidden" name="consent" value="${escape(consentToken)}">`;
  const who = `<strong>${escape(profile.name)}</strong> (${escape(profile.email)})`;
  // Named by the command line; older ones don't say.
  const downloads = site === null || site === backend ? "" : `, which serves screenshots and page copies from <strong>${escape(site)}</strong>`;
  const where =
    backend === null
      ? ""
      : `<p>This is for the Critiqs backend at <strong>${escape(backend)}</strong>${downloads}. Approve only if you recognize ${downloads === "" ? "this address" : "these addresses"}.</p>`;
  const title = keepSignedIn ? "Approve Critiqs access?" : "Approve Critiqs setup?";
  const explanation = keepSignedIn
    ? `<p>The command line or coding agent where you started this will stay signed in as ${who}. It can
         read and change feedback in every Critiqs project you can open.</p>
       <p>Access lasts until you run <code>critiqs sign-out</code> there, it goes unused for 30 days, or 90 days pass.</p>
       <p>Approve only if you started this yourself just now.</p>`
    : `<p>Setup on another device will act as ${who}
         for up to 15 minutes, to create or connect a Critiqs project.</p>
       <p>Approve only if you started this setup yourself just now.</p>`;
  return page(
    title,
    `<h1>${title}</h1>
     ${explanation}
     ${where}
     <div class="actions">
       <form method="post" action="/auth/device/decision">${field}<input type="hidden" name="decision" value="deny"><button type="submit">Deny</button></form>
       <form method="post" action="/auth/device/decision">${field}<input type="hidden" name="decision" value="approve"><button class="primary" type="submit">Approve</button></form>
     </div>`,
  );
}
