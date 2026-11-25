import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// The rendering library, replaced so tests control how long copying the page
// takes. Like the real one, it copies elements in one chain of promise
// callbacks, awaiting `onCloneEachNode` after each element.
type Options = {
  sandbox?: HTMLIFrameElement;
  filter?: (node: Node) => boolean;
  includeStyleProperties?: string[] | null;
  onCloneEachNode?: (node: Node) => unknown;
  onCloneNode?: (node: Node) => unknown;
};
let copyElements: (options: Options) => Promise<void> = async () => {};
let lastOptions: Options | null = null;
let destroyed = 0;
let frameWhenCopying: { connected: boolean; loaded: boolean; copied: boolean | undefined } | null = null;

mock.module("modern-screenshot", () => ({
  createContext: async (node: Node, options: Options) => ({ ...options, node, width: 800, height: 600, drawImageCount: 0 }),
  destroyContext: (context: Options) => {
    destroyed++;
    context.sandbox?.remove();
  },
  domToForeignObjectSvg: async (nodeOrContext: Options & { node?: Node }, options?: Options) => {
    lastOptions = options ?? nodeOrContext;
    const frame = lastOptions.sandbox;
    frameWhenCopying = frame ? { connected: frame.isConnected, loaded: frame.contentDocument?.body != null, copied: lastOptions.filter?.(frame) } : null;
    await copyElements(lastOptions);
    await lastOptions.onCloneNode?.(document.documentElement);
    return document.createElementNS("http://www.w3.org/2000/svg", "svg");
  },
}));

const { captureView } = await import("../src/capture.ts");

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
const originalDecode = HTMLImageElement.prototype.decode;
let decodes = true;

beforeEach(() => {
  copyElements = async () => {};
  lastOptions = null;
  destroyed = 0;
  frameWhenCopying = null;
  decodes = true;
  HTMLImageElement.prototype.decode = () => (decodes ? Promise.resolve() : Promise.reject(new Error("EncodingError")));
  const drawing = { clearRect() {}, drawImage() {}, scale() {}, fillRect() {}, strokeRect() {} };
  HTMLCanvasElement.prototype.getContext = (() => drawing) as never;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(new Blob(["png"], { type: "image/png" }));
  };
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
  HTMLImageElement.prototype.decode = originalDecode;
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
});

/** Copies elements without yielding, for `ms`, like a large page. */
const copyFor = (ms: number) => async (options: Options) => {
  const end = performance.now() + ms;
  while (performance.now() < end) await options.onCloneEachNode?.(document.body);
};

test("copies standard CSS properties but not the custom properties every element inherits", async () => {
  document.documentElement.style.setProperty("--brand-color", "#123456");

  expect(await captureView(document.createElement("critiqs-root"), null)).toMatchObject({ status: "captured" });

  const copied = lastOptions?.includeStyleProperties ?? [];
  expect(copied).toContain("display");
  expect(copied.filter((name) => name.startsWith("--"))).toEqual([]);
});

test("leaves every mounted Critiqs out of the copy", async () => {
  const own = document.body.appendChild(document.createElement("critiqs-root"));
  const other = document.body.appendChild(document.createElement("critiqs-root"));
  const content = document.body.appendChild(document.createElement("main"));

  await captureView(own, null);

  expect([own, other, content].map((node) => lastOptions?.filter?.(node))).toEqual([false, false, true]);
});

