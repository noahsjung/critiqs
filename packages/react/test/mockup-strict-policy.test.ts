import { afterEach, expect, test } from "bun:test";
import { MOCKUP_STYLE_ATTRIBUTE } from "@critiqs/core";
import { renderSnapshot } from "../src/mockup/render.ts";

// Mockup mode shows the page's copy in a frame from `srcdoc`, which takes the
// page's Content-Security-Policy. A strict policy refuses the copy's <style>
// elements and style attributes, and the copy loses its look. Constructed
// stylesheets and CSSOM changes aren't governed by the policy, so the copy's
// refused styles move there, in order. happy-dom has no policy: a refused
// <style> is one whose `sheet` is null, as Chrome reports it; a refused style
// attribute leaves the element's style empty (Chrome only;
// the real-browser check covers it).

const COPY = `<!DOCTYPE html><html><head>
<style>body { font-family: system-ui; color: rgb(1, 2, 3); }</style>
<style media="print">body { color: rgb(9, 9, 9); }</style>
<style>p { color: rgb(4, 5, 6); }</style>
</head><body><p id="first">One</p><p id="second" style="color: rgb(7, 8, 9); margin-left: 12px">Two</p></body></html>`;

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

/** A frame that refuses the copy's <style> elements as a strict policy would, once it loads. */
function strictFrame() {
  const frame = document.createElement("iframe");
  frames.push(frame);
  document.body.append(frame);
  frame.addEventListener("load", () => {
    const view = frame.contentWindow as unknown as typeof globalThis;
    Object.defineProperty(view.HTMLStyleElement.prototype, "sheet", { configurable: true, get: () => null });
  }, { once: true });
  return frame;
}

const sheetText = (sheet: CSSStyleSheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText).join(" ");

test("under a strict policy, every refused <style> becomes an adopted stylesheet in order, with its media, and style attributes still apply", async () => {
  const frame = strictFrame();
  await renderSnapshot(frame, COPY, []);
  const doc = frame.contentDocument!;
  const adopted = doc.adoptedStyleSheets;
  expect(adopted.map(sheetText)).toEqual([
    expect.stringContaining("font-family: system-ui"),
    expect.stringContaining("rgb(9, 9, 9)"),
    expect.stringContaining("rgb(4, 5, 6)"),
  ]);
  // The refused elements are gone, so nothing refused stays in the copy.
  expect(doc.querySelectorAll("style").length).toBe(0);
  const second = doc.getElementById("second")!;
  expect(second.style.getPropertyValue("color")).toBe("rgb(7, 8, 9)");
  expect(second.style.getPropertyValue("margin-left")).toBe("12px");
});

test("the media of each moved stylesheet is the <style> element's own", async () => {
  const frame = strictFrame();
  const media: string[] = [];
  frame.addEventListener("load", () => {
    const view = frame.contentWindow as unknown as typeof globalThis;
    const Original = view.CSSStyleSheet;
    view.CSSStyleSheet = class extends Original {
      constructor(options?: CSSStyleSheetInit) {
        super(options);
        media.push(String(options?.media ?? ""));
      }
    } as typeof CSSStyleSheet;
  }, { once: true });
  await renderSnapshot(frame, COPY, []);
  expect(media).toEqual(["", "print", ""]);
});

test("a version's changes still win over the page's own rules once moved", async () => {
  const frame = strictFrame();
  await renderSnapshot(frame, COPY, [{ kind: "css", css: "p { color: rgb(0, 128, 0); }" }]);
  const doc = frame.contentDocument!;
  const last = doc.adoptedStyleSheets.at(-1)!;
  expect(sheetText(last)).toContain("rgb(0, 128, 0) !important");
  expect(doc.querySelector(`style[${MOCKUP_STYLE_ATTRIBUTE}]`)).toBeNull();
});

test("without a policy, the copy keeps its <style> elements as they were and adopts nothing", async () => {
  const frame = document.createElement("iframe");
  frames.push(frame);
  document.body.append(frame);
  await renderSnapshot(frame, COPY, []);
  const doc = frame.contentDocument!;
  expect(doc.adoptedStyleSheets).toEqual([]);
  expect(Array.from(doc.querySelectorAll("style")).map((style) => style.getAttribute("media"))).toEqual([null, "print", null]);
});
