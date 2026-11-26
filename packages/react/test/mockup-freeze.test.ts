import { afterEach, expect, test } from "bun:test";
import { freezePage } from "../src/mockup/freeze.ts";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

/** The frozen page, parsed back as the frame showing it would. */
async function frozen(): Promise<Document> {
  const { html } = await freezePage();
  return new DOMParser().parseFromString(html, "text/html");
}

test("leaves out every mounted Critiqs, scripts, and event attributes", async () => {
  document.body.innerHTML = `
    <main onclick="steal()"><button onmouseover="x()" class="cta">Buy</button></main>
    <script>window.secret = 1</script><noscript>Enable scripts</noscript>`;
  const host = document.body.appendChild(document.createElement("critiqs-root"));
  host.attachShadow({ mode: "open" }).innerHTML = "<div>Critiqs toolbar</div>";

  const copy = await frozen();

  expect(copy.querySelector("critiqs-root, script, noscript")).toBeNull();
  expect(copy.querySelector("[onclick], [onmouseover]")).toBeNull();
  expect(copy.body.textContent).not.toContain("Critiqs toolbar");
  expect(copy.querySelector("button.cta")?.textContent).toBe("Buy");
});

test("covers masked elements without their content or attributes", async () => {
  document.body.innerHTML = `<p>Public</p><div data-critiqs-mask class="ssn" title="123-45-6789"><span>123-45-6789</span></div>`;

  const copy = await frozen();
  const cover = copy.querySelector("[data-critiqs-mask]");

  expect(copy.body.textContent).not.toContain("123-45-6789");
  expect(cover?.children).toHaveLength(0);
  expect(cover?.getAttribute("class")).toBeNull();
  expect(cover?.getAttribute("style")).toContain("background");
});

test("keeps what people typed and chose in forms", async () => {
  document.body.innerHTML = `
    <input id="name" value="original"><input id="agree" type="checkbox"><input id="secret" type="password">
    <textarea id="notes">original</textarea>
    <select id="size"><option selected>Small</option><option>Large</option></select>`;
  (document.getElementById("name") as HTMLInputElement).value = "Typed name";
  (document.getElementById("agree") as HTMLInputElement).checked = true;
  (document.getElementById("secret") as HTMLInputElement).value = "hunter2";
  (document.getElementById("notes") as HTMLTextAreaElement).value = "Typed notes";
  (document.getElementById("size") as HTMLSelectElement).selectedIndex = 1;

  const copy = await frozen();

  expect((copy.getElementById("name") as HTMLInputElement).value).toBe("Typed name");
  expect((copy.getElementById("agree") as HTMLInputElement).checked).toBe(true);
  expect((copy.getElementById("notes") as HTMLTextAreaElement).value).toBe("Typed notes");
  expect((copy.getElementById("size") as HTMLSelectElement).value).toBe("Large");
  expect(copy.documentElement.outerHTML).not.toContain("hunter2");
});

test("leaves out hidden form values and anti-forgery tokens, which the page never shows", async () => {
  document.head.innerHTML = `<meta name="csrf-param" content="authenticity_token"><meta name="csrf-token" content="rails-secret-token"><meta name="description" content="Kept">`;
  document.body.innerHTML = `
    <form><input type="hidden" name="authenticity_token" value="form-secret-token"><input id="ticket" type="hidden" name="csrfmiddlewaretoken"><input id="shown" value="Visible"></form>`;
  (document.getElementById("ticket") as HTMLInputElement).value = "set-by-script-secret";

  const copy = await frozen();
  const markup = copy.documentElement.outerHTML;
  expect(["rails-secret-token", "form-secret-token", "set-by-script-secret"].filter((secret) => markup.includes(secret))).toEqual([]);
  expect(copy.querySelectorAll('input[type="hidden"]').length).toBe(2);
  expect((copy.getElementById("shown") as HTMLInputElement).value).toBe("Visible");
  expect(copy.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("Kept");
});

test("numbers the body and every element in it in document order", async () => {
  document.body.innerHTML = `<header><h1>Title</h1></header><main><p>One</p><p>Two</p></main>`;

  const copy = await frozen();
  const numbered = Array.from(copy.querySelectorAll("[data-critiqs-node]")).map((element) =>
    `${element.localName}:${element.getAttribute("data-critiqs-node")}`);

  expect(numbered).toEqual(["body:1", "header:2", "h1:3", "main:4", "p:5", "p:6"]);
});

test("keeps the page's stylesheets as text, including rules added by scripts", async () => {
  const written = document.head.appendChild(document.createElement("style"));
  written.textContent = ".card { color: rgb(1, 2, 3); }";
  written.setAttribute("media", "screen");
  const scripted = document.head.appendChild(document.createElement("style"));
  scripted.sheet!.insertRule(".added-by-script { margin: 7px; }");
  document.body.innerHTML = `<div class="card added-by-script">Card</div>`;

  const copy = await frozen();
  const styles = Array.from(copy.querySelectorAll("style"));

  expect(styles.map((style) => style.textContent).join("\n")).toMatch(/\.card \{ color: rgb\(1, 2, 3\); \}[\s\S]*\.added-by-script \{ margin: 7px; \}/);
  expect(styles[0]?.getAttribute("media")).toBe("screen");
  expect(copy.head.firstElementChild?.localName).toBe("base");
  expect(copy.head.firstElementChild?.getAttribute("href")).toBe(document.baseURI);
});

test("keeps open shadow roots as declarative templates", async () => {
  const card = document.body.appendChild(document.createElement("product-card"));
  card.attachShadow({ mode: "open" }).innerHTML = `<style>p { color: red; }</style><p onclick="x()">Inside the card</p>`;

  const copy = await frozen();
  const template = copy.querySelector("product-card > template[shadowrootmode=open]") as HTMLTemplateElement | null;

  expect(template?.content.textContent).toContain("Inside the card");
  expect(template?.content.querySelector("[onclick]")).toBeNull();
  expect(template?.content.querySelector("style")?.textContent).toContain("color: red");
});

test("a stylesheet string that spells a closing style tag can't end the copy's stylesheet early", async () => {
  const sheet = document.head.appendChild(document.createElement("style"));
  sheet.sheet!.insertRule('.note::after { content: "</style><p id=escaped>"; }');
  sheet.sheet!.insertRule(".after { margin: 3px; }", 1);
  document.body.innerHTML = `<p class="note after">Note</p>`;

  const copy = await frozen();

  expect(copy.getElementById("escaped")).toBeNull();
  expect(Array.from(copy.querySelectorAll("style")).map((style) => style.textContent).join("\n")).toContain(".after { margin: 3px; }");
});
