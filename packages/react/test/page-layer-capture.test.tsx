import { afterEach, expect, mock, test } from "bun:test";
import { directTransports, type PagePanelEndpoint, panelEndpoint } from "@critiqs/core";
import { act } from "react";
import type { CaptureResult } from "../src/capture.ts";

// A screenshot supplied from outside the page (an extension's
// captureVisibleTab) shows masked content, and whatever overflows it, wherever
// it was at that instant. So the page layer uses one only on a page with
// nothing masked, and only when nothing changed between hiding the pins and
// receiving it; otherwise it captures from the page's structure, which leaves
// masked content out as it copies.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let masked = false;
const used: string[] = [];
mock.module("../src/capture.ts", () => ({
  captureView: async (): Promise<CaptureResult> => {
    used.push("page");
    return { status: "captured", image: new Blob(["dom"], { type: "image/png" }) };
  },
}));
mock.module("../src/capture-supplied.ts", () => ({
  hasMasks: () => masked,
  markSuppliedCapture: async (): Promise<CaptureResult> => {
    used.push("supplied");
    return { status: "captured", image: new Blob(["supplied"], { type: "image/png" }) };
  },
}));
const { createPageLayer } = await import("../src/page-layer/layer.tsx");

let destroy: (() => void) | null = null;
afterEach(async () => {
  await act(async () => destroy?.());
  destroy = null;
  used.length = 0;
  masked = false;
  document.body.replaceChildren();
});

async function start(): Promise<PagePanelEndpoint> {
  const host = document.createElement("critiqs-root");
  document.body.append(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const [panelSide, pageSide] = directTransports();
  const layer = createPageLayer({ transport: pageSide, channel: "capture", host, container });
  destroy = layer.destroy;
  return panelEndpoint(panelSide, { channel: "capture" });
}

const screenshot = new Blob(["from outside"], { type: "image/png" });
const conceal = (panel: PagePanelEndpoint) => act(async () => void (await panel.request("conceal", { concealed: true })));
const capture = (panel: PagePanelEndpoint) => act(async () => void (await panel.request("capture", { marker: null, image: screenshot })));

test("a supplied screenshot of a page with nothing masked is used, with the marker drawn on", async () => {
  const panel = await start();
  await conceal(panel);
  await capture(panel);
  expect(used).toEqual(["supplied"]);
});

test("a page with anything masked uses its own capture, which leaves masked content out", async () => {
  const panel = await start();
  masked = true;
  await conceal(panel);
  await capture(panel);
  expect(used).toEqual(["page"]);
});

test("a mask that appears after the pins are hidden means the page's own capture", async () => {
  const panel = await start();
  await conceal(panel);
  masked = true;
  await capture(panel);
  expect(used).toEqual(["page"]);
});

test("a supplied screenshot without the pins hidden first is never used", async () => {
  const panel = await start();
  await capture(panel);
  expect(used).toEqual(["page"]);
});

test("anything that changes on the page after the pins are hidden, even if it changes back, means the page's own capture", async () => {
  const panel = await start();
  await conceal(panel);
  await act(async () => void window.dispatchEvent(new Event("scroll")));
  await capture(panel);
  await conceal(panel);
  await act(async () => {
    const moved = document.createElement("p");
    document.body.append(moved);
    moved.remove();
  });
  await capture(panel);
  expect(used).toEqual(["page", "page"]);
});
