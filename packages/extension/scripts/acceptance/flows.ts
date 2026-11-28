// What a person does with Critiqs on a page, in steps the cases share:
// opening it with the icon, commenting on an element, and reading back what
// was saved, all with the real mouse and keyboard.
import type { ConvexHttpClient } from "convex/browser";
import type { Browser, Tab } from "./browser.ts";
import { box, gap, Missing, Overlay, type Rect, type Seen } from "./overlay.ts";
import { captureImage, type Deployment, firstText, thread, threads } from "./people.ts";

export interface Open {
  tab: Tab;
  overlay: Overlay;
  /** Milliseconds from the click to the toolbar showing, when it showed. */
  clickToToolbarMs: number | null;
}

/** Opens `url` in a new tab and attaches the reader, without clicking the icon. */
export async function openPage(browser: Browser, url: string): Promise<Open> {
  const tab = await browser.openTab(url);
  return { tab, overlay: await Overlay.attach(tab), clickToToolbarMs: null };
}

/** Clicks the icon and waits for Critiqs's toolbar, timing it. Throws Missing when no toolbar shows. */
export async function clickForToolbar(browser: Browser, open: Open, timeoutMs = 10_000): Promise<Seen> {
  const clicked = Date.now();
  await browser.clickIcon(open.tab);
  const end = clicked + timeoutMs;
  while (Date.now() < end) {
    const seen = await open.overlay.seen().catch(() => null);
    if (seen?.toolbar != null) {
      open.clickToToolbarMs = Date.now() - clicked;
      return seen;
    }
    await Bun.sleep(25);
  }
  const seen = await open.overlay.seen().catch(() => null);
  throw new Missing(`no Critiqs toolbar on the page ${(timeoutMs / 1000).toFixed(1)} s after the click (${seen === null ? "nothing could be read" : seen.script ? `its content script ran: ${seen.roots} critiqs-root, ${seen.pins.length} pins, text "${seen.text.slice(0, 120)}"` : `Critiqs's content script isn't on the page; ${seen.roots} critiqs-root`})`);
}

/** Opens `url` and clicks the icon until Critiqs's toolbar shows. */
export async function showCritiqs(browser: Browser, url: string, timeoutMs = 10_000): Promise<Open> {
  const open = await openPage(browser, url);
  await clickForToolbar(browser, open, timeoutMs);
  return open;
}

/** Comment mode, with the C key as a person presses it. */
export async function commentMode(overlay: Overlay): Promise<Seen> {
  const now = await overlay.toolbar();
  if (now.mode !== "comment") await overlay.page.keyboard.press("c");
  return await overlay.waitFor("Comment mode didn't turn on after pressing C", (seen) => seen.mode === "comment", 5000);
}

export interface Commented {
  target: Rect;
  box: Rect;
  typed: string;
  modeWhileTyping: Seen["mode"];
  textInBox: string | null;
  after: Seen;
}

/** Comments on an element: Comment mode, pick it, type right away with the real keyboard, and send with Ctrl+Enter. */
export async function comment(overlay: Overlay, selector: string, text: string, { send = true } = {}): Promise<Commented> {
  const before = await overlay.seen();
  await commentMode(overlay);
  const target = await overlay.pick(selector);
  const opened = await overlay.waitFor("no comment box opened after clicking the element in Comment mode", (seen) => seen.commentBox !== null, 5000);
  await overlay.page.keyboard.type(text);
  const typing = await overlay.seen();
  if (!send) return { target, box: opened.commentBox!, typed: text, modeWhileTyping: typing.mode, textInBox: typing.commentText, after: typing };
  await overlay.page.keyboard.press("Control+Enter");
  const after = await overlay.waitFor(
    `no new pin and thread window after sending the comment (typed "${text}", the box held "${typing.commentText}", mode while typing ${typing.mode})`,
    (seen) => seen.pins.length > before.pins.length && seen.threadWindow !== null,
    15_000,
  );
  return { target, box: opened.commentBox!, typed: text, modeWhileTyping: typing.mode, textInBox: typing.commentText, after };
}

/** Says what is wrong with a comment's placement, or null when the box sits within `limit` px of its element. */
export function beside(what: string, rect: Rect | null, target: Rect, limit = 24): string | null {
  if (rect === null) return `no ${what}`;
  const distance = gap(rect, target);
  return distance <= limit ? null : `the ${what} at ${box(rect)} is ${Math.round(distance)} px from its element at ${box(target)}`;
}

/** The newest thread whose first message is `text`, waiting for it to be saved. */
export async function savedThread(convex: ConvexHttpClient, projectId: string, text: string, timeoutMs = 10_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < end) {
    const list = await threads(convex, projectId);
    last = list.map(firstText);
    const found = list.find((summary) => firstText(summary) === text);
    if (found !== undefined) return await thread(convex, found._id);
    await Bun.sleep(250);
  }
  throw new Error(`No thread saved with exactly "${text}"; the project's newest threads say ${JSON.stringify(last.slice(0, 5))}.`);
}

/** The colour, in a thread's saved screenshot, of the page's point (x, y), decoded by Chrome. */
export async function capturePixel(browser: Browser, where: Deployment, accessToken: string, threadId: string, at: { x: number; y: number; viewport: number }): Promise<{ pixel: number[] | null; status: number; size: [number, number] | null }> {
  const { bytes, status } = await captureImage(where, accessToken, threadId);
  if (bytes === null) return { pixel: null, status, size: null };
  const page = await browser.context.newPage();
  try {
    const answer = await page.evaluate(
      async ({ data, x, y, viewport }: { data: string; x: number; y: number; viewport: number }) => {
        const image = new Image();
        image.src = data;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const drawing = canvas.getContext("2d")!;
        drawing.drawImage(image, 0, 0);
        const scale = image.naturalWidth / viewport;
        return { pixel: [...drawing.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)], size: [image.naturalWidth, image.naturalHeight] as [number, number] };
      },
      { data: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, ...at },
    );
    return { ...answer, status };
  } finally {
    await page.close();
  }
}

/** Where the other site's frame is on the page: only a real screenshot shows its teal. */
export const framePoint = (tab: Tab): Promise<{ x: number; y: number; viewport: number }> =>
  tab.page.evaluate(() => {
    const { x, y, width, height } = document.querySelector('iframe[title="Another site"]')!.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2, viewport: window.innerWidth };
  });

/** What the page's own scripts see of Critiqs: how many hosts, and whether a host's shadowRoot is readable. */
export const pageView = (tab: Tab): Promise<{ roots: number; openRoots: number }> =>
  tab.page.evaluate(() => {
    const hosts = [...document.querySelectorAll("critiqs-root")];
    return { roots: hosts.length, openRoots: hosts.filter((host) => host.shadowRoot !== null).length };
  });
