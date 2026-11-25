// Records the landing page's clips from the real Critiqs UI into site/media/.
// Needs the sample app (bun run app) and a local Convex backend (bun run convex,
// then `bun run setup:local` in packages/backend). Usage:
//   node record.mjs [clip ...]     clips: chat, screen, comment, collab, context, handoff, mockup, og
// chat, screen and comment are stills; og renders site/og.png from the page.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import {
  APP, addCursor, centerOf, comment, commentMode, createProject, launch, openAs, reply, root, sleep, startRecording,
} from "./lib.mjs";

/** A project with threads from four people on three tabs, left through the real UI. */
async function seededProject(browser) {
  const project = await createProject(browser, "Acme console");
  const as = async (who, tab, fn) => {
    const page = await openAs(browser, who, project, { tab });
    await commentMode(page);
    await fn(page);
    await page.context().close();
  };
  await as("kai", "billing", (p) => comment(p, p.locator(".card", { hasText: "Next invoice" }).locator(".dim"), "Show the year here too: December 1, 2026. Finance exports this. #wording", { typeDelay: 0 }));
  await as("daniel", "overview", (p) => comment(p, p.locator(".card", { hasText: "Usage this month" }).locator(".big"), "Should 82% link to the usage report? Support asks for it every week.", { typeDelay: 0 }));
  await as("mei", "team", (p) => comment(p, p.locator("#seats"), "Can seats show the limit as a bar? 14 of 20 is easy to miss.", { typeDelay: 0 }));
  await as("priya", "team", (p) => comment(p, p.locator("td", { hasText: /^Ops$/ }).first(), "Spell out the department here. “Ops” reads like a typo next to the others. #wording", { typeDelay: 0 }));
  await as("daniel", "team", (p) => reply(p, 1, "Agreed. Changing it to Operations in the next build."));
  return project;
}

