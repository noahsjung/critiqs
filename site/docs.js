// Critiqs docs and blog: copy buttons on code blocks, the phone "Docs menu",
// and the current heading in "On this page". main.js runs the header.
// main.js shares this global scope, so everything here stays inside a block.
{
  const status = document.getElementById("copy-status");

  for (const button of document.querySelectorAll(".code-copy")) {
    const label = button.querySelector(".copy-label");
    const code = button.closest(".code-block").querySelector("code");
    let timer;
    button.addEventListener("click", async () => {
      status.textContent = "";
      try {
        await navigator.clipboard.writeText(code.textContent);
        label.textContent = "Copied";
        button.classList.add("copied");
        setTimeout(() => { status.textContent = "Code copied."; }, 50);
      } catch {
        label.textContent = "Select and copy";
        setTimeout(() => { status.textContent = "Couldn't copy. Select the code and copy it yourself."; }, 50);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        label.textContent = "Copy";
        button.classList.remove("copied");
      }, 2000);
    });
  }

  // Phone: the sidebar folds into a "Docs menu" button above the page.
  const sidebar = document.querySelector(".docs-sidebar");
  const menuButton = sidebar?.querySelector(".docs-menu-button");
  if (menuButton) {
    const setOpen = (open) => {
      sidebar.classList.toggle("open", open);
      menuButton.setAttribute("aria-expanded", String(open));
    };
    menuButton.addEventListener("click", () => setOpen(menuButton.getAttribute("aria-expanded") !== "true"));
    // main.js's listener runs first and marks Escape handled when it closed
    // the site menu, which sits on top; leave the docs menu open then.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented && sidebar.classList.contains("open")) {
        event.preventDefault();
        setOpen(false);
        menuButton.focus();
      }
    });
  }

  // "On this page": mark the last heading that has scrolled past the header.
  const tocLinks = [...document.querySelectorAll(".toc a")];
  const headings = tocLinks.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (headings.length) {
    let queued = false;
    const update = () => {
      queued = false;
      const line = 120;
      let active = headings[0];
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= line) active = h;
        else break;
      }
      // At the bottom of the page, the last heading may never reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) active = headings.at(-1);
      for (const a of tocLinks) {
        if (a.hash === `#${active.id}`) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      }
    };
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("hashchange", update);
    update();
  }
}
