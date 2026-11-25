// Helpers for recording the landing page's clips from the real Critiqs UI:
// signing people in through Critiqs's own sign-in pages, named cursors drawn
// over the page, and a frame recorder that encodes an MP4 with ffmpeg.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const APP = process.env.SITE_APP_URL ?? "http://127.0.0.1:4811/";
export const DATA = new URL("../.local/site-src-data/", import.meta.url).pathname;
export const VIEWPORT = { width: 1440, height: 900 };
export const SCALE = 4 / 3; // 1920 x 1200 frames
/** A closer view for the feature clips, which show at about half width on the page. Same 1920 x 1200 frames. */
export const CLOSE = { viewport: { width: 1080, height: 675 }, scale: 16 / 9 };

export const PEOPLE = {
  kai: { email: "kai.lindqvist@acme.example", name: "Kai Lindqvist", color: "#0d63f3" },
  priya: { email: "priya@acme.example", name: "Priya Raman", color: "#e0457b" },
  daniel: { email: "daniel@acme.example", name: "Daniel Osei", color: "#0f9d6b" },
  mei: { email: "mei@acme.example", name: "Mei Tanaka", color: "#e8811a" },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Cursor moves take this share of the durations the clips ask for. */
export const PACE = 0.6;

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome" });
}

/** A browser context for one person, reusing their saved Critiqs session when there is one. */
export async function contextFor(browser, who, { close = false, scale } = {}) {
  mkdirSync(join(DATA, "sessions"), { recursive: true });
  const state = join(DATA, "sessions", `${who}.json`);
  return browser.newContext({
    viewport: close ? CLOSE.viewport : VIEWPORT,
    deviceScaleFactor: scale ?? (close ? CLOSE.scale : SCALE),
    storageState: existsSync(state) ? state : undefined,
  });
}

export async function saveSession(ctx, who) {
  await ctx.storageState({ path: join(DATA, "sessions", `${who}.json`) });
}

export const root = (page) => page.locator("critiqs-root");

/** Signs in through Critiqs's sign-in window: email, the on-screen development code, name, and allowing the site. */
export async function signIn(page, who) {
  const person = PEOPLE[who];
  const ctx = page.context();
  const popupP = ctx.waitForEvent("page", { timeout: 6000 }).catch(() => null);
  await root(page).getByRole("button", { name: "Sign in" }).first().click();
  const pop = await popupP;
  if (pop === null) return; // the sign-in service remembered this person
  await pop.waitForLoadState("networkidle");
  for (let i = 0; i < 12 && !pop.isClosed(); i++) {
    const text = await pop.locator("body").innerText().catch(() => "");
    if (await pop.locator("input[name=email]:visible").count()) {
      await pop.locator("input[name=email]").fill(person.email);
      await pop.getByRole("button", { name: /Send code/ }).click();
    } else if (await pop.locator("input[name=code]:visible").count()) {
      const code = (text.match(/\b\d{6}\b/) ?? [""])[0];
      await pop.locator("input[name=code]").fill(code);
      await pop.locator("input[name=code]").press("Enter").catch(() => {});
    } else if (await pop.locator("input[name=name]:visible").count()) {
      await pop.locator("input[name=name]").fill(person.name);
      await pop.locator("input[name=name]").press("Enter").catch(() => {});
    } else {
      const allow = pop.getByRole("button", { name: /^(Allow|Continue|Approve)/ });
      if (await allow.count()) await allow.first().click().catch(() => {});
    }
    await sleep(1000);
  }
}

/** Opens the app for a person, signed in, on a project. */
export async function openAs(browser, who, projectId, { tab, close = false, scale } = {}) {
  const ctx = await contextFor(browser, who, { close, scale });
  const page = await ctx.newPage();
  const url = new URL(APP);
  if (projectId) url.searchParams.set("project", projectId);
  if (tab) url.searchParams.set("tab", tab);
  await page.goto(url.href, { waitUntil: "networkidle" });
  await sleep(800);
  if (await root(page).getByRole("button", { name: "Sign in" }).count()) {
    await signIn(page, who);
    await saveSession(ctx, who);
    await sleep(800);
  }
  return page;
}

/** Kai sets up a new project through Critiqs's project setup, so each run starts clean. */
export async function createProject(browser, name) {
  let page = await openAs(browser, "kai", null);
  let r = root(page);
  if (await r.getByRole("button", { name: "Sign in" }).first().isVisible().catch(() => false)) {
    // Signed out: start from a clean profile so the sign-in window opens.
    await page.context().close();
    rmSync(join(DATA, "sessions", "kai.json"), { force: true });
    page = await openAs(browser, "kai", null);
    r = root(page);
  }
  const step = async (label) => {
    const button = r.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) { await button.click(); await sleep(700); }
  };
  const nameField = r.locator(".setup input").first();
  if (!(await nameField.isVisible().catch(() => false))) {
    await step("Set up Critiqs");
    await step("Project setup");
    await step("Use a different project");
  }
  await nameField.fill(name);
  await r.getByRole("button", { name: "Create project" }).click();
  const code = r.locator("code", { hasText: "projectId=" });
  await code.waitFor({ timeout: 15000 });
  const id = (await code.textContent()).match(/projectId="([^"]+)"/)[1];
  await saveSession(page.context(), "kai");
  await page.context().close();
  return id;
}

