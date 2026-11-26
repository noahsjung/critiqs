import { expect, test } from "bun:test";
import { pickingHint, touchScreen } from "../src/hints.ts";

// Comment mode's hint names keys only where there is a keyboard to press them.

test("on a touch screen the hint names a tap, never a key", () => {
  for (const reattaching of [false, true]) {
    const hint = pickingHint(reattaching, true);
    expect(hint).not.toMatch(/\bV\b|Esc|key/);
    expect(hint).toMatch(/tap/i);
  }
});

test("with a pointer that hovers, the keys are named", () => {
  expect(pickingHint(false, false)).toBe("Comment mode: select an element · V to leave");
  expect(pickingHint(true, false)).toBe("Select the replacement element · Esc to cancel");
});

test("a touch screen is one with no hover and a coarse pointer", () => {
  expect(touchScreen({ matchMedia: (query) => ({ matches: query === "(hover: none) and (pointer: coarse)" }) })).toBe(true);
  expect(touchScreen({ matchMedia: () => ({ matches: false }) })).toBe(false);
  expect(touchScreen({})).toBe(false);
});
