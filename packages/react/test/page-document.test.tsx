import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { hasMasks } from "../src/capture-supplied.ts";
import { PageLink } from "../src/page-layer/link.ts";
import { measured, pageState, saveCommentOnScriptedPage, scriptedPage, unmountPanel } from "./scripted-page.tsx";

// The panel and a page layer in another document, which another page's page
// layer can replace at any moment, such as when the prototype's frame loads
// another page.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(unmountPanel);

const captured = async () => ({ status: "captured" as const, image: new Blob(["png"], { type: "image/png" }) });

test("a comment whose page went away before it was created is discarded and never published", async () => {
  let releaseUpload!: () => void;
  const uploading = new Promise<void>((resolve) => (releaseUpload = resolve));
  // The capture's upload is still on its way when the page changes.
  const { shadow, created, navigate } = await saveCommentOnScriptedPage({ measure: measured, capture: captured }, { uploadImage: async () => (await uploading, "file") });
  await navigate();
  expect(shadow.querySelector('form[aria-label="New comment"]')).toBeNull();
  expect(shadow.textContent).toContain("the new comment was discarded");
  await act(async () => {
    releaseUpload();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(created).toEqual([]);
});

test("a comment already being created when the page changes is saved, and says so instead of claiming it was discarded", async () => {
  let releaseCreate!: () => void;
  const creating = new Promise<void>((resolve) => (releaseCreate = resolve));
  const created: string[] = [];
  const { shadow, navigate } = await saveCommentOnScriptedPage(
    { measure: measured, capture: captured },
    { uploadImage: async () => "file", createThread: async (thread) => (await creating, created.push(thread.body), "thread") },
  );
  await navigate();
  expect(shadow.textContent).not.toContain("discarded");
  await act(async () => {
    releaseCreate();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(created).toEqual(["Align the review button"]);
  expect(shadow.querySelector('form[aria-label="New comment"]')).toBeNull();
  expect(shadow.textContent).toContain("Comment saved. The prototype showed another page meanwhile");
  expect(shadow.textContent).not.toContain("discarded");
});

test("a late answer from a page that was replaced never brings it back", () => {
  const page = scriptedPage({});
  const link = new PageLink(page.endpoint, { initial: pageState("page-a", 5) });
  page.emit("state", pageState("page-b", 1));
  page.emit("state", pageState("page-a", 6));
  expect(link.getState().document).toBe("page-b");
});

test("a masked field inside an open shadow root counts as masked; Critiqs's own elements don't", () => {
  const critiqs = document.createElement("critiqs-root");
  document.body.append(critiqs);
  const own = document.createElement("div");
  own.setAttribute("data-critiqs-mask", "");
  critiqs.attachShadow({ mode: "open" }).append(own);
  const widget = document.createElement("payment-widget");
  document.body.append(widget);
  try {
    expect(hasMasks(document)).toBe(false);
    const field = document.createElement("input");
    field.setAttribute("data-critiqs-mask", "");
    widget.attachShadow({ mode: "open" }).append(field);
    expect(hasMasks(document)).toBe(true);
  } finally {
    widget.remove();
    critiqs.remove();
  }
});