const OUT = new URL("../site/media/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const clips = {
  /**
   * The cropped screenshot someone pastes into team chat today, with the
   * problem circled by hand. Needs only the sample app, not a backend.
   */
  async chat(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(new URL("?tab=team", APP).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.querySelector("critiqs-root")?.remove());
    const ops = await page.locator("td", { hasText: /^Ops$/ }).first().boundingBox();
    await page.evaluate((b) => {
      const ring = document.createElement("div");
      ring.style.cssText = `position:absolute;left:${b.x - 22}px;top:${b.y + scrollY - 10}px;width:${b.width * 0.42 + 44}px;height:${b.height + 20}px;border:3px solid #ff4d4f;border-radius:50%;transform:rotate(-4deg);pointer-events:none;`;
      document.body.append(ring);
    }, ops);
    const table = await page.locator(".team").boundingBox();
    const tabs = await page.locator(".tabs").boundingBox();
    const x = table.x - 16, y = tabs.y - 16;
    await page.screenshot({ path: `${OUT}chat-shot.jpg`, type: "jpeg", quality: 86, clip: { x, y, width: Math.min(720, table.width + 32), height: table.y + table.height - y + 16 } });
    await page.close();
    console.log("chat: site/media/chat-shot.jpg");
  },

  /**
   * The page as reviewers see it, with nothing of Critiqs on it: the backdrop
   * for the drawn multi-person scenes. Needs only the sample app.
   */
  async screen(browser) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
    await page.goto(new URL("?tab=team", APP).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.querySelector("critiqs-root")?.remove());
    await page.screenshot({ path: `${OUT}screen.jpg`, type: "jpeg", quality: 82 });
    await page.close();
    console.log("screen: site/media/screen.jpg");
  },

  /** A close, sharp still of a comment being written on one cell, with teammates' cursors nearby. */
  async comment(browser) {
    const project = await createProject(browser, "Acme console");
    const priya = await openAs(browser, "priya", project, { tab: "team", scale: 3 });
    await commentMode(priya);
    const cell = priya.locator("td", { hasText: /^Ops$/ }).first();
    const at = await centerOf(cell);
    const seats = await centerOf(priya.locator("#seats"));
    await addCursor(priya, "mei", seats.x + 30, seats.y + 14);
    await addCursor(priya, "daniel", at.x + 150, at.y + 150);
    await priya.mouse.click(at.x, at.y);
    await sleep(600);
    await priya.keyboard.type("Spell out the department here. “Ops” reads like a typo next to the others. #wording");
    await addCursor(priya, "priya", at.x + 8, at.y + 6);
    await sleep(500);
    // The cell and the open composer beside it, 16:10.
    const field = await root(priya).locator(".tag-field").last().boundingBox();
    const box = await cell.boundingBox();
    const left = box.x - 40, right = field.x + field.width + 40;
    const width = right - left, height = width / 1.6;
    // From just above the column headings, so the table reads as a table.
    const top = box.y - 62;
    await priya.screenshot({ path: `${OUT}comment.jpg`, type: "jpeg", quality: 88, clip: { x: left, y: Math.max(0, top), width, height } });
    await priya.context().close();
    console.log(`comment: site/media/comment.jpg (${Math.round(width)} x ${Math.round(height)} css px)`);
  },

  /** Three people review the same screen: two comments and a reply arrive live. */
  async collab(browser) {
    const project = await createProject(browser, "Acme console");
    const mei = await openAs(browser, "mei", project);
    const daniel = await openAs(browser, "daniel", project);
    const priya = await openAs(browser, "priya", project);
    await commentMode(mei);
    await commentMode(daniel);

    const ops = (page) => page.locator("td", { hasText: /^Ops$/ }).first();
    const seats = (page) => page.locator("#seats");

    // Priya starts in Browse mode and switches to Comment mode on camera.
    const p = await addCursor(priya, "priya", 520, 840, { driver: true });
    const m = await addCursor(priya, "mei", 780, 330);
    const d = await addCursor(priya, "daniel", 1010, 720);
    // Teammates' cursors drift while they read, so the page feels shared.
    await m.idle();
    await d.idle(44);
    const rec = await startRecording(priya, "collab");
    await sleep(600);
    await p.glideTo(root(priya).getByRole("button", { name: "Comment mode" }), 900);
    await p.click();
    await sleep(500);

    // Mei heads for the seats card while Priya picks the department.
    const seatsAt = await centerOf(seats(priya));
    const meiMove = m.glide(seatsAt.x + 40, seatsAt.y + 10, 1400);
    await comment(priya, ops(priya), "Spell out the department here. “Ops” reads like a typo next to the others. #wording", { cursor: p });
    await meiMove;

    // Mei's own browser posts her comment; it appears on Priya's screen.
    await m.press();
    await rec.wait(comment(mei, seats(mei), "Can seats show the limit as a bar? 14 of 20 is easy to miss.", { typeDelay: 0 }));
    // Her pin is the second one on Priya's page.
    await rec.wait(root(priya).locator(".pin").nth(1).waitFor({ state: "attached", timeout: 20000 }).catch(() => {}), 0.2);
    await m.idle(28);
    await sleep(700);

    // Daniel reads Priya's thread and replies from his browser.
    const replyBox = root(priya).locator(".tag-field").last();
    await d.glideTo(replyBox, 1300);
    await d.press();
    await rec.wait((async () => {
      const pin = root(daniel).locator(".pin").first();
      await pin.click();
      await root(daniel).locator(".tag-field").last().click();
      await daniel.keyboard.type("Agreed. Changing it to Operations in the next build.");
      await root(daniel).getByRole("button", { name: "Reply", exact: true }).click();
    })());
    await rec.wait(root(priya).getByText("Changing it to Operations").waitFor(), 0.2);
    await d.idle(30);
    await sleep(2000);

    // Priya opens the sidebar: every thread, grouped by where it was left.
    await p.glideTo(root(priya).getByRole("button", { name: /^Comments/ }), 1000);
    await p.click();
    await sleep(2400);
    const frames = await rec.stop(`${OUT}collab.mp4`);
    console.log(`collab: ${frames} frames`);
  },

  /** Opening a thread from the sidebar brings back its tab, then its pin and discussion. */
  async context(browser) {
    const project = await seededProject(browser);
    const priya = await openAs(browser, "priya", project, { tab: "team", close: true });
    const r = root(priya);
    await commentMode(priya);
    await r.getByRole("button", { name: /^Comments/ }).click();
    await sleep(2500);
    const p = await addCursor(priya, "priya", 860, 560, { driver: true });
    const rec = await startRecording(priya, "context");
    await sleep(700);
    for (const text of ["Show the year here too", "Should 82% link"]) {
      await p.glideTo(r.locator(".entry", { hasText: text }).first(), 1100);
      await p.click();
      await sleep(3000);
    }
    const frames = await rec.stop(`${OUT}context.mp4`);
    console.log(`context: ${frames} frames`);
  },

  /** A developer selects threads and exports them for an issue or a coding agent. */
  async handoff(browser) {
    const project = await seededProject(browser);
    const daniel = await openAs(browser, "daniel", project, { tab: "team", close: true });
    const r = root(daniel);
    await commentMode(daniel);
    await r.getByRole("button", { name: /^Comments/ }).click();
    await sleep(2500);
    const d = await addCursor(daniel, "daniel", 860, 560, { driver: true });
    const rec = await startRecording(daniel, "handoff");
    await sleep(600);
    await d.glideTo(r.getByRole("button", { name: "Select threads to export" }), 1000);
    await d.click();
    await sleep(700);
    const boxes = r.locator(".entry input[type=checkbox]");
    const n = Math.min(3, await boxes.count());
    for (let i = 0; i < n; i++) {
      await d.glideTo(boxes.nth(i), 500);
      await d.click();
      await sleep(250);
    }
    await d.glideTo(r.getByRole("button", { name: /^Export/ }).first(), 800);
    await d.click();
    await sleep(2600);
    await d.glideTo(r.getByRole("button", { name: "JSON, for tools" }), 900);
    await d.click();
    await sleep(2200);
    await d.glideTo(r.getByRole("button", { name: "Copy", exact: true }), 800);
    await d.click();
    await sleep(1800);
    const frames = await rec.stop(`${OUT}handoff.mp4`);
    console.log(`handoff: ${frames} frames`);
  },

  /** Mockup mode: ask Critiqs AI for a change, watch the page copy change, then a second version. */
  async mockup(browser) {
    const project = await createProject(browser, "Acme console");
    const priya = await openAs(browser, "priya", project);
    const r = root(priya);
    const p = await addCursor(priya, "priya", 640, 760, { driver: true });
    const rec = await startRecording(priya, "mockup");
    await sleep(500);

    await p.glideTo(r.getByRole("button", { name: "Mockup mode" }), 900);
    await p.click();
    await sleep(1600);
    await p.glideTo(r.getByRole("button", { name: "New thread" }), 900);
    await p.click();
    await sleep(700);

    const ask = async (text) => {
      const field = r.locator("textarea.field").last();
      await p.glideTo(field, 700);
      await p.click();
      await priya.keyboard.type(text, { delay: 26 });
      await sleep(300);
      const send = r.getByRole("button", { name: /^(Send|Reply)$/ }).last();
      await p.glideTo(send, 500);
      await p.click();
    };

    await ask("Spell out Ops as Operations, and show seats as a bar against the plan limit.");
    await rec.wait(r.getByText("Spelled out both Ops cells").waitFor({ timeout: 60000 }), 3.2);
    await sleep(2800);

    await ask("Make Upgrade plan a quieter outline button.");
    await rec.wait(r.getByText("Made Upgrade plan an outline button").waitFor({ timeout: 60000 }), 3.2);
    await sleep(2400);

    // Hold to compare with the live page, then let go.
    const compare = r.getByRole("button", { name: "Hold to compare" });
    if (await compare.count()) {
      await p.glideTo(compare, 800);
      await priya.mouse.down();
      await sleep(1600);
      await priya.mouse.up();
      await sleep(1600);
    }
    const frames = await rec.stop(`${OUT}mockup.mp4`);
    console.log(`mockup: ${frames} frames`);
  },

  /** The share image: the landing page's own hero, rendered at 1200 x 630. Needs no backend. */
  async og(browser) {
    const site = new URL("../site/", import.meta.url).pathname;
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4" };
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = join(site, path.endsWith("/") ? `${path}index.html` : path);
      if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "header,.lede,.actions,.proof,.clip-toggle{display:none!important}.hero{padding:48px 0 0!important}.hero .clip{margin-top:36px!important}" });
    await sleep(1000);
    await page.screenshot({ path: `${site}og.png` });
    await page.close();
    server.close();
    console.log("og: site/og.png");
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(clips);
const browser = await launch();
try {
  for (const name of names) {
    if (!clips[name]) throw new Error(`Unknown clip: ${name}`);
    await clips[name](browser);
  }
} finally {
  await browser.close();
}
