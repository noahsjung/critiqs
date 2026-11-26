// Critiqs's two halves in two documents, as a review link will run them: the
// prototype, on its own origin in a frame, runs only the page layer; the page
// around it, on another origin, runs the panel, with Critiqs's own server
// (SQLite, signed in through the host-app hook) behind it. They talk only
// through postMessage. Chrome checks that a reviewer can pick an element in
// the frame, write the comment in the panel, see its pin on the prototype,
// and open the thread from that pin; that a screenshot supplied from outside
// the page is saved with the mask and marker drawn on; and that a page on a
// third origin framing the prototype gets no answer from its page layer.
//
// Set CHROME_PATH to choose the browser and CRITIQS_EVIDENCE_DIR to keep
// screenshots.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCritiqsHandler } from "../../server/src/http/index.ts";
import { type BrowserPage, inChrome, scratch } from "../../../scripts/consumer-kit.ts";

const here = fileURLToPath(new URL("./two-documents/", import.meta.url));
const dir = await scratch("two-documents");
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));

const build = async (entry: string) => {
  const result = await Bun.build({
    entrypoints: [join(here, entry)],
    target: "browser",
    format: "iife",
    jsx: { runtime: "automatic", development: false },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new AggregateError(result.logs, `${entry} didn't build.`);
  return await result.outputs[0]!.text();
};
const [pageScript, panelScript] = await Promise.all([build("page.ts"), build("panel.ts")]);

const critiqs = await createCritiqsHandler({
  database: join(dir, "critiqs.sqlite"),
  identify: () => ({ id: "dana", name: "Dana Reviewer", email: "dana@example.com" }),
});
const javascript = (text: string) => new Response(text, { headers: { "content-type": "text/javascript; charset=utf-8" } });
const html = (text: string) => new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });

/** The prototype's masked fields: one in the page, one inside a design-system field's open shadow root. */
const MASKED = `
        <input data-critiqs-mask value="api key: sk-not-for-captures" aria-label="API key">
        <card-field></card-field>
        <script>
          // A design-system field whose private input lives in an open shadow root.
          customElements.define("card-field", class extends HTMLElement {
            connectedCallback() {
              const input = document.createElement("input");
              input.setAttribute("data-critiqs-mask", "");
              input.value = "4242 4242 4242 4242";
              input.style.cssText = "font: inherit; display: block; margin-top: 16px; padding: 8px; width: 280px;";
              this.attachShadow({ mode: "open" }).append(input);
            }
          });
        </script>`;