test("stops copying and fails once the time limit passes, even while copying never yields", async () => {
  copyElements = copyFor(3_000);
  const started = performance.now();

  const result = await captureView(document.createElement("critiqs-root"), null, 100);

  expect(result).toEqual({ status: "failed", reason: "The capture took too long." });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(destroyed).toBeGreaterThan(0);
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

test("lets the page handle timers while it is copied", async () => {
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  let ticksWhileCopying = 0;
  copyElements = async (options) => {
    await copyFor(300)(options);
    ticksWhileCopying = ticks;
  };

  try {
    expect(await captureView(document.createElement("critiqs-root"), null)).toMatchObject({ status: "captured" });
  } finally {
    clearInterval(interval);
  }

  expect(ticksWhileCopying).toBeGreaterThan(0);
  expect(destroyed).toBeGreaterThan(0);
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

test("adds the frame used for default styles, loaded, before copying, and removes it afterwards", async () => {
  // Copying yields to the page, so a frame the library added mid-copy could
  // finish loading and replace its document while being read.
  expect(await captureView(document.createElement("critiqs-root"), null)).toMatchObject({ status: "captured" });

  expect(frameWhenCopying).toEqual({ connected: true, loaded: true, copied: false });
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

test("fails instead of saving a blank capture when the copied page can't be drawn", async () => {
  decodes = false;

  expect(await captureView(document.createElement("critiqs-root"), null)).toEqual({
    status: "failed",
    reason: "The browser could not draw the copied page.",
  });
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

test("fails at the time limit and removes its frame while the renderer waits on media that never loads", async () => {
  // Like a video that never reports its data: no check of the time limit runs.
  copyElements = () => new Promise(() => {});
  const started = performance.now();

  const result = await captureView(document.createElement("critiqs-root"), null, 100);

  expect(result).toEqual({ status: "failed", reason: "The capture took too long." });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

test("never copies anything inside a masked element, through shadow roots and slots", async () => {
  const masked = document.body.appendChild(document.createElement("section"));
  masked.setAttribute("data-critiqs-mask", "");
  const text = masked.appendChild(document.createTextNode("Patient: Jane Example"));
  const image = masked.appendChild(document.createElement("img"));
  const host = masked.appendChild(document.createElement("div"));
  const shadowText = host.attachShadow({ mode: "open" }).appendChild(document.createElement("b"));
  const outsideHost = document.body.appendChild(document.createElement("div"));
  const shadow = outsideHost.attachShadow({ mode: "open" });
  const maskedInShadow = shadow.appendChild(document.createElement("div"));
  maskedInShadow.setAttribute("data-critiqs-mask", "");
  const slot = maskedInShadow.appendChild(document.createElement("slot"));
  const slotted = outsideHost.appendChild(document.createElement("span"));
  // Browsers report where a light child is shown; the test DOM does not.
  Object.defineProperty(slotted, "assignedSlot", { value: slot });
  const plain = document.body.appendChild(document.createElement("p"));

  await captureView(document.createElement("critiqs-root"), null);

  const copied = (node: Node) => lastOptions?.filter?.(node);
  expect([masked, plain, outsideHost, maskedInShadow].map(copied)).toEqual([true, true, true, true]);
  expect([text, image, host, shadowText, slotted].map(copied)).toEqual([false, false, false, false, false]);
});

test("covers a masked element's copy: no content, attributes or generated text, filled with the mask color", async () => {
  const copy = document.createElement("img");
  copy.setAttribute("data-critiqs-mask", "");
  copy.setAttribute("src", "https://example.test/private.png");
  copy.setAttribute("class", "tip generated-before");
  copy.setAttribute("value", "Private value");
  copy.setAttribute("style", "width: 120px; height: 60px; background: red");
  copy.appendChild(document.createTextNode("Private text"));
  copyElements = async (options) => {
    await options.onCloneEachNode?.(copy);
  };

  expect(await captureView(document.createElement("critiqs-root"), null)).toMatchObject({ status: "captured" });

  expect(copy.childNodes).toHaveLength(0);
  expect(copy.getAttributeNames()).toEqual(["style"]);
  expect(copy.style.getPropertyValue("width")).toBe("120px");
  expect(copy.style.getPropertyValue("color")).toBe("transparent");
  expect(copy.style.getPropertyValue("background")).toContain("#6b7280");
});

for (const tag of ["canvas", "video", "iframe"]) {
  test(`fails safely before a directly masked ${tag} loses its privacy marker in a renderer replacement`, async () => {
    const source = document.body.appendChild(document.createElement(tag));
    source.setAttribute("data-critiqs-mask", "");
    copyElements = async (options) => {
      options.filter?.(source);
      // These renderer replacements do not retain the source attributes.
      await options.onCloneEachNode?.(document.createElement("img"));
    };

    expect(await captureView(document.createElement("critiqs-root"), null)).toEqual({
      status: "failed",
      reason: "The browser could not safely hide the private media in this page.",
    });
    expect(source.hasAttribute("data-critiqs-mask")).toBe(true);
    expect(document.querySelectorAll("iframe").length).toBe(tag === "iframe" ? 1 : 0);
  });
}

test("a containing privacy mask excludes replacement media before the renderer reads it", async () => {
  const container = document.body.appendChild(document.createElement("section"));
  container.setAttribute("data-critiqs-mask", "");
  const media = ["canvas", "video", "iframe"].map((tag) => container.appendChild(document.createElement(tag)));
  copyElements = async (options) => {
    expect(options.filter?.(container)).toBe(true);
    for (const node of media) expect(options.filter?.(node)).toBe(false);
    await options.onCloneEachNode?.(container.cloneNode(false));
  };

  expect(await captureView(document.createElement("critiqs-root"), null)).toMatchObject({ status: "captured" });
});
