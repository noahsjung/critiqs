import { expect, test } from "bun:test";
import { popoverPosition } from "../src/ui/Picker.tsx";

test("beside the target when there is room", () => {
  expect(popoverPosition({ x: 100, y: 200, width: 100, height: 30 }, 260, 1280, 800)).toEqual({ left: 212, top: 200 });
});

test("stays clear of the toolbar band at the bottom", () => {
  const { top } = popoverPosition({ x: 40, y: 600, width: 340, height: 30 }, 240, 920, 657);
  expect(top + 240).toBeLessThanOrEqual(657 - 72);
});

test("goes above a wide target when below would reach the toolbar, never covering it", () => {
  const target = { x: 20, y: 300, width: 740, height: 30 };
  const { top } = popoverPosition(target, 240, 800, 600);
  expect(top).toBe(48);
  expect(top + 240).toBeLessThanOrEqual(target.y);
});

test("never leaves the top edge in a short window", () => {
  expect(popoverPosition({ x: 20, y: 100, width: 740, height: 30 }, 260, 800, 320).top).toBe(8);
});

test("stays in the window when the target has scrolled out of it", () => {
  const below = popoverPosition({ x: 20, y: 900, width: 740, height: 30 }, 240, 800, 600);
  const above = popoverPosition({ x: 20, y: -400, width: 740, height: 30 }, 240, 800, 600);
  for (const { top } of [below, above]) {
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 240).toBeLessThanOrEqual(600 - 72);
  }
});
