import { expect, test } from "bun:test";
import { pageEnvelope, portTransport } from "@critiqs/core";
import type { Port } from "../src/chrome.ts";
import { tabConnection } from "../src/panel/page-connection.ts";
import { fakeChrome, fakePorts, settle } from "./fake-chrome.ts";

/** A tab whose content script answers each port the side panel opens, until the page goes away. */
function tabWithPage() {
  const chrome = fakeChrome();
  const pages: Port[] = [];
  let listening = true;
  chrome.behavior.connect = (_tabId, name) => {
    const [page, panel] = fakePorts(name);
    if (!listening) {
      queueMicrotask(() => page.disconnect());
      return panel;
    }
    pages.push(page);
    // The page layer says it is ready as soon as the panel connects.
    queueMicrotask(() => page.postMessage(pageEnvelope("critiqs-extension", { kind: "event", event: "ready", data: { protocol: 1 } })));
    return panel;
  };
  return { chrome, pages, setListening: (value: boolean) => (listening = value) };
}

const fromTab = (tabId: number, frameId = 0) => ({ tab: { id: tabId, windowId: 1, active: true }, frameId });

test("the panel connects to its tab's page layer, and hears it", async () => {
  const { chrome } = tabWithPage();
  const connection = tabConnection(chrome, 7);
  const received: unknown[] = [];
  connection.transport.listen((message) => received.push(message));
  connection.connect();
  await settle();
  expect(connection.connected()).toBe(true);
  expect(received).toHaveLength(1);
});

test("a tab with no page layer yet isn't connected, and connects once the page layer says it is listening", async () => {
  const tab = tabWithPage();
  tab.setListening(false);
  const connection = tabConnection(tab.chrome, 7);
  connection.connect();
  await settle();
  expect(connection.connected()).toBe(false);
  tab.setListening(true);
  // Another tab's page, and a frame inside this one, don't count.
  tab.chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromTab(8), () => {});
  tab.chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromTab(7, 2), () => {});
  await settle();
  expect(connection.connected()).toBe(false);
  tab.chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromTab(7), () => {});
  await settle();
  expect(connection.connected()).toBe(true);
});

test("when the tab loads another page, the same transport carries on with that page's page layer", async () => {
  const tab = tabWithPage();
  const connection = tabConnection(tab.chrome, 7);
  const received: unknown[] = [];
  connection.transport.listen((message) => received.push(message));
  let closed = false;
  connection.transport.onClose(() => (closed = true));
  connection.connect();
  await settle();
  // The old page goes away: its port ends.
  tab.pages[0]!.disconnect();
  await settle();
  tab.chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromTab(7), () => {});
  await settle();
  expect(closed).toBe(false);
  expect(connection.connected()).toBe(true);
  expect(received).toHaveLength(2);
  // What the panel sends goes to the new page.
  const heard: unknown[] = [];
  tab.pages.at(-1)!.onMessage.addListener((message) => heard.push(message));
  connection.transport.send(pageEnvelope("critiqs-extension", { kind: "request", id: 1, method: "connect", params: { protocol: 1 } }) as never);
  await settle();
  expect(heard).toHaveLength(1);
});

test("a second click on a page already connected doesn't replace its page layer, which would drop a draft", async () => {
  const tab = tabWithPage();
  const connection = tabConnection(tab.chrome, 7);
  connection.connect();
  await settle();
  tab.chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromTab(7), () => {});
  await settle();
  expect(tab.pages).toHaveLength(1);
});

test("images survive the port, which carries JSON only", async () => {
  const [a, b] = fakePorts("critiqs:panel");
  const received: unknown[] = [];
  portTransport(b).listen((message) => received.push(message));
  portTransport(a).send({ image: new Blob(["png"], { type: "image/png" }) } as never);
  await settle(10);
  expect(await (received[0] as { image: Blob }).image.text()).toBe("png");
});

test("a panel another panel replaced for the tab doesn't connect again and take the page back", async () => {
  const tab = tabWithPage();
  const first = tabConnection(tab.chrome, 7);
  first.connect();
  await settle();
  // The content script hands the page layer to another panel and tells this one.
  tab.pages[0]!.postMessage({ type: "critiqs:replaced" });
  tab.pages[0]!.disconnect();
  await settle();
  expect(first.connected()).toBe(false);
  expect(tab.pages).toHaveLength(1);
});
