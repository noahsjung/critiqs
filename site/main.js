// Critiqs landing page: copy buttons, the product clips, the phone menu,
// the tagline reveal, and the current section in navigation.
// Everything remains readable without JavaScript.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const status = document.getElementById("copy-status");

// Copy the install command. The button holds both icons and CSS shows one;
// Safari doesn't redraw a sprite <use> whose href changes.
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.querySelector(".copy-label");
  let timer;
  button.addEventListener("click", async () => {
    // Clear first so a screen reader announces every copy, not just the first.
    status.textContent = "";
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = "Copied";
      button.classList.add("copied");
      setTimeout(() => { status.textContent = "Install command copied."; }, 50);
    } catch {
      label.textContent = "Select and copy";
      setTimeout(() => { status.textContent = "Couldn't copy. Select the command and copy it yourself."; }, 50);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = "Copy command";
      button.classList.remove("copied");
    }, 2000);
  });
}

// Clips of the real product: each plays while it's on screen and has its own
// pause button. With reduced motion they wait on their poster until played.
for (const video of document.querySelectorAll("video[data-clip]")) {
  const figure = video.closest(".clip");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "clip-toggle";
  button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/icons.svg#pause"></use></svg>';
  figure.append(button);

  let paused = reduceMotion.matches; // paused by the viewer, or by the reduced motion setting
  let visible = false;
  const render = () => {
    const playing = !video.paused;
    button.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${video.dataset.name ?? "video"}`);
    button.querySelector("use").setAttribute("href", playing ? "/icons.svg#pause" : "/icons.svg#play");
  };
  const sync = () => {
    if (visible && !paused) video.play().catch(() => {});
    else video.pause();
  };
  video.addEventListener("play", render);
  video.addEventListener("pause", render);
  button.addEventListener("click", () => {
    paused = !video.paused;
    if (!paused && video.preload === "none") video.preload = "auto";
    sync();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && video.preload === "none" && !paused) video.preload = "auto";
    sync();
  }, { threshold: 0.25 }).observe(video);
  render();
}

// Phone menu: a full height panel whose links arrive in reading order.
const toggle = document.querySelector(".menu-toggle");
const menu = document.getElementById("mobile-menu");
// While the menu is open, the page behind it can't be focused or scrolled.
const behind = [...document.body.children].filter((el) => !el.matches("header, script, [role=status]"));
function setMenu(open) {
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  document.body.style.overflow = open ? "hidden" : "";
  for (const el of behind) el.inert = open;
  if (open) {
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add("open"));
  } else {
    menu.classList.remove("open");
    setTimeout(() => { if (!menu.classList.contains("open")) menu.hidden = true; }, 300);
  }
}
toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
menu.addEventListener("click", (event) => { if (event.target.closest("a")) setMenu(false); });
// The menu exists only on phones; close it if the screen grows past that.
window.matchMedia("(min-width: 768px)").addEventListener("change", (event) => {
  if (event.matches && toggle.getAttribute("aria-expanded") === "true") setMenu(false);
});
// The site menu sits on top of anything else open, such as the docs menu, so
// Escape closes only it; preventDefault tells docs.js the key is handled.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && toggle.getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    setMenu(false);
    toggle.focus();
  }
});

// Tagline reveal: each word turns from muted to full colour in reading order
// as the section scrolls up the screen.
const reveal = document.querySelector("[data-reveal]");
if (reveal) {
  const words = [];
  for (const node of [...reveal.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const fragment = document.createDocumentFragment();
    for (const part of node.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { fragment.append(part); continue; }
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = part;
      words.push(span);
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }

  let lit = 0;
  let queued = false;
  const update = () => {
    queued = false;
    if (reduceMotion.matches) { words.forEach((w) => w.classList.add("lit")); return; }
    // Starts when the text's top reaches 85% of the screen and finishes when
    // its bottom reaches 45%, so the words light over a few hundred pixels.
    const box = reveal.getBoundingClientRect();
    const start = window.innerHeight * 0.85;
    const end = window.innerHeight * 0.45;
    const distance = box.height + (start - end);
    const progress = Math.min(1, Math.max(0, (start - box.top) / distance));
    const target = Math.round(progress * words.length);
    // Reveal once: words already lit stay lit when scrolling back up.
    while (lit < target) words[lit++].classList.add("lit");
    if (lit >= words.length) window.removeEventListener("scroll", onScroll);
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  update();
}

// Mark the section in view in the navigation. Links to other pages, such as
// Docs and Blog, are left alone.
const links = [...document.querySelectorAll('.nav-links a[href^="#"]')];
const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
let current = null;
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) current = entry.target.id;
    else if (current === entry.target.id) current = null;
  }
  for (const a of links) {
    if (current && a.getAttribute("href") === `#${current}`) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}, { rootMargin: "-45% 0px -50% 0px" });
sections.forEach((section) => observer.observe(section));
