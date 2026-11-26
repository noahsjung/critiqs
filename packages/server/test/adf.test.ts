import { expect, test } from "bun:test";
import { aiTicketText, draftedSections, plainText, STANDARD_OUTLINE, ticketBody, ticketCaptureMissing, ticketLinkComment, type TicketMarkdown, webAddress } from "@critiqs/core";
import { markdownToAdf, plainAdf } from "../src/tickets/trackers/adf.ts";
import { adfText, validAdf } from "./jira-standin.ts";

// Markdown as the converter gets it: text Critiqs made, here from drafts with nothing added.
const doc = (markdown: string) => markdownToAdf(markdown as TicketMarkdown);

test("headings, paragraphs, lists, quotes, code, and rules become their ADF nodes", () => {
  const converted = doc("## Context\n\nFirst line\nsame paragraph\n\n- one\n- two\n  - nested\n\n3. three\n4. four\n\n> quoted\n> more\n\n```ts\nconst a = 1;\n```\n\n---\n");
  expect(validAdf(converted)).toBeNull();
  expect(converted.content.map((block) => block.type)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "codeBlock", "rule"]);
  expect(converted.content[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Context" }] });
  expect(converted.content[1]).toEqual({ type: "paragraph", content: [{ type: "text", text: "First line same paragraph" }] });
  expect(converted.content[3]).toMatchObject({ type: "orderedList", attrs: { order: 3 } });
  expect(converted.content[5]).toEqual({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;" }] });
  expect(adfText(converted.content[2])).toBe("one\ntwo\nnested\n");
});

test("inline code, emphasis, links, and escapes become marks and text, never markup", () => {
  const converted = doc("Use `npm i` and **bold _both_** then [the thread](<https://example.com/a?b=1&amp;c=2>) \\*not em\\* <https://x.test/y>");
  expect(validAdf(converted)).toBeNull();
  const [paragraph] = converted.content;
  expect(paragraph).toEqual({
    type: "paragraph",
    content: [
      { type: "text", text: "Use " },
      { type: "text", text: "npm i", marks: [{ type: "code" }] },
      { type: "text", text: " and " },
      { type: "text", text: "bold ", marks: [{ type: "strong" }] },
      { type: "text", text: "both", marks: [{ type: "strong" }, { type: "em" }] },
      { type: "text", text: " then " },
      { type: "text", text: "the thread", marks: [{ type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } }] },
      { type: "text", text: " *not em* " },
      { type: "text", text: "https://x.test/y", marks: [{ type: "link", attrs: { href: "https://x.test/y" } }] },
    ],
  });
});

test("only web and email links are kept; any other address stays as text", () => {
  const converted = doc("[click](javascript:alert(1)) and [mail](mailto:a@b.test) and ![shot](https://img.test/a.png)");
  expect(validAdf(converted)).toBeNull();
  const nodes = converted.content[0]!.type === "paragraph" ? converted.content[0]!.content! : [];
  expect(nodes[0]).toEqual({ type: "text", text: "click and " });
  expect(JSON.stringify(nodes)).not.toContain("javascript:");
  expect(nodes.find((node) => node.type === "text" && node.text === "mail")).toMatchObject({ marks: [{ type: "link", attrs: { href: "mailto:a@b.test" } }] });
  expect(nodes.find((node) => node.type === "text" && node.text === "shot")).toMatchObject({ marks: [{ type: "link", attrs: { href: "https://img.test/a.png" } }] });
});

test("blocks ADF doesn't allow where they are become what it does, keeping their text", () => {
  const converted = doc("> # Heading in a quote\n> ---\n> > nested quote\n\n- > quote in a list\n- # heading in a list");
  expect(validAdf(converted)).toBeNull();
  expect(adfText(converted)).toBe("Heading in a quote\nnested quote\nquote in a list\nheading in a list\n");
});

test("Critiqs's own ticket text converts to valid ADF with every word kept", () => {
  const link = webAddress("https://app.test/review?critiqs-thread=t1&x=<y>")!;
  const sections = draftedSections(STANDARD_OUTLINE, [
    { heading: "Summary", text: "The *Department* label [is] wrong <b>", items: [], numbered: false },
    { heading: "Steps to reproduce", text: "", items: ["Open `Settings`", "Click Save"], numbered: true },
  ]);
  const draft = aiTicketText(sections, STANDARD_OUTLINE, link);
  const body = ticketBody(`${draft}\n\`\`\`\nunclosed fence`, { capture: null, attribution: { name: "Dana <Smith>" }, link });
  for (const markdown of [draft, body, ticketLinkComment("> quoted\n**bold**", { link, attribution: null }), ticketCaptureMissing(link)]) {
    const converted = doc(markdown);
    expect(validAdf(converted)).toBeNull();
  }
  const text = adfText(doc(draft));
  expect(text).toContain("The *Department* label [is] wrong <b>");
  expect(text).toContain("Open `Settings`");
  expect(text).toContain("open the thread");
  // The thread's link survives the escaping Critiqs writes in link addresses.
  expect(JSON.stringify(doc(draft))).toContain(JSON.stringify(link).slice(1, -1).replace("<", "%3C").replace(">", "%3E"));
  expect(adfText(doc(body))).toContain("unclosed fence");
  expect(plainText("x")).toBe("x" as never);
});

test("plain text stays plain: paragraphs and line breaks, no Markdown read", () => {
  expect(plainAdf("**not bold**\nsecond line\n\nnext")).toEqual({
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "**not bold**" }, { type: "hardBreak" }, { type: "text", text: "second line" }] },
      { type: "paragraph", content: [{ type: "text", text: "next" }] },
    ],
  });
});

test("any text converts to a document Jira takes, with no text node empty", () => {
  const pieces = ["#", "##", " ", "\n", "\n\n", "-", "*", "_", "`", "```", "~~~", ">", "1.", "[", "]", "(", ")", "<", ">", "!", "\\", "a", "b c", "**", "---", "&amp;", "|", "    ", "\t"];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let run = 0; run < 3000; run++) {
    let markdown = "";
    for (let piece = 0; piece < 1 + Math.floor(random() * 30); piece++) markdown += pieces[Math.floor(random() * pieces.length)];
    const converted = doc(markdown);
    const problem = validAdf(converted);
    if (problem !== null) throw new Error(`${JSON.stringify(markdown)}: ${problem}`);
  }
});
