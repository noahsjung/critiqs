import { expect, test } from "bun:test";
import { waitForTarget } from "../src/restore.ts";

const target = { purposeId: "dialog.message", recordKey: null, clues: { tagName: "p", role: null, label: null, path: "" } };

test("waits for a target that appears after the view is restored", async () => {
  document.body.innerHTML = `<main id="app"></main>`;
  const root = document.getElementById("app")!;
  setTimeout(() => {
    root.innerHTML = `<div role="dialog"><p data-critiqs-id="dialog.message">Revoke?</p></div>`;
  }, 20);
  const result = await waitForTarget(target, "shared", root, { timeoutMs: 1000 });
  expect(result.status).toBe("found");
});

test("reports the last result when the target never appears", async () => {
  document.body.innerHTML = `<main id="app"></main>`;
  const result = await waitForTarget(target, "shared", document.getElementById("app")!, { timeoutMs: 30 });
  expect(result).toEqual({ status: "not-found" });
});

test("a target already shown in another view waits until the app reports the restored view", async () => {
  document.body.innerHTML = `<main id="app"><p data-critiqs-id="dialog.message">Revoke?</p></main>`;
  let restored = false;
  setTimeout(() => {
    restored = true;
  }, 30);
  const started = Date.now();
  const result = await waitForTarget(target, "shared", document.getElementById("app")!, { timeoutMs: 1000, ready: () => restored });
  expect(result.status).toBe("found");
  expect(restored).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a view the app never reports is not ready, even with the target shown", async () => {
  document.body.innerHTML = `<main id="app"><p data-critiqs-id="dialog.message">Revoke?</p></main>`;
  const started = Date.now();
  const result = await waitForTarget(target, "shared", document.getElementById("app")!, { timeoutMs: 60, ready: () => false });
  // The caller sees the target was found but checks `ready` itself to report the wrong view.
  expect(result.status).toBe("found");
  expect(Date.now() - started).toBeGreaterThanOrEqual(55);
});

test("aborting stops waiting at once", async () => {
  document.body.innerHTML = `<main id="app"></main>`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  await waitForTarget(target, "shared", document.getElementById("app")!, { timeoutMs: 2000, signal: controller.signal, ready: () => true });
  expect(Date.now() - started).toBeLessThan(500);
});