// ---- Critiqs actions, as a person would do them ----

export async function commentMode(page) {
  await root(page).getByRole("button", { name: "Comment mode" }).click();
  await sleep(400);
}

/** Center of an app element, in page coordinates. */
export async function centerOf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Comments on an element in Comment mode: click it, type, post. Uses the page's own mouse, so hover states show. */
export async function comment(page, target, text, { cursor, typeDelay = 28, beforePost } = {}) {
  const at = await centerOf(target);
  if (cursor) await cursor.glide(at.x, at.y);
  else await page.mouse.move(at.x, at.y, { steps: 8 });
  await sleep(250);
  if (cursor) await cursor.press();
  await page.mouse.click(at.x, at.y);
  await sleep(500);
  await page.keyboard.type(text, { delay: typeDelay });
  await sleep(300);
  await beforePost?.();
  const post = root(page).getByRole("button", { name: "Comment", exact: true });
  if (cursor) { await cursor.glideTo(post, 600); await cursor.press(); }
  await post.click();
  await sleep(600);
}

/** Opens the thread on an element (its pin) and replies. */
export async function reply(page, pinIndex, text) {
  await root(page).locator(".pin").nth(pinIndex).click();
  await sleep(400);
  await root(page).locator(".tag-field").last().click();
  await page.keyboard.type(text);
  await root(page).getByRole("button", { name: "Reply", exact: true }).click();
  await sleep(500);
}

// ---- Named cursors drawn over the page ----

const CURSOR_SCRIPT = `
(() => {
  if (window.__cursors) return;
  const layer = document.createElement("div");
  layer.setAttribute("data-demo-cursors", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  // Mockup mode freezes the page, cursors included; remove them from its copies.
  const frames = (node, out) => {
    for (const el of node.querySelectorAll("*")) {
      if (el.localName === "iframe") out.push(el);
      if (el.shadowRoot) frames(el.shadowRoot, out);
    }
    return out;
  };
  setInterval(() => {
    for (const frame of frames(document, [])) {
      try { for (const ghost of frame.contentDocument?.querySelectorAll("[data-demo-cursors]") ?? []) ghost.remove(); } catch {}
    }
  }, 50);
  const arrow = (c) => '<svg width="22" height="22" viewBox="0 0 22 22" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))"><path d="M3 2.5 L18.5 9.2 L11.2 11.3 L8.6 18.6 Z" fill="'+c+'" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const cursors = {};
  const wanders = {};
  const ensureLayer = () => { if (!layer.isConnected) document.documentElement.appendChild(layer); };
  window.__cursors = {
    add(id, name, color, x, y) {
      ensureLayer();
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;left:0;top:0;will-change:transform;transition:transform 0ms;";
      el.innerHTML = arrow(color) + '<div style="margin:-2px 0 0 14px;display:inline-block;padding:3px 8px;border-radius:999px;background:'+color+';color:#fff;font:600 12px/16px system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.18)">'+name+'</div>';
      layer.appendChild(el);
      cursors[id] = el;
      this.to(id, x, y, 0);
    },
    to(id, x, y, ms) {
      const el = cursors[id];
      el.style.transition = "transform " + ms + "ms cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)";
    },
    press(id) {
      const el = cursors[id];
      const svg = el.querySelector("svg");
      svg.animate([{ transform: "scale(1)" }, { transform: "scale(0.82)" }, { transform: "scale(1)" }], { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    },
    // Small, unhurried moves around a spot, like a teammate reading the page.
    wander(id, x, y, radius) {
      this.still(id);
      const hop = () => {
        const a = Math.random() * Math.PI * 2, r = radius * (0.35 + Math.random() * 0.65);
        const ms = 650 + Math.random() * 500;
        this.to(id, x + Math.cos(a) * r, y + Math.sin(a) * r * 0.7, ms);
        wanders[id] = setTimeout(hop, ms + 120 + Math.random() * 380);
      };
      wanders[id] = setTimeout(hop, 150 + Math.random() * 300);
    },
    still(id) { clearTimeout(wanders[id]); delete wanders[id]; },
    hide(id) { cursors[id].style.opacity = "0"; },
    show(id) { cursors[id].style.opacity = "1"; },
  };
})();
`;

/**
 * A named cursor. The page's own pointer drives one "driver" cursor (its moves
 * are real, so Critiqs's hover and click respond); other people's cursors are
 * drawn only, while their real actions happen in their own browser.
 */
