import { expect, test } from "bun:test";
import { setSidebarWidth, sidebarFillsWindow, sidebarLimits, sidebarWidth } from "../src/ui/sidebar-width.tsx";

test("a panel with a window of its own lets the sidebar fill it; over a page it leaves a strip", () => {
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 380 });
  try {
    expect(sidebarLimits().max).toBe(300);
    sidebarFillsWindow();
    expect(sidebarLimits().max).toBe(380);
    setSidebarWidth(720);
    expect(sidebarWidth()).toBe(380);
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    localStorage.clear();
  }
});
