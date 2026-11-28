import { afterEach, expect, test } from "bun:test";
import {
  directTransports,
  type ElementRef,
  type PageDisplay,
  type PageEvents,
  type PageMessage,
  type PageTransport,
  panelEndpoint,
  type TargetLocation,
} from "@critiqs/core";
import { act } from "react";
import { createPageLayer, type PageLayer } from "../src/page-layer/layer.tsx";
import { PageLink } from "../src/page-layer/link.ts";
import type { HostContext } from "../src/host.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHANNEL = "test";
const NOTHING: PageDisplay = { hidden: false, exposedRight: null, watch: [], pins: [], selected: null, highlight: null, picking: null, picked: null };
const at = (purposeId: string): TargetLocation => ({
  screen: "settings",
  viewState: {},
  scope: "shared",
  target: { purposeId, recordKey: null, clues: { tagName: "button", role: null, label: null, path: "" } },
});
const originalUrl = window.location.href;

let layer: PageLayer | null = null;
let page: HTMLElement | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => layer?.destroy());
  layer = null;
  page?.remove();
  host?.remove();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

/** A button the page shows, at a fixed place on screen. */
function button(purposeId: string) {
  const element = document.createElement("button");
  element.setAttribute("data-critiqs-id", purposeId);
  element.textContent = purposeId;
  element.getBoundingClientRect = () => new DOMRect(40, 80, 120, 30);
  element.getClientRects = () => [new DOMRect(40, 80, 120, 30)] as unknown as DOMRectList;
  (element as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  return element;
}

/**
 * Messages delivered later and copied, as between two documents: nothing the
 * panel holds is an object of the page's, and nothing arrives in the same call.
 */
function apartTransports(): [PageTransport, PageTransport] {
  const [a, b] = directTransports();
  const apart = (end: PageTransport): PageTransport => ({
    ...end,
    send: (message) => {
      const copy = structuredClone(message) as PageMessage;
      setTimeout(() => end.send(copy));
    },
  });
  return [apart(a), apart(b)];
}

async function start({
  restoreContext,
  transports = directTransports(),
  getContext = () => ({ screen: "settings" }),
}: { restoreContext?: (request: { signal: AbortSignal }) => Promise<void>; transports?: [PageTransport, PageTransport]; getContext?: () => HostContext } = {}) {
  page = document.createElement("main");
  page.append(button("save"));
  document.body.append(page);
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const [panelSide, pageSide] = transports;
  layer = createPageLayer({
    transport: pageSide,
    channel: CHANNEL,
    host,
    shadow: host.shadowRoot!,
    container,
    pageHost: { getContext, ...(restoreContext === undefined ? {} : { restoreContext }) },
  });
  const panel = panelEndpoint(panelSide, { channel: CHANNEL });
  const events: { [E in keyof PageEvents]?: PageEvents[E][] } = {};
  for (const name of ["picked", "pin", "state", "outsideClick"] as const) {
    panel.on(name, (data) => ((events[name] ??= [] as never) as unknown[]).push(data));
  }
  return { panel, events, shadow: host.shadowRoot! };
}

test("the page layer locates watched threads and draws pins only for those it finds", async () => {
  const { panel, events, shadow } = await start();
  const state = await act(async () =>
    panel.request("display", {
      ...NOTHING,
      watch: [
        { threadId: "shown", location: at("save") },
        { threadId: "gone", location: at("delete") },
        { threadId: "elsewhere", location: { ...at("save"), screen: "billing" } },
      ],
      pins: ["shown", "gone", "elsewhere"].map((threadId) => ({ threadId, authorName: "Dana Reviewer", unread: false, resolved: false, tickets: [] })),
    }),
  );
  expect(state.located.shown).toEqual({ status: "found", occurrences: [{ ref: expect.any(String), recordKey: null }] });
  expect(state.located.gone).toEqual({ status: "not-found" });
  expect(state.located.elsewhere).toBeNull();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const pins = shadow.querySelectorAll<HTMLButtonElement>(".pin");
  expect(pins).toHaveLength(1);
  // A pin's click names its thread and the occurrence, by the same handle the panel was given.
  await act(async () => pins[0]!.click());
  const found = state.located.shown!;
  expect(events.pin).toEqual([{ threadId: "shown", occurrence: found.status === "found" ? found.occurrences[0]! : (null as never) }]);
});

test("in Comment mode, a click on the page is kept from it and reported as a handle, the target, and the context", async () => {
  const { panel, events, shadow } = await start();
  const target = page!.querySelector("button")!;
  let pageSawClick = false;
  target.addEventListener("click", () => (pageSawClick = true));
  document.elementFromPoint = () => target;
  await act(async () => void (await panel.request("display", { ...NOTHING, picking: { hint: "Select an element", paused: false } })));
  expect(shadow.querySelector(".mode-hint")?.textContent).toBe("Select an element");
  await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
  expect(pageSawClick).toBe(false);
  expect(events.picked).toEqual([
    {
      occurrence: { ref: expect.any(String), recordKey: null },
      target: { purposeId: "save", recordKey: null, clues: expect.objectContaining({ tagName: "button" }) },
      context: { screen: "settings", viewState: {}, persona: null },
    },
  ]);
  // The handle measures the same element.
  const measured = await panel.request("measure", { ref: events.picked![0]!.occurrence.ref });
  expect(measured.marker).toEqual({ x: 40 + window.scrollX, y: 80 + window.scrollY, width: 120, height: 30 });
  // A handle the page layer never gave out points nowhere.
  expect((await panel.request("measure", { ref: "e999" as ElementRef })).marker).toBeNull();
});

test("taking a shared link out of the page's address keeps every other change to it", async () => {
  const link = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
  link.setURL("https://prototype.example/settings?critiqs=t1.m1&tab=members");
  const { panel } = await start();
  // The page changed its address since the panel last heard, such as a checkout return being removed.
  window.history.replaceState(null, "", "/settings?critiqs=t1.m1&tab=billing");
  await panel.request("removeLink", {});
  expect(window.location.href).toBe("https://prototype.example/settings?tab=billing");
});

test("a panel that goes away leaves nothing on the page: no pins, and no Comment mode keeping clicks from it", async () => {
  const transports = directTransports();
  const { panel, shadow } = await start({ transports });
  const target = page!.querySelector("button")!;
  let pageSawClick = false;
  target.addEventListener("click", () => (pageSawClick = true));
  document.elementFromPoint = () => target;
  await act(async () =>
    void (await panel.request("display", {
      ...NOTHING,
      watch: [{ threadId: "shown", location: at("save") }],
      pins: [{ threadId: "shown", authorName: "Dana", unread: false, resolved: false, tickets: [] }],
      picking: { hint: "Select an element", paused: false },
    })),
  );
  expect(shadow.querySelector(".mode-hint")).not.toBeNull();
  await act(async () => transports[0].close());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(shadow.querySelector(".mode-hint")).toBeNull();
  expect(shadow.querySelectorAll(".pin")).toHaveLength(0);
  await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(pageSawClick).toBe(true);
});

test("a long view state value from the host still picks, as installed Critiqs always did", async () => {
  const { panel, events } = await start({ getContext: () => ({ screen: "settings", viewState: { filter: "x".repeat(5000), count: Number.NaN } }) });
  const target = page!.querySelector("button")!;
  document.elementFromPoint = () => target;
  await act(async () => void (await panel.request("display", { ...NOTHING, picking: { hint: null, paused: false } })));
  await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(events.picked).toHaveLength(1);
  expect(events.picked![0]!.context.viewState).toEqual({ filter: "x".repeat(5000), count: null });
});

test("a view state key named __proto__ is kept as the host's own key", async () => {
  const viewState = JSON.parse('{"__proto__": "admin", "tab": "members"}');
  const { panel } = await start({ getContext: () => ({ screen: "settings", viewState }) });
  const { context } = await panel.request("measure", { ref: null });
  expect(Object.hasOwn(context.viewState, "__proto__")).toBe(true);
  expect(context.viewState.__proto__ as unknown).toBe("admin");
  expect(context.viewState.tab).toBe("members");
});

test("cancelling a reveal stops the host's restore", async () => {
  let restoreSignal: AbortSignal | null = null;
  const { panel } = await start({
    restoreContext: ({ signal }) =>
      new Promise((resolve) => {
        restoreSignal = signal;
        signal.addEventListener("abort", () => resolve());
      }),
  });
  const controller = new AbortController();
  const revealing = panel.request("reveal", { threadId: "t", location: { ...at("save"), screen: "billing" }, chosen: null }, { signal: controller.signal }).catch((error: unknown) => error);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(restoreSignal).not.toBeNull();
  controller.abort();
  expect(await revealing).toMatchObject({ code: "cancelled" });
  expect(restoreSignal!.aborted).toBe(true);
});

test("what the page layer draws hides while a screenshot is taken from outside the page", async () => {
  const { panel, shadow } = await start();
  await act(async () => void (await panel.request("display", NOTHING)));
  const overlay = () => shadow.querySelector<HTMLElement>(".page-layer")!;
  expect(overlay().style.visibility).toBe("");
  await act(async () => void (await panel.request("conceal", { concealed: true })));
  expect(overlay().style.visibility).toBe("hidden");
  await act(async () => void (await panel.request("conceal", { concealed: false })));
  expect(overlay().style.visibility).toBe("");
});

test("a panel in another document follows the page, and starts again with a page layer that restarts", async () => {
  const transports = apartTransports();
  const { shadow } = await start({ transports });
  const link = new PageLink(panelEndpoint(transports[0], { channel: CHANNEL }));
  await link.connect();
  expect(link.overPage).toBe(false);
  expect(link.getState().context.screen).toBe("settings");
  link.display({ ...NOTHING, watch: [{ threadId: "shown", location: at("save") }], pins: [{ threadId: "shown", authorName: "Dana", unread: true, resolved: false, tickets: [] }] });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(link.getState().located.shown?.status).toBe("found");
  expect(shadow.querySelectorAll(".pin")).toHaveLength(1);

  // The frame loads another page: a new page layer starts with nothing drawn, and the panel sends it the display again.
  // A request the old page never answered fails, rather than leaving the panel waiting, such as on "Saving…".
  const stranded = link.request("measure", { ref: null }, {}).catch((error: unknown) => error);
  await act(async () => layer!.destroy());
  host!.remove();
  page!.remove();
  layer = null;
  const again = await start({ transports });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(again.shadow.querySelectorAll(".pin")).toHaveLength(1);
  expect(link.getState().located.shown?.status).toBe("found");
  expect(["cancelled", "gone"]).toContain(((await stranded) as { code: string }).code);
  link.close();
});
