import { expect, test } from "bun:test";
import { markdownCode, markdownLines, markdownLink, markdownText } from "../src/markdown-text.ts";
import { render } from "./markdown-oracle.ts";

const TOKENS = [
  "[", "]", "(", ")", "<", ">", "!", "`", "``", "```", "~~~", "*", "_", "~", "#", "##", "-", "+", "=", "|", "\\", "&", "&amp;", "&#60;",
  ":", "/", ".", "@", "$", "^", "{", "}", "1.", "1)", "> ", "    ", "\t", "<!--", "-->", "<?", "<![CDATA[", "<script>", "<img src=x>",
  "www.evil.example", "https://evil.example/a?b=c", "mailto:a@b.co", "a@b.co", "javascript:alert(1)", "[x]: /url", "![i](u)", "[l](u)",
  " ", " ", " ", "x", "word", "ü", "＜",
];

/** A random string of hostile pieces, from a seeded generator so a failure repeats. */
function hostile(seed: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const length = 1 + (next() % 12);
  let text = "";
  for (let index = 0; index < length; index++) text += next() % 4 === 0 ? String.fromCharCode(33 + (next() % 94)) : TOKENS[next() % TOKENS.length];
  return text;
}

const asWritten = (value: string) => value.replace(/\s+/g, " ").trim();

test("text from people renders exactly as written, as one paragraph of text with no other structure", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const value = hostile(seed);
    if (asWritten(value) === "") continue;
    const rendered = render(markdownText(value));
    expect({ seed, tags: rendered.tags, text: rendered.text }).toEqual({ seed, tags: ["p"], text: asWritten(value) });
  }
});

test("a comment's lines render as written, inside a quote, with no other structure", () => {
  for (let seed = 1; seed <= 1000; seed++) {
    const value = [hostile(seed), hostile(seed + 7), "", hostile(seed + 13)].join("\n");
    const rendered = render(markdownLines(value).map((line) => `> ${line}`).join("\n"));
    expect({ seed, tags: [...new Set(rendered.tags)].filter((tag) => tag !== "blockquote" && tag !== "p" && tag !== "br") }).toEqual({ seed, tags: [] });
  }
});

test("a code span holds any text, backticks included, as written", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const value = hostile(seed);
    if (asWritten(value) === "") continue;
    const rendered = render(`x ${markdownCode(value)} y`);
    expect({ seed, tags: rendered.tags, text: rendered.text }).toEqual({ seed, tags: ["p", "code"], text: `x ${asWritten(value)} y` });
  }
  expect(markdownCode("user.department")).toBe("`user.department`");
  expect(markdownCode("a``b")).toBe("```a``b```");
  expect(markdownCode("`edge")).toBe("`` `edge ``");
});

test("a link's text is escaped and its address renders exactly as given", () => {
  const rendered = render(markdownLink("[x](https://evil.example) <b>", "https://review.example/a b?x=1&y=<2>"));
  expect(rendered.tags).toEqual(["p", "a"]);
  expect(rendered.hrefs).toEqual(["https://review.example/a%20b?x=1&y=%3C2%3E"]);
  expect(rendered.text).toBe("[x](https://evil.example) <b>");
});