export async function addCursor(page, who, x, y, { driver = false } = {}) {
  await page.evaluate(CURSOR_SCRIPT);
  const p = PEOPLE[who];
  await page.evaluate(([id, name, color, x, y]) => window.__cursors.add(id, name, color, x, y), [who, p.name.split(" ")[0], p.color, x, y]);
  let pos = { x, y };
  if (driver) await page.mouse.move(x, y);
  const cursor = {
    who,
    get pos() { return pos; },
    /**
     * Moves along an eased path in about `ms` times PACE; a driver cursor also
     * moves the real pointer. Stops any idle wandering first.
     */
    async glide(tx, ty, ms = 900) {
      ms = Math.round(ms * PACE);
      await page.evaluate((id) => window.__cursors.still(id), who);
      if (!driver) {
        await page.evaluate(([id, x, y, ms]) => window.__cursors.to(id, x, y, ms), [who, tx, ty, ms]);
        await sleep(ms);
      } else {
        // Timed by the clock, not by step count, so slow page calls don't stretch the move.
        const from = pos;
        const ease = (t) => 1 - Math.pow(1 - t, 3);
        const start = Date.now();
        for (let t = 0; t < 1; ) {
          t = Math.min(1, (Date.now() - start) / ms);
          const k = ease(t);
          const x = from.x + (tx - from.x) * k, y = from.y + (ty - from.y) * k;
          await page.mouse.move(x, y);
          await page.evaluate(([id, x, y]) => window.__cursors.to(id, x, y, 0), [who, x, y]);
          await sleep(10);
        }
      }
      pos = { x: tx, y: ty };
    },
    /** Drifts a little around where the cursor is, until its next glide. Drawn cursors only. */
    async idle(radius = 36) {
      if (driver) return;
      await page.evaluate(([id, x, y, r]) => window.__cursors.wander(id, x, y, r), [who, pos.x, pos.y, radius]);
    },
    async glideTo(locator, ms) {
      const c = await centerOf(locator);
      await this.glide(c.x, c.y, ms);
    },
    async press() {
      await page.evaluate((id) => window.__cursors.press(id), who);
    },
    async click() {
      await this.press();
      if (driver) await page.mouse.click(pos.x, pos.y);
      await sleep(250);
    },
  };
  return cursor;
}

// ---- Recording ----

/**
 * Records the page through Chrome's screencast. `wait()` marks time spent
 * waiting on the network (another person's comment arriving); the encoder
 * shortens those stretches so the clip doesn't show dead time.
 */
export async function startRecording(page, name) {
  const dir = join(DATA, "frames", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const waits = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  const now = () => Date.now() / 1000;
  return {
    async wait(promise, keep = 0.35) {
      const start = now();
      const result = await promise;
      waits.push({ start, end: now(), keep });
      return result;
    },
    async stop(outFile, { tail = 1.5 } = {}) {
      await sleep(300);
      await cdp.send("Page.stopScreencast");
      await sleep(200);
      encode(frames, waits, outFile, tail);
      return frames.length;
    },
  };
}

const LOCAL_FFMPEG = new URL("../.local/tools/node_modules/ffmpeg-static/ffmpeg", import.meta.url).pathname;
const FFMPEG = process.env.FFMPEG ?? (existsSync(LOCAL_FFMPEG) ? LOCAL_FFMPEG : "ffmpeg");

/** Turns timestamped frames into a 30 fps H.264 MP4 plus a poster JPEG, shortening marked waits. */
function encode(frames, waits, outFile, tail) {
  if (frames.length === 0) throw new Error("No frames recorded");
  // Map recording time to clip time: each wait shrinks to `keep` seconds.
  // Frames that land in the same 1/60 s of the clip are dropped, so a wait
  // full of moving cursors shrinks as much as a still one.
  const clipTime = (t) => {
    let out = t;
    for (const w of waits) {
      const len = w.end - w.start;
      if (len <= 0 || t <= w.start) continue;
      const inside = Math.min(t, w.end) - w.start;
      out -= inside - w.keep * (inside / len);
    }
    return out;
  };
  const kept = [];
  for (const f of frames) {
    const at = clipTime(f.t);
    if (kept.length && at - kept.at(-1).at < 1 / 60) kept[kept.length - 1] = { file: f.file, at: kept.at(-1).at };
    else kept.push({ file: f.file, at });
  }
  const end = clipTime(frames.at(-1).t) + tail;
  const lines = [];
  for (let i = 0; i < kept.length; i++) {
    const next = i + 1 < kept.length ? kept[i + 1].at : end;
    lines.push(`file '${kept[i].file}'`, `duration ${Math.max(1 / 60, next - kept[i].at).toFixed(4)}`);
  }
  lines.push(`file '${kept.at(-1).file}'`);
  const list = join(DATA, "frames", `${outFile.split("/").at(-1)}.frames.txt`);
  writeFileSync(list, lines.join("\n"));
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "fps=30,scale=1920:1200:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "24",
    "-tune", "stillimage", "-movflags", "+faststart", "-an", outFile]);
  rmSync(list);
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", frames.at(-1).file, "-vf", "scale=1920:1200", "-q:v", "3", outFile.replace(/\.mp4$/, ".jpg")]);
}