// The prototype, on 127.0.0.1: a page with a record, a target, and a masked field.
const prototype = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request): Response {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/page.js") return javascript(pageScript);
    // `?plain`: the same page with nothing masked.
    const masked = searchParams.has("plain") ? "" : MASKED;
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>Prototype</title><style>
      body { font: 16px system-ui; margin: 0; padding: 32px; background: #fff; }
      section { border: 1px solid #ddd; border-radius: 8px; padding: 24px; max-width: 520px; }
      button { font: inherit; padding: 8px 16px; }
      input { font: inherit; display: block; margin-top: 16px; padding: 8px; width: 280px; }
    </style></head><body>
      <h1>Team settings</h1>
      <section data-critiqs-record="team-42">
        <p>Members can invite others and change the team's name.</p>
        <button data-critiqs-id="team.save">Save changes</button>
        ${masked}
      </section>
      <script src="/page.js" data-panel-origin="${panelOrigin()}"></script>
    </body></html>`);
  },
});
const prototypeOrigin: string = `http://127.0.0.1:${prototype.port}`;

// The page around the frame, on localhost, with Critiqs's server at /critiqs. `?project=` names the project.
const panel = Bun.serve({
  port: 0,
  hostname: "localhost",
  async fetch(request, server): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/critiqs" || pathname.startsWith("/critiqs/")) {
      return critiqs.fetch(request, { remoteAddress: server.requestIP(request)?.address });
    }
    if (pathname === "/panel.js") return javascript(panelScript);
    const projectId = new URL(request.url).searchParams.get("project") ?? "";
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>Review</title><style>
      body { margin: 0; background: #f4f4f5; }
      #prototype { position: fixed; left: 0; top: 0; width: calc(100% - 360px); height: 100%; border: 0; background: #fff; }
    </style></head><body>
      <iframe id="prototype" title="Prototype" src="${prototypeOrigin}/${new URL(request.url).searchParams.has("plain") ? "?plain" : ""}"></iframe>
      <script src="/panel.js" data-page-origin="${prototypeOrigin}" data-project-id="${projectId}"></script>
    </body></html>`);
  },
});
function panelOrigin(): string {
  return `http://localhost:${panel.port}`;
}

// A third site that frames the prototype and tries to drive its page layer.
const stranger = Bun.serve({
  port: 0,
  hostname: "localhost",
  fetch(): Response {
    return html(`<!doctype html><html><body><iframe id="prototype" src="${prototypeOrigin}/" style="width:800px;height:600px"></iframe></body></html>`);
  },
});

/** A new project for the panel to review, created as the signed-in reviewer. */
async function createProject(name: string): Promise<string> {
  const created = await critiqs.fetch(
    new Request(`${panelOrigin()}/critiqs/api/createProject`, {
      method: "POST",
      headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  const id = ((await created.json()) as { value: string }).value;
  assert.match(id, /^\w+$/, "the project should be created");
  return id;
}

const evidence = process.env.CRITIQS_EVIDENCE_DIR;
const shot = async (page: BrowserPage, name: string) => {
  if (evidence === undefined || evidence === "") return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) });
};

/** Calls in the panel's document, or in the prototype's frame, through Critiqs's shadow root. */
const inPanel = <T, A = undefined>(page: BrowserPage, fn: (root: ShadowRoot, arg: A) => T, arg?: A) =>
  page.evaluate(([source, value]) => new Function("root", "arg", `return (${source})(root, arg)`)(document.querySelector("critiqs-root")!.shadowRoot, value) as T, [fn.toString(), arg] as const);

type Frame = { evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>; waitForFunction<A>(fn: (arg: A) => boolean, arg: A, options: { timeout: number }): Promise<unknown>; click(selector: string): Promise<void>; hover(selector: string): Promise<void>; url(): string };
const frameOf = (page: BrowserPage) => (page as unknown as { frames(): Frame[] }).frames().find((frame) => frame.url().startsWith(prototypeOrigin))!;

/**
 * Moves the real mouse onto an element in the frame until Comment mode
 * outlines it. Picking starts listening just after its hint shows, so a single
 * move can arrive first; moving again is what a reviewer's mouse does anyway.
 */
async function hoverInFrame(page: BrowserPage, frame: Frame, selector: string) {
  const mouse = (page as unknown as { mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> } }).mouse;
  // The frame sits at the page's top left, so its coordinates are the page's.
  const box = await frame.evaluate((target) => {
    const { x, y, width, height } = document.querySelector(target)!.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  }, selector);
  for (let attempt = 0; attempt < 20; attempt++) {
    await mouse.move(box.x - 30, box.y + 60, { steps: 2 });
    await mouse.move(box.x, box.y, { steps: 4 });
    const outlined = await frame.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".target-box") !== null, undefined);
    if (outlined) return;
    await Bun.sleep(100);
  }
  throw new Error(`Comment mode never outlined ${selector} in the frame.`);
}

/** Runs the whole review: pick, comment, pin, open from the pin. Returns the saved thread's capture as the panel shows it. */
async function review(page: BrowserPage, { url, prefix, text }: { url: string; prefix: string; text: string }) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null, undefined, { timeout: 20_000 });
  const frame = frameOf(page);
  // The page layer in the frame draws nothing of the panel: no toolbar, no sidebar.
  await frame.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".layer") != null, undefined, { timeout: 20_000 });
  assert.equal(await frame.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".toolbar, .sidebar, .thread-window"), undefined), null);
  await shot(page, `${prefix}-1-loaded`);

  // Comment mode in the panel turns on picking in the frame.
  await inPanel(page, (root) => root.querySelector<HTMLButtonElement>('[aria-label="Comment mode"]')!.click());
  await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".mode-hint") !== null, undefined, { timeout: 10_000 });
  await hoverInFrame(page, frame, '[data-critiqs-id="team.save"]');
  await shot(page, `${prefix}-2-picking`);

  // Picking the button in the frame opens the composer in the panel, and the frame outlines what it's about.
  await frame.click('[data-critiqs-id="team.save"]');
  await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".tag-field") !== null, undefined, { timeout: 10_000 });
  const composer = (page as unknown as { locator(selector: string): { click(): Promise<void>; pressSequentially(text: string): Promise<void> } }).locator(".tag-field");
  await composer.click();
  await composer.pressSequentially(text);
  await shot(page, `${prefix}-3-composing`);
  await inPanel(page, (root) => [...root.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((button) => button.textContent === "Comment")!.click());

  // The pin appears on the prototype, in the frame's own document.
  await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin") !== null, undefined, { timeout: 20_000 });
  const pinLabel = await frame.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin")!.getAttribute("aria-label"), undefined);
  assert.equal(pinLabel, "Open comment by Dana Reviewer");
  // Saving opened the thread; close it, so the pin is what opens it again.
  await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".thread-window") !== null, undefined, { timeout: 10_000 });
  await inPanel(page, (root) => root.querySelector<HTMLButtonElement>('.thread-window [aria-label="Close comment"]')?.click());
  await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".thread-window") === null, undefined, { timeout: 10_000 });
  await shot(page, `${prefix}-4-pin`);

  // Clicking the pin in the frame opens its thread in the panel.
  await frame.evaluate(() => (document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin") as HTMLButtonElement).click(), undefined);
  await page.waitForFunction((expected) => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".thread-window")?.textContent?.includes(expected) === true, text, { timeout: 10_000 });
  await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector('.pin[aria-expanded="true"]') !== null, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => (document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".thread-window img") as HTMLImageElement | null)?.complete === true, undefined, { timeout: 20_000 });
  await shot(page, `${prefix}-5-thread-from-pin`);
  return frame;
}

