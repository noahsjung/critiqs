// A page with no framework and no build: plain HTML that loads the packed
// package's `element.js` from a <script type="module"> and adds
// <critiqs-app>, and one with only the script tag (`critiqs.js`). Chrome checks that Critiqs's toolbar appears, both without a
// project (project setup) and with a required project ID and backend. Pages
// using Turbo 8 (Hotwire) check that full-page visits, Back, and a frame link
// that advances the URL keep exactly one Critiqs.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expectOneToolbar, expectToolbar, fakeBackend, inChrome, PROJECT, pack, run, scratch } from "../../../scripts/consumer-kit.ts";

const dir = await scratch("plain-html");
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const tarball = await pack("packages/critiqs", dir);
await Bun.write(join(dir, "package.json"), JSON.stringify({ private: true }));
// Turbo beside it, as a Rails app has it.
await run(["npm", "install", "--no-audit", "--no-fund", tarball, "@hotwired/turbo@8.0.23"], dir);
// Server rendering imports the package without a DOM: both entries must load in Node.
await run(["node", "--input-type=module", "-e", 'await import("critiqs"); await import("critiqs/element"); await import("critiqs/router");'], dir);
const element = join(dir, "node_modules/critiqs/dist/element.js");
const classic = join(dir, "node_modules/critiqs/dist/critiqs.js");
const turbo = join(dir, "node_modules/@hotwired/turbo/dist/turbo.es2017-esm.js");

const backend = fakeBackend();
const pages: Record<string, string> = {
  "/": "<critiqs-app></critiqs-app>",
  "/configured": `<critiqs-app project-id="${PROJECT}" backend="${backend.url}" require-project-id></critiqs-app>`,
};
// The script tag, as from a CDN: no element, the settings on the tag.
const scriptPage = `<!doctype html><html><head><title>Plain page</title><script src="/critiqs-classic.js" data-project-id="${PROJECT}" data-backend="${backend.url}" async></script></head><body><h1>A plain HTML page</h1></body></html>`;
// Two pages with Turbo Drive, each with its own <critiqs-app>, and a frame whose link advances the URL.
const turboApp = `<critiqs-app project-id="${PROJECT}" backend="${backend.url}" require-project-id></critiqs-app><script type="module" src="/critiqs.js"></script>`;
// Each response of page A says how many pages were served, so a refresh shows new content.
let served = 0;
const turboPages: Record<string, string> = {
  "/turbo/a": `<h1>Turbo page A</h1><p id="served">${"${served}"}</p><a id="to-b" href="/turbo/b">Page B</a><turbo-frame id="panel"><a id="advance" href="/turbo/panel" data-turbo-action="advance">Open the panel</a></turbo-frame>`,
  "/turbo/b": `<h1>Turbo page B</h1><a id="to-a" href="/turbo/a">Page A</a>`,
  "/turbo/panel": `<h1>Turbo page A</h1><turbo-frame id="panel"><p id="panel-open">The panel</p></turbo-frame>`,
};
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const page = pages[path];
    if (page !== undefined) {
      return new Response(
        `<!doctype html><html><head><title>Plain page</title></head><body><h1>A plain HTML page</h1>${page}<script type="module" src="/critiqs.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    // The script tag in <head>, run before <body> exists: the page arrives in two parts.
    if (path === "/streamed") {
      const [head, body] = scriptPage.split("<body>");
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(head!.replace(" async>", ">")));
          await Bun.sleep(500);
          controller.enqueue(new TextEncoder().encode(`<body>${body}`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/html" } });
    }
    if (path === "/script") return new Response(scriptPage, { headers: { "content-type": "text/html" } });
    // A strict policy: scripts and styles only from this site, no inline styles.
    if (path === "/strict") {
      return new Response(scriptPage, { headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'; style-src 'self'" } });
    }
    const turboPage = turboPages[path];
    if (turboPage !== undefined) {
      return new Response(
        `<!doctype html><html><head><title>Turbo page</title><meta name="turbo-refresh-method" content="morph"><script type="module" src="/turbo.js"></script></head><body>${turboPage.replace("${served}", String(++served))}${turboApp}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/turbo.js") return new Response(Bun.file(turbo), { headers: { "content-type": "text/javascript" } });
    if (path === "/critiqs-classic.js") return new Response(Bun.file(classic), { headers: { "content-type": "text/javascript" } });
    if (path === "/critiqs.js") return new Response(Bun.file(element), { headers: { "content-type": "text/javascript" } });
    return new Response("", { status: 404 });
  },
});
try {
  const { toolbar, errors } = await expectToolbar(`http://localhost:${server.port}/`, "plain-html");
  assert.deepEqual(errors, []);
  assert.match(toolbar, /Set up Critiqs/);
  const configured = await expectToolbar(`http://localhost:${server.port}/configured`, "plain-html-configured");
  assert.deepEqual(configured.errors, []);
  assert.doesNotMatch(configured.toolbar, /Set up Critiqs/);
  const tag = await expectToolbar(`http://localhost:${server.port}/script`, "plain-html-script-tag");
  assert.deepEqual(tag.errors, []);
  assert.doesNotMatch(tag.toolbar, /Set up Critiqs/);
  console.log(`Plain HTML (script tag): ${JSON.stringify(tag.toolbar)}.`);
  const strict = await expectToolbar(`http://localhost:${server.port}/strict`, "plain-html-strict-csp");
  assert.deepEqual(strict.errors, []);
  console.log(`Plain HTML (strict Content-Security-Policy): ${JSON.stringify(strict.toolbar)}.`);
  const streamed = await expectToolbar(`http://localhost:${server.port}/streamed`, "plain-html-script-before-body");
  assert.deepEqual(streamed.errors, []);
  console.log(`Plain HTML (script tag before <body>): ${JSON.stringify(streamed.toolbar)}.`);
  await checkTurbo(`http://localhost:${server.port}`);
  console.log(`Plain HTML: Critiqs's toolbar appears from element.js (setup: ${JSON.stringify(toolbar)}; configured: ${JSON.stringify(configured.toolbar)}).`);
} finally {
  server.stop();
  backend.stop();
}

