// The pages the acceptance checks open: HTTPS names on this computer
// (`<name>.critiqs.test`, which Chrome maps to 127.0.0.1), so origins aren't
// ambiguous the way localhost is.
//
// - The test page (any name): a button `[data-critiqs-id="team.save"]`, a
//   frame from another site (teal, which only a real screenshot shows), a
//   same-origin frame, and the page's own key and click counters.
// - The strict page (`strict.*`): the test page with a strict
//   Content-Security-Policy and Trusted Types enforced.
// - The hostile page (`hostile.*`): the strict page plus hostile.js and
//   hostile.css, which patch the page's globals and hunt for the session.
// - `installed.*`: a page with Critiqs installed.
// - `http://localhost:<port>`: a page on this computer's own name.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const STRICT_POLICY = "default-src 'self'; connect-src 'none'; img-src 'self'; style-src 'self'; frame-src 'none'";
export const TRUSTED_TYPES = "require-trusted-types-for 'script'";
export const TEAL = [20, 184, 166];

const here = fileURLToPath(new URL("./", import.meta.url));

/** The page's own script: counts keys reaching its bubble-phase listeners and clicks on its button, and moves between screens with pushState. */
const PAGE_SCRIPT = `
window.__pageKeys = [];
window.__clicks = 0;
document.addEventListener("keydown", (event) => window.__pageKeys.push("document:" + event.key));
window.addEventListener("keydown", (event) => window.__pageKeys.push("window:" + event.key));
document.addEventListener("click", (event) => { if (event.target.closest && event.target.closest('[data-critiqs-id="team.save"]')) window.__clicks++; });
const screens = {
  "/": '<p>Members can invite others and change the team\\'s name.</p><button data-critiqs-id="team.save">Save changes</button>',
  "/second": '<p>Billing for the team.</p><button data-critiqs-id="team.billing">Update billing</button>',
};
window.__go = (path) => {
  history.pushState({}, "", path);
  document.querySelector("#screen").replaceChildren(document.createRange().createContextualFragment(screens[path] ?? screens["/"]));
};
`;

const PAGE_CSS = `body { font: 16px system-ui; margin: 0; padding: 32px; background: #fff; }
section { border: 1px solid #ddd; border-radius: 8px; padding: 24px; max-width: 520px; }
button { font: inherit; padding: 8px 16px; }
iframe { display: block; margin-top: 16px; width: 280px; height: 80px; border: 0; }`;

const HOSTILE_CSS = "* { all: unset !important; } html, body, section, p, h1, pre, iframe { display: block !important; }";

const html = (text: string, headers: Record<string, string> = {}) => {
  const response = new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
  for (const [name, value] of Object.entries(headers)) response.headers.append(name, value);
  return response;
};

export interface Sites {
  port: number;
  /** `https://<name>.critiqs.test:<port>` */
  site(name: string): string;
  /** `http://localhost:<port>` */
  local: string;
  /** The project an `installed.*` page's Critiqs uses. */
  setInstalledProject(projectId: string): void;
  stop(): void;
}

export async function startSites({ scratch, backend, elementScript }: { scratch: string; backend: string; elementScript: string }): Promise<Sites> {
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${scratch}/key.pem -out ${scratch}/cert.pem -days 2 -subj /CN=critiqs.test -addext ${"subjectAltName=DNS:*.critiqs.test"}`.quiet();
  const hostile = await Bun.file(join(here, "hostile.js")).text();
  let installedProject = "";
  let port = 0;
  const page = (title: string, head: string, sameOriginFrame: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/page.css">${head}<script src="/page.js"></script></head><body>
<h1>${title}</h1>
<section id="screen"><p>Members can invite others and change the team's name.</p>
<button data-critiqs-id="team.save">Save changes</button></section>
<iframe title="Another site" src="https://frame.critiqs.test:${port}/teal"></iframe>${sameOriginFrame ? `\n<iframe title="This site" src="/frame" style="height:30px"></iframe>` : ""}
<pre id="loot"></pre>
</body></html>`;
  const server = Bun.serve({
    port: Number(process.env.CRITIQS_SITES_PORT ?? 0),
    hostname: "127.0.0.1",
    tls: { cert: Bun.file(`${scratch}/cert.pem`), key: Bun.file(`${scratch}/key.pem`) },
    fetch(request, bun): Response | undefined {
      const { hostname, pathname } = new URL(request.url);
      const kind = hostname.split(".")[0]!;
      if (pathname === "/ws" && bun.upgrade(request)) return undefined;
      if (pathname === "/echo") return Response.json({ origin: request.headers.get("origin") }, { headers: { "access-control-allow-origin": "*" } });
      if (pathname === "/element.js") return new Response(elementScript, { headers: { "content-type": "text/javascript" } });
      if (pathname === "/page.js") return new Response(PAGE_SCRIPT, { headers: { "content-type": "text/javascript" } });
      if (pathname === "/page.css") return new Response(PAGE_CSS, { headers: { "content-type": "text/css" } });
      if (pathname === "/hostile.js") return new Response(hostile, { headers: { "content-type": "text/javascript" } });
      if (pathname === "/hostile.css") return new Response(HOSTILE_CSS, { headers: { "content-type": "text/css" } });
      if (pathname === "/teal") return html(`<!doctype html><html><body style="margin:0;background:rgb(20,184,166)"></body></html>`);
      if (pathname === "/frame") return html(`<!doctype html><html><body style="margin:0;font:12px system-ui">A frame from this site</body></html>`);
      if (pathname === "/favicon.ico") return new Response(null, { status: 404 });
      if (kind === "installed") {
        return html(`<!doctype html><html><head><title>Installed</title></head><body><h1>Installed</h1><critiqs-app project-id="${installedProject}" backend="${backend}"></critiqs-app><script type="module" src="/element.js"></script></body></html>`);
      }
      const title = kind.replace(/^\w/, (c) => c.toUpperCase());
      if (kind === "strict" || kind === "hostile") {
        const head = kind === "hostile" ? `<link rel="stylesheet" href="/hostile.css"><script src="/hostile.js"></script>` : "";
        return html(page(`${title} page`, head, false), { "content-security-policy": STRICT_POLICY, "Content-Security-Policy": TRUSTED_TYPES });
      }
      return html(page(title, "", true));
    },
    websocket: { message: (socket, message) => void socket.send(`echo ${message}`) },
  });
  port = server.port!;
  const localPort = Number(process.env.CRITIQS_LOCAL_PORT ?? (process.env.CRITIQS_SITES_PORT ? port + 1 : 0));
  const local = Bun.serve({ port: localPort, hostname: "localhost", fetch: () => html(page("Local app", "", false).replace(/https:\/\/frame[^"]+/, "about:blank")) });
  return {
    port,
    site: (name) => `https://${name}.critiqs.test:${port}`,
    local: `http://localhost:${local.port}`,
    setInstalledProject: (projectId) => void (installedProject = projectId),
    stop: () => (server.stop(true), local.stop(true)),
  };
}

/** A scratch folder under TMPDIR (never /tmp on machines where it is memory). */
export const scratchRoot = () => process.env.TMPDIR ?? tmpdir();
