import { afterEach, expect, test } from "bun:test";
import { copyText } from "../src/ui/common.tsx";

const original = { clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"), ClipboardItem: (globalThis as { ClipboardItem?: unknown }).ClipboardItem };
afterEach(() => {
  if (original.clipboard) Object.defineProperty(navigator, "clipboard", original.clipboard);
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = original.ClipboardItem;
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => true });
});

test("a browser that refuses to copy is reported, not taken for a copy", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("Not allowed")) } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  expect(await copyText("https://critiqs.example/t/AbCdEfGhIjKlMnOpQrStUv")).toBe(false);
  expect(await copyText(Promise.resolve("https://critiqs.example/t/AbCdEfGhIjKlMnOpQrStUv"))).toBe(false);
});

test("a link still on its way goes to the clipboard as a promise, and a link that fails fails the copy without an unhandled rejection", async () => {
  const written: unknown[] = [];
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write: async (items: { items: Record<string, Promise<Blob>> }[]) => void written.push(await (await items[0]!.items["text/plain"]!).text()), writeText: async () => undefined },
  });
  expect(await copyText(Promise.resolve("https://critiqs.example/t/AbCdEfGhIjKlMnOpQrStUv"))).toBe(true);
  expect(written).toEqual(["https://critiqs.example/t/AbCdEfGhIjKlMnOpQrStUv"]);

  // A browser whose ClipboardItem takes no promise throws as it is made; the link's own failure is the one reported.
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
    constructor() {
      throw new TypeError("Promises aren't supported here.");
    }
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(copyText(Promise.reject(new Error("Refused by the backend.")))).rejects.toThrow("Refused by the backend.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});
