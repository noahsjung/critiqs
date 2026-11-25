import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Picker } from "../src/ui/Picker.tsx";
import { Toolbar } from "../src/ui/Toolbar.tsx";

// What floats over the page keeps to the part beside an open sidebar, however
// wide the sidebar and the window are: Comment mode's hint, and the toolbar.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function hint(exposedRight?: number) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<Picker host={host!} hint="Comment mode: select an element · V to leave" paused={false} onPick={() => undefined} exposedRight={exposedRight} />));
  return host.querySelector<HTMLElement>(".mode-hint")!;
}

test("beside an open sidebar the hint centers in the page and never runs under it", async () => {
  const beside = await hint(560);
  expect(beside.style.left).toBe("280px");
  expect(beside.style.maxWidth).toBe("536px");
});

test("with no sidebar open the hint centers in the window", async () => {
  expect((await hint()).getAttribute("style")).toBeNull();
});

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

test("the toolbar centers beside an open sidebar and follows the window as it resizes", async () => {
  const original = window.innerWidth;
  const measured = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.classList?.contains("toolbar") ? 244 : 0; } });
  try {
    setWindowWidth(1280);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const props = {
      mode: "comment" as const, onMode: () => undefined, sidebarOpen: true, onToggleSidebar: () => undefined, unreadCount: 0, reviewer: null,
      onSignIn: () => undefined, onSignOut: () => undefined, onRename: () => undefined, onYourAi: null, onYourTrackers: null,
      onOrganization: null, onBilling: null, onNotifications: null,
      mockupAvailable: true, needsSetup: false, onSetup: () => undefined, avoid: null,
    };
    // The sidebar's left edge comes from the caller; the window's own width from the toolbar.
    await act(async () => root!.render(<Toolbar {...props} sidebarLeft={920} />));
    const bar = () => host!.querySelector<HTMLElement>('[role="toolbar"]')!;
    expect(bar().style.left).toBe("460px");
    // Closed: centered on the window, following it when it resizes.
    await act(async () => root!.render(<Toolbar {...props} sidebarOpen={false} />));
    expect(bar().style.left).toBe("640px");
    await act(async () => setWindowWidth(600));
    expect(bar().style.left).toBe("300px");
  } finally {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", measured);
    setWindowWidth(original);
  }
});