/**
 * Turbo replaces the page's body on each visit, keeps a copy of the old body
 * for Back, and takes `data-turbo-temporary` elements out of the live page
 * before keeping that copy, including when a frame link advances the URL.
 * After each step there must be exactly one Critiqs, styled and on screen.
 */
async function checkTurbo(origin: string) {
  await inChrome(async (page, errors) => {
    // A visit Turbo handles keeps this mark; a full page load would lose it.
    const sameDocument = () => page.evaluate(() => (window as { turboMark?: boolean }).turboMark === true);
    const heading = (text: string) => page.waitForFunction((expected) => document.querySelector("h1")?.textContent === expected, text, { timeout: 10_000 });
    await page.goto(`${origin}/turbo/a`);
    await page.waitForFunction(() => "Turbo" in window, undefined, { timeout: 10_000 });
    await page.evaluate(() => void ((window as { turboMark?: boolean }).turboMark = true));
    await expectOneToolbar(page, "turbo-1-page-a");

    await page.click("#to-b");
    await heading("Turbo page B");
    await expectOneToolbar(page, "turbo-2-visit-b");

    // Back shows Turbo's copy of page A first.
    await page.goBack();
    await heading("Turbo page A");
    await expectOneToolbar(page, "turbo-3-back-to-a");

    // The frame changes and the URL advances; the body, and Critiqs, stay.
    await page.click("#advance");
    await page.waitForSelector("#panel-open", { timeout: 10_000 });
    assert.match(page.url(), /\/turbo\/panel$/);
    await expectOneToolbar(page, "turbo-4-frame-advance");

    await page.goBack();
    await page.waitForSelector("#advance", { timeout: 10_000 });
    await expectOneToolbar(page, "turbo-5-back-from-frame");

    // A refresh of the same page morphs it in place (turbo-refresh-method morph), removing what the new HTML lacks.
    const before = await page.evaluate(() => document.querySelector("#served")?.textContent ?? "");
    await page.evaluate(() => (window as unknown as { Turbo: { visit(url: string, options: { action: string }): void } }).Turbo.visit(location.href, { action: "replace" }));
    await page.waitForFunction((old) => document.querySelector("#served")?.textContent !== old, before, { timeout: 10_000 });
    await expectOneToolbar(page, "turbo-6-morph-refresh");

    assert.ok(await sameDocument(), "The Turbo steps should stay in one document, not load pages in full.");
    assert.deepEqual(errors, []);
  });
  console.log("Plain HTML (Turbo 8): one Critiqs after a visit, Back, a frame link that advances the URL, Back again, and a morph refresh.");
}
