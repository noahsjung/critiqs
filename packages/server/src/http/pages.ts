// The sign-in window's pages for a server in the host app. Plain forms with
// no scripts except the last page, which tells the opener sign-in finished.

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

function page(title: string, body: string, scriptNonce?: string, status = 200): Response {
  const script = scriptNonce === undefined ? "" : ` 'nonce-${scriptNonce}'`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}
label{display:block;font-weight:600;margin:1rem 0 .25rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #ccc;border-radius:8px}
button{font:inherit;font-weight:600;border-radius:8px;padding:.5rem 1rem;border:1px solid #ccc;background:#fff;cursor:pointer}
button.primary{background:#0d63f3;border-color:#0d63f3;color:#fff}.actions{display:flex;gap:.5rem;margin-top:1rem}
.error{color:#c62828}.note{color:#555;font-size:13px}code.dev{font-size:22px;letter-spacing:.2em}</style></head>
<body>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'${script ? `; script-src${script}` : ""}`,
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export function messagePage(title: string, message: string, status = 400): Response {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`, undefined, status);
}

export function emailPage(base: string, key: string, error?: string): Response {
  return page(
    "Sign in",
    `<h1>Sign in to comment</h1>
     <form method="post" action="${escape(base)}/auth/email">
       <input type="hidden" name="key" value="${escape(key)}">
       <label for="email">Email address</label>
       <input id="email" name="email" type="email" autocomplete="email" required autofocus>
       ${error ? `<p class="error">${escape(error)}</p>` : ""}
       <div class="actions"><button class="primary" type="submit">Send code</button></div>
     </form>
     <p class="note">We'll email you a code. Your address isn't shown to other reviewers.</p>`,
  );
}

export function codePage(base: string, key: string, email: string, options: { error?: string; developmentCode?: string } = {}): Response {
  return page(
    "Enter your code",
    `<h1>Check your email</h1>
     <p>Enter the code sent to <strong>${escape(email)}</strong>.</p>
     ${options.developmentCode ? `<p class="note">Development sign-in shows the code here instead of emailing it:</p><p><code class="dev" id="development-code">${escape(options.developmentCode)}</code></p>` : ""}
     <form method="post" action="${escape(base)}/auth/code">
       <input type="hidden" name="key" value="${escape(key)}">
       <label for="code">Code</label>
       <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
       ${options.error ? `<p class="error">${escape(options.error)}</p>` : ""}
       <div class="actions"><button class="primary" type="submit">Sign in</button></div>
     </form>`,
  );
}

export function namePage(base: string, key: string, error?: string): Response {
  return page(
    "Your name",
    `<h1>Choose your name</h1>
     <p>Other reviewers see this name next to your comments.</p>
     <form method="post" action="${escape(base)}/auth/name">
       <input type="hidden" name="key" value="${escape(key)}">
       <label for="name">Name</label>
       <input id="name" name="name" autocomplete="name" maxlength="60" required autofocus>
       ${error ? `<p class="error">${escape(error)}</p>` : ""}
       <div class="actions"><button class="primary" type="submit">Continue</button></div>
     </form>`,
  );
}

/** Tells the page that opened sign-in, on this same site, that sign-in finished. */
export function donePage(state: string, cookie: string): Response {
  const scriptNonce = nonce();
  const data = JSON.stringify({ type: "critiqs:sign-in", state }).replace(/</g, "\\u003c");
  const response = page(
    "Signed in",
    `<h1>Signed in</h1><p>You can close this window if it stays open.</p>
     <script nonce="${scriptNonce}">
       if (window.opener) window.opener.postMessage(${data}, location.origin);
       window.close();
     </script>`,
    scriptNonce,
  );
  response.headers.append("Set-Cookie", cookie);
  return response;
}

/** Confirms a mute or unsubscribe link first, so mail scanners that open links change nothing. */
export function preferencePage(base: string, token: string, description: string): Response {
  return page(
    "Email notifications",
    `<h1>Email notifications</h1><p>${escape(description)}</p>
     <form method="post" action="${escape(base)}/notifications/preferences">
       <input type="hidden" name="token" value="${escape(token)}">
       <div class="actions"><button class="primary" type="submit">Confirm</button></div>
     </form>`,
  );
}