/** Pixels of the open thread's capture: a corner, the masked fields' centers, and the marker's left edge beside the button. */
async function capturePixels(page: BrowserPage, frame: Frame) {
  const boxes = await frame.evaluate(() => {
    const box = (element: Element | null | undefined) => {
      if (element == null) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      viewportWidth: window.innerWidth,
      button: box(document.querySelector('[data-critiqs-id="team.save"]')),
      mask: box(document.querySelector("input[data-critiqs-mask]")),
      shadowMask: box(document.querySelector("card-field")?.shadowRoot?.querySelector("input")),
    };
  }, undefined);
  type Box = { x: number; y: number; width: number; height: number } | null;
  return inPanel(
    page,
    (root, { viewportWidth, button, mask, shadowMask }: Record<"button" | "mask" | "shadowMask", Box> & { viewportWidth: number }) => {
      const image = root.querySelector(".thread-window img") as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(image, 0, 0);
      // Either capture covers the frame's view, at its own pixel ratio.
      const scale = image.naturalWidth / viewportWidth;
      const at = (x: number, y: number) => [...drawing.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
      const center = (box: Box) => (box === null ? null : at(box.x + box.width / 2, box.y + box.height / 2));
      return {
        width: image.naturalWidth,
        elsewhere: at(10, 10),
        mask: center(mask),
        shadowMask: center(shadowMask),
        marker: button === null ? null : at(button.x - 2, button.y + button.height / 2),
      };
    },
    boxes,
  );
}

const errorsSeen: string[] = [];
try {
  await inChrome(async (page, errors) => {
    // The page's own capture, from its structure (DOM).
    await review(page, { url: `${panelOrigin()}/?project=${await createProject("Team settings")}`, prefix: "dom-capture", text: "Rename this to Save team" });
    const captured = await inPanel(page, (root) => (root.querySelector(".thread-window img") as HTMLImageElement).naturalWidth);
    assert.ok(captured > 0, "the comment's capture should show in its thread");

    // The frame loads another page while a new comment is being written: the
    // draft was about an element of the page that went away, so it is
    // dropped with a notice, and Comment mode carries on in the new page.
    let frame = frameOf(page);
    await hoverInFrame(page, frame, '[data-critiqs-id="team.save"]');
    await frame.click('[data-critiqs-id="team.save"]');
    await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".tag-field") !== null, undefined, { timeout: 10_000 });
    const composer = (page as unknown as { locator(selector: string): { click(): Promise<void>; pressSequentially(text: string): Promise<void> } }).locator(".tag-field");
    await composer.click();
    await composer.pressSequentially("A draft about the old page");
    await frame.evaluate(() => location.reload(), undefined);
    await page.waitForFunction(
      () => {
        const root = document.querySelector("critiqs-root")!.shadowRoot!;
        return root.querySelector(".tag-field") === null && root.textContent!.includes("the new comment was discarded");
      },
      undefined,
      { timeout: 20_000 },
    );
    await shot(page, "dom-capture-6-frame-navigated");
    frame = frameOf(page);
    await frame.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".mode-hint") != null, undefined, { timeout: 20_000 });
    await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin") !== null, undefined, { timeout: 20_000 });
    await hoverInFrame(page, frame, '[data-critiqs-id="team.save"]');
    await frame.click('[data-critiqs-id="team.save"]');
    await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".tag-field") !== null, undefined, { timeout: 10_000 });
    console.log("Frame navigation: the draft about the old page was dropped with a notice; pins and Comment mode came back on the new page.");
    errorsSeen.push(...errors);
  });

  // A screenshot supplied from outside the page, as the extension's captureVisibleTab will be.
  await inChrome(async (page, errors) => {
    // A page with nothing masked: the screenshot is used, with the marker drawn on by the page layer.
    const frame = await review(page, { url: `${panelOrigin()}/?supply&plain&project=${await createProject("Supplied, nothing masked")}`, prefix: "supplied-capture", text: "Use the supplied screenshot" });
    assert.equal(await page.evaluate(() => (window as { suppliedCaptures?: number }).suppliedCaptures), 1);
    const pixels = await capturePixels(page, frame);
    assert.deepEqual(pixels.elsewhere, [20, 184, 166], "the saved capture should be the supplied screenshot");
    assert.deepEqual(pixels.marker, [13, 99, 243]);
    console.log(`Supplied capture, nothing masked: ${pixels.width}px wide; the supplied teal screenshot with the page layer's blue marker.`);
    errorsSeen.push(...errors);
  });
  await inChrome(async (page, errors) => {
    // A page with masked fields, one inside a shadow root: the page's own capture is used, which leaves both out.
    const frame = await review(page, { url: `${panelOrigin()}/?supply&project=${await createProject("Supplied, masked page")}`, prefix: "supplied-masked", text: "Masked page" });
    assert.equal(await page.evaluate(() => (window as { suppliedCaptures?: number }).suppliedCaptures), 1);
    const pixels = await capturePixels(page, frame);
    assert.notDeepEqual(pixels.elsewhere, [20, 184, 166], "a page with masks must not keep the supplied screenshot");
    assert.deepEqual(pixels.mask, [107, 114, 128]);
    assert.deepEqual(pixels.shadowMask, [107, 114, 128], "a masked field inside a shadow root should be covered too");
    console.log("Supplied capture, masked page: the page's own capture was kept instead, with both masked fields covered.");
    errorsSeen.push(...errors);
  });

  await inChrome(async (page) => {
    // A third origin framing the prototype gets no answer: the page layer only hears the panel's origin.
    await page.goto(`http://localhost:${stranger.port}/`);
    const frame = frameOf(page);
    await frame.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".layer") != null, undefined, { timeout: 20_000 });
    const answers = await page.evaluate(async (target) => {
      const received: unknown[] = [];
      window.addEventListener("message", (event) => received.push(event.data));
      const frameWindow = document.querySelector<HTMLIFrameElement>("#prototype")!.contentWindow!;
      const forged = (id: number, method: string, params: unknown) => ({ tag: "critiqs:page-layer", v: 1, channel: "two-documents", kind: "request", id, method, params });
      frameWindow.postMessage(forged(1, "connect", { protocol: 1 }), target);
      frameWindow.postMessage(forged(2, "replaceUrl", { url: "/stolen" }), target);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return received;
    }, prototypeOrigin);
    assert.deepEqual(answers, [], "the page layer must not answer another origin");
    assert.equal(new URL(frame.url()).pathname, "/", "a forged request must not change the prototype's address");
    console.log("A third origin framing the prototype got no answer and changed nothing.");
  });
  assert.deepEqual(errorsSeen, []);
  console.log("Two documents: picking in the frame, commenting in the panel, the pin on the prototype, and opening the thread from it all work over postMessage.");
} finally {
  prototype.stop();
  panel.stop();
  stranger.stop();
  critiqs.close();
}
