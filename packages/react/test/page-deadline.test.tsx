import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";

// A frame that loads a page without Critiqs never answers, and no other page
// layer takes over to cancel what was waiting: saving a comment gives up after
// a deadline and says why, instead of staying "Saving…".

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
mock.module("../src/page-layer/deadlines.ts", () => ({ PAGE_ANSWER_MS: 30, PAGE_CAPTURE_MS: 30 }));
const { saveCommentOnScriptedPage, unmountPanel } = await import("./scripted-page.tsx");
afterEach(unmountPanel);

test("a page that never answers ends the save with an error the reviewer can act on", async () => {
  const { shadow, created } = await saveCommentOnScriptedPage({ measure: () => new Promise(() => {}) });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  const form = shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  expect(form.textContent).toContain("The prototype's page didn't answer");
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Comment");
  expect(created).toEqual([]);
});
