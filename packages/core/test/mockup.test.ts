import { describe, expect, test } from "bun:test";
import { applyEdits, describePage, MOCKUP_LIMITS, parseEdits, prioritizeMockupStyles, sanitizeHtml, type MockupEdit } from "../src/index.ts";

/** A page copy as freezing leaves it: every body element numbered in document order. */
function copy(body: string, head = "<style>p { color: red }</style>"): Document {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`, "text/html");
  [doc.body, ...Array.from(doc.body.querySelectorAll("*"))].forEach((element, index) => {
    element.setAttribute("data-critiqs-node", String(index + 1));
  });
  return doc;
}

const node = (doc: Document, id: number) => doc.querySelector(`[data-critiqs-node="${id}"]`);

describe("parseEdits", () => {
  test("accepts every kind of change and keeps only its fields", () => {
    const edits = [
      { kind: "css", css: "@media (max-width: 600px) { [data-critiqs-node=\"3\"] { color: #333; content: \"{\" } }" },
      { kind: "text", node: 2, text: "Save <changes>", extra: true },
      { kind: "attribute", node: 2, name: "aria-label", value: "Save" },
      { kind: "attribute", node: 2, name: "title", value: null },
      { kind: "attribute", node: 4, name: "src", value: "data:image/png;base64,AAAA" },
      { kind: "attribute", node: 4, name: "style", value: "color: red" },
      { kind: "insert", node: 3, position: "before", html: "<p class=\"note\">New</p>" },
      { kind: "replace", node: 5, html: "<a href=\"https://example.com/a\">Link</a>" },
      { kind: "remove", node: 6 },
    ];
    expect(parseEdits(edits)).toEqual([
      edits[0], { kind: "text", node: 2, text: "Save <changes>" }, ...edits.slice(2),
    ] as MockupEdit[]);
  });

  test.each([
    ["not a list", { kind: "remove", node: 1 }],
    ["an unknown kind", [{ kind: "script", node: 1 }]],
    ["a node that isn't a positive whole number", [{ kind: "remove", node: 0 }]],
    ["a fractional node", [{ kind: "remove", node: 1.5 }]],
    ["a node given as text", [{ kind: "remove", node: "3" }]],
    ["an unknown position", [{ kind: "insert", node: 1, position: "inside", html: "<p></p>" }]],
    ["text that isn't a string", [{ kind: "text", node: 1, text: 5 }]],
    ["an event attribute", [{ kind: "attribute", node: 1, name: "onclick", value: "x()" }]],
    ["an event attribute in capitals", [{ kind: "attribute", node: 1, name: "ONLOAD", value: "x()" }]],
    ["srcdoc", [{ kind: "attribute", node: 1, name: "srcdoc", value: "<p>" }]],
    ["an invalid attribute name", [{ kind: "attribute", node: 1, name: "1bad name", value: "x" }]],
    ["an element number", [{ kind: "attribute", node: 1, name: "data-critiqs-node", value: "9" }]],
    ["a script link", [{ kind: "attribute", node: 1, name: "href", value: "javascript:alert(1)" }]],
    ["a script link hidden by spacing and case", [{ kind: "attribute", node: 1, name: "href", value: " JaVa\tScript:alert(1)" }]],
    ["a VBScript form action", [{ kind: "attribute", node: 1, name: "formaction", value: "vbscript:x" }]],
    ["an HTML data address", [{ kind: "attribute", node: 1, name: "src", value: "data:text/html,<script>" }]],
    ["an SVG script link", [{ kind: "attribute", node: 1, name: "xlink:href", value: "javascript:x" }]],
    ["a style attribute that runs code", [{ kind: "attribute", node: 1, name: "style", value: "width: expression(alert(1))" }]],
    ["CSS that closes its style element", [{ kind: "css", css: "p{}</style><script>alert(1)</script>" }]],
    ["CSS that imports", [{ kind: "css", css: "@import url(https://evil.example/x.css);" }]],
    ["CSS with a script address", [{ kind: "css", css: "p { background: url(javascript:alert(1)) }" }]],
    ["CSS with an unclosed block", [{ kind: "css", css: "p { color: red" }]],
    ["CSS that closes a block it didn't open", [{ kind: "css", css: "} body { display: none }" }]],
    ["CSS with an unclosed comment", [{ kind: "css", css: "p { color: red } /* rest" }]],
    ["CSS with an unclosed string", [{ kind: "css", css: "p { content: \"} }" }]],
    ["HTML with a script", [{ kind: "insert", node: 1, position: "append", html: "<div><script>alert(1)</script></div>" }]],
    ["HTML with an event attribute", [{ kind: "replace", node: 1, html: "<img src=x onerror=alert(1)>" }]],
    ["HTML with a frame", [{ kind: "replace", node: 1, html: "<iframe srcdoc=\"x\"></iframe>" }]],
    ["HTML with a script link", [{ kind: "insert", node: 1, position: "append", html: '<a href="javascript:alert(1)">Go</a>' }]],
    ["HTML with a spaced script link", [{ kind: "insert", node: 1, position: "append", html: "<a href=' vbscript:x'>Go</a>" }]],
    ["HTML with an HTML data address", [{ kind: "replace", node: 1, html: '<object data="data:text/html,x"></object>' }]],
    ["HTML with an SVG animation that sets a link", [{ kind: "replace", node: 1, html: '<svg><a><set attributeName="href" to="javascript:x"/></a></svg>' }]],
    ["HTML with an event attribute after a slash", [{ kind: "replace", node: 1, html: "<p/onclick=x>t</p>" }]],
    ["HTML with an entity-encoded script link", [{ kind: "insert", node: 1, position: "append", html: '<a href="jav&#x61;script:alert(1)">Go</a>' }]],
    ["HTML with a decimal-encoded script link", [{ kind: "insert", node: 1, position: "append", html: '<a href="&#106;avascript:alert(1)">Go</a>' }]],
    ["HTML with a named-reference colon", [{ kind: "insert", node: 1, position: "append", html: '<a href="javascript&colon;alert(1)">Go</a>' }]],
    ["HTML with an encoded HTML data address", [{ kind: "insert", node: 1, position: "append", html: '<a href="data&#58;text/html,x">Go</a>' }]],
    ["HTML with an SVG data image", [{ kind: "insert", node: 1, position: "append", html: '<img src="data:image/svg+xml,<svg onload=alert(1)>">' }]],
    ["HTML hiding an event attribute behind quotes in an unquoted value", [{ kind: "replace", node: 1, html: '<img src=/x a=1""b=" onerror=alert(1) ">' }]],
    ["HTML hiding a script behind quotes in an unquoted value", [{ kind: "replace", node: 1, html: '<p a=1""b="><script>alert(1)</script><p x=">hi</p>' }]],
    ["HTML with an element whose text is written out unescaped", [{ kind: "insert", node: 1, position: "append", html: "<xmp></xmp>" }]],
    ["HTML hiding a script behind a quote in a comment", [{ kind: "insert", node: 1, position: "append", html: '<!-- <a title="--> <script>alert(1)</script>">' }]],
    ["HTML hiding a script behind a quote in a bogus comment", [{ kind: "insert", node: 1, position: "append", html: '<? <a title="> <script>alert(1)</script>">' }]],
    ["HTML hiding a script behind a quote in a text area", [{ kind: "insert", node: 1, position: "append", html: '<textarea><a title="</textarea><img src=x onerror=alert(1)>">' }]],
    ["CSS importing through an escape", [{ kind: "css", css: "@\\69 mport url(https://example.com/x.css);" }]],
    ["HTML with a style element", [{ kind: "replace", node: 1, html: "<style>body{display:none}</style>" }]],
    ["HTML over the size limit", [{ kind: "replace", node: 1, html: "x".repeat(MOCKUP_LIMITS.htmlChars + 1) }]],
    ["CSS over the size limit", [{ kind: "css", css: " ".repeat(MOCKUP_LIMITS.cssChars + 1) }]],
    ["too many changes", Array.from({ length: MOCKUP_LIMITS.editsPerVersion + 1 }, () => ({ kind: "remove", node: 1 }))],
    ["a list over the byte limit", Array.from({ length: 14 }, () => ({ kind: "text", node: 1, text: "é".repeat(10_000) }))],
  ])("rejects %s", (_, value) => {
    expect(parseEdits(value)).toBeNull();
  });

  test("rejects the whole list when one change is bad", () => {
    expect(parseEdits([{ kind: "remove", node: 1 }, { kind: "remove" }])).toBeNull();
  });
  test("accepts ordinary markup whose text or addresses only look like code", () => {
    const edits = [
      { kind: "insert", node: 1, position: "append", html: '<a href="/online=1">Go</a>' },
      { kind: "replace", node: 2, html: "<p>Switch on=off below</p>" },
      { kind: "replace", node: 4, html: "<p>Price < budget, score < average (50%)</p>" },
      { kind: "insert", node: 6, position: "append", html: '<a href="cats&dogs">Pets</a><!-- a note --><textarea>Write "here"</textarea>' },
      { kind: "insert", node: 5, position: "after", html: '<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><input value=plain disabled>' },
      { kind: "replace", node: 3, html: '<span data-critiqs-node="9" class="badge">Admin</span>' },
    ] satisfies MockupEdit[];
    expect(parseEdits(edits)).toEqual(edits);
  });
});

describe("sanitizeHtml", () => {
  test("drops everything that could run code, load other pages, or restyle the copy", () => {
    const html = [
      "<div onclick=\"x()\" data-critiqs-node=\"4\" class=\"keep\">",
      "<script>alert(1)</script><noscript>no</noscript><template><b>t</b></template>",
      "<iframe src=\"/x\"></iframe><object data=\"x\"></object><embed src=\"x\">",
      "<base href=\"https://evil.example/\"><meta http-equiv=\"refresh\" content=\"0\"><link rel=\"stylesheet\" href=\"x.css\"><style>*{}</style>",
      "<a href=\" javascript:alert(1)\" title=\"t\">a</a><form action=\"javascript:x\"><button formaction=\"vbscript:x\">b</button></form>",
      "<img src=\"data:text/html,x\" alt=\"pic\" onerror=\"x()\"><img src=\"/ok.png\" srcdoc=\"x\">",
      "<p style=\"width: expression(x)\">kept text</p>",
      "<svg><script>alert(1)</script><a xlink:href=\"javascript:x\"><text>s</text></a><set attributeName=\"href\" to=\"javascript:x\"/></svg>",
      "</div>",
    ].join("");
    const holder = document.createElement("div");
    holder.append(sanitizeHtml(html, document));

    expect(holder.querySelector("script, noscript, template, iframe, frame, object, embed, base, meta, link, style, set")).toBeNull();
    const attributes = Array.from(holder.querySelectorAll("*")).flatMap((element) =>
      element.getAttributeNames().map((name) => `${name}=${element.getAttribute(name)}`));
    expect(attributes.filter((attribute) => /^on|^srcdoc|^data-critiqs-node|script:|text\/html|expression/i.test(attribute))).toEqual([]);
    expect(attributes).toEqual(expect.arrayContaining(["class=keep", "title=t", "alt=pic", "src=/ok.png"]));
    expect(holder.textContent).toContain("kept text");
  });
});

describe("applyEdits", () => {
  const base = "<main><h1>Title</h1><p>One</p><p>Two</p></main>";

  test("numbers added elements in document order after the highest number", () => {
    const doc = copy(base);
    const { skipped } = applyEdits(doc, [
      { kind: "insert", node: 3, position: "after", html: "<section><h2>New</h2></section><aside>Side</aside>" },
      { kind: "replace", node: 4, html: "<p>Replaced <b>bold</b></p>" },
      { kind: "text", node: 8, text: "Edited aside" },
    ]);

    expect(skipped).toEqual([]);
    expect(node(doc, 6)?.outerHTML).toBe('<section data-critiqs-node="6"><h2 data-critiqs-node="7">New</h2></section>');
    expect(node(doc, 8)?.outerHTML).toBe('<aside data-critiqs-node="8">Edited aside</aside>');
    expect(node(doc, 9)?.localName).toBe("p");
    expect(node(doc, 10)?.localName).toBe("b");
    expect(node(doc, 4)).toBeNull();
  });

  test("gives the same document when the same changes are applied to another copy", () => {
    const edits: MockupEdit[] = [
      { kind: "css", css: "[data-critiqs-node=\"2\"] { padding: 8px }" },
      { kind: "insert", node: 2, position: "prepend", html: "<nav><a href=\"/a\">A</a></nav>" },
      { kind: "attribute", node: 6, name: "class", value: "active" },
      { kind: "insert", node: 3, position: "before", html: "<div>Banner</div>" },
      { kind: "remove", node: 5 },
      { kind: "css", css: "@media (max-width: 600px) { nav { display: none } }" },
    ];
    const first = copy(base);
    const second = copy(base);
    applyEdits(first, edits);
    applyEdits(second, edits);

    expect(first.documentElement.outerHTML).toBe(second.documentElement.outerHTML);
    expect(node(first, 8)?.textContent).toBe("Banner");
    expect(node(first, 6)?.getAttribute("class")).toBe("active");
  });

  test("skips changes to missing elements and applies the rest", () => {
    const doc = copy(base);
    const { skipped } = applyEdits(doc, [
      { kind: "remove", node: 3 },
      { kind: "text", node: 3, text: "Gone" },
      { kind: "text", node: 99, text: "Never there" },
      { kind: "text", node: 4, text: "Still applied" },
    ]);

    expect(skipped.map((entry) => entry.index)).toEqual([1, 2]);
    expect(node(doc, 4)?.textContent).toBe("Still applied");
    expect(doc.body.textContent).not.toContain("Title");
  });

  test("never removes, replaces, or puts content outside the page's body", () => {
    const doc = copy(base);
    const { skipped } = applyEdits(doc, [
      { kind: "remove", node: 1 },
      { kind: "replace", node: 1, html: "<p>x</p>" },
      { kind: "text", node: 1, text: "x" },
      { kind: "insert", node: 1, position: "after", html: "<p>x</p>" },
      { kind: "insert", node: 1, position: "append", html: "<footer>Footer</footer>" },
    ]);

    expect(skipped.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(doc.body.lastElementChild?.textContent).toBe("Footer");
    expect(doc.body.textContent).toContain("Title");
  });

  test("puts CSS changes in one stylesheet after the page's, replacing an earlier one", () => {
    const doc = copy(base);
    applyEdits(doc, [{ kind: "css", css: "h1 { color: blue }" }]);
    applyEdits(doc, [{ kind: "css", css: "p { margin: 0 }" }, { kind: "css", css: "h1 { color: green }" }]);

    const styles = Array.from(doc.head.querySelectorAll("style"));
    expect(styles).toHaveLength(2);
    expect(styles.at(-1)?.hasAttribute("data-critiqs-mockup")).toBe(true);
    expect(styles.at(-1)?.textContent).toBe("p { margin: 0 }\nh1 { color: green }");
  });

  test("cleans stored changes again before showing them", () => {
    const doc = copy(base);
    const { skipped } = applyEdits(doc, [
      { kind: "insert", node: 2, position: "append", html: "<p onclick=\"x()\">Hi<script>alert(1)</script></p>" },
      { kind: "attribute", node: 2, name: "onmouseover", value: "x()" },
      { kind: "attribute", node: 2, name: "bad name", value: "x" },
      { kind: "css", css: "</style><script>alert(1)</script>" },
    ]);

    expect(skipped.map((entry) => entry.index)).toEqual([1, 2, 3]);
    expect(doc.querySelector("script, [onclick], [onmouseover], style[data-critiqs-mockup]")).toBeNull();
    expect(node(doc, 6)?.textContent).toBe("Hi");
  });
});

describe("describePage", () => {
  /** Gives elements a box at `top` (page coordinates) of the given height. */
  function place(element: Element | null, top: number, height: number) {
    if (element === null) throw new Error("No such element.");
    element.getBoundingClientRect = () =>
      ({ x: 0, y: top, top, left: 0, width: 800, height, right: 800, bottom: top + height, toJSON() {} }) as DOMRect;
  }

  test("describes an unlaid-out copy from its elements, skipping hidden ones", () => {
    const doc = copy(
      '<header class="top bar" role="banner"><a href="https://proto.example/home">Home</a></header>' +
      '<div style="display: none"><p>Secret</p><p>Menu</p></div>' +
      '<button type="submit" aria-label="Save changes">Save</button>' +
      '<p>Read <a href="/terms">the terms</a> first.</p><select><option>S</option><option selected>L</option></select>',
    );
    const { text, complete, nextTop } = describePage(doc, { top: 0, height: 800, budget: 10_000 });

    expect(text.split("\n")).toEqual([
      "body #1",
      '  header #2 .top.bar role="banner"',
      '    a #3 href="/home" "Home"',
      "  div #4 [hidden, 2 inside]",
      '  button #7 aria-label="Save changes" type="submit" "Save"',
      '  p #8 "Read … first."',
      '    a #9 href="/terms" "the terms"',
      "  select #10",
      '    option #11 "S"',
      '    option #12 selected "L"',
    ]);
    expect(complete).toBe(true);
    expect(nextTop).toBeNull();
  });

  test("stops within its budget and says the description is incomplete", () => {
    const doc = copy(Array.from({ length: 50 }, (_, index) => `<p>Paragraph ${index}</p>`).join(""));
    const { text, complete } = describePage(doc, { top: 0, height: 800, budget: 300 });

    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('"Paragraph 0"');
    expect(text).not.toContain('"Paragraph 49"');
    expect(complete).toBe(false);
  });

  test("outlines what is outside the focus window and says where to look next", () => {
    const rows = Array.from({ length: 10 }, (_, index) => `<li>Row ${index}</li>`).join("");
    const doc = copy(`<header><h1>Title</h1></header><ul>${rows}</ul>`);
    Object.defineProperty(doc.documentElement, "scrollHeight", { value: 2000 });
    place(doc.body, 0, 2000);
    place(doc.querySelector("header"), 0, 100);
    place(doc.querySelector("h1"), 20, 60);
    place(doc.querySelector("ul"), 100, 1900);
    doc.querySelectorAll("li").forEach((row, index) => place(row, 100 + index * 190, 190));

    const { text, complete, nextTop } = describePage(doc, { top: 0, height: 600, budget: 10_000 });
    const lines = text.split("\n");

    expect(lines.find((line) => line.includes('"Title"'))).toMatch(/\{.*800x60\}$/);
    expect(lines.filter((line) => /"Row [0-2]"/.test(line) && line.includes("{"))).toHaveLength(3);
    expect(lines.filter((line) => /"Row [3-5]" \[below\]$/.test(line))).toHaveLength(3);
    expect(lines.at(-1)).toBe("    … 4 more siblings #11–#14 [below, 4 elements]");
    expect(complete).toBe(false);
    expect(nextTop).toBe(670);
  });
});

test("text in elements a browser writes out unescaped is never changed, and the sanitizer drops them", () => {
  document.body.innerHTML = '<xmp data-critiqs-node="1">old</xmp>';
  const { skipped } = applyEdits(document, [{ kind: "text", node: 1, text: "</xmp><meta http-equiv=refresh content=0>" }]);
  expect(skipped).toHaveLength(1);
  expect(document.querySelector("xmp")!.textContent).toBe("old");

  const holder = document.createElement("div");
  holder.append(sanitizeHtml('<xmp>x</xmp><noembed>y</noembed><svg><animate attributeName=" href" to="javascript:alert(1)"/></svg><a href="cats&dogs">Pets</a>', document));
  expect(holder.querySelector("xmp, noembed, animate")).toBeNull();
  expect(holder.querySelector("a")!.getAttribute("href")).toBe("cats&dogs");
  document.body.innerHTML = "";
});

describe("prioritizeMockupStyles", () => {
  test("makes the mockup's declarations win over the page's more specific rules", () => {
    document.head.innerHTML = "<style>.row span:first-child { font-weight: 500; }</style>";
    document.body.innerHTML = '<div class="row"><span data-critiqs-node="2">Alex</span></div>';
    applyEdits(document, [{ kind: "css", css: '@media (min-width: 1px) { [data-critiqs-node="2"] { font-weight: 700; color: navy } }' }]);

    prioritizeMockupStyles(document);

    const style = document.querySelector<HTMLStyleElement>("style[data-critiqs-mockup]")!;
    const rule = (style.sheet!.cssRules[0] as CSSMediaRule).cssRules[0] as CSSStyleRule;
    expect([rule.style.getPropertyPriority("font-weight"), rule.style.getPropertyPriority("color")]).toEqual(["important", "important"]);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
});

test("leaves keyframes and font faces as written, where important declarations would be ignored", () => {
  document.body.innerHTML = '<div data-critiqs-node="1">Hi</div>';
  applyEdits(document, [{ kind: "css", css: "@keyframes fade { from { opacity: 0 } to { opacity: 1 } } [data-critiqs-node=\"1\"] { animation: fade 1s }" }]);

  prioritizeMockupStyles(document);

  const rules = Array.from(document.querySelector<HTMLStyleElement>("style[data-critiqs-mockup]")!.sheet!.cssRules);
  expect(rules.map((rule) => rule.cssText).join("\n")).not.toMatch(/opacity: [01] !important/);
  expect((rules.find((rule) => rule.type === 1) as CSSStyleRule).style.getPropertyPriority("animation")).toBe("important");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
