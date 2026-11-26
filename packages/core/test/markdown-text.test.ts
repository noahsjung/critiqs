import { expect, test } from "bun:test";
import { markdownCode, markdownLines, markdownLink, markdownText } from "../src/markdown-text.ts";
import { render } from "./markdown-oracle.ts";

const TOKENS = [
  "[", "]", "(", ")", "<", ">", "!", "`", "``", "```", "~~~", "*", "_", "~", "#", "##", "-", "+", "=", "|", "\\", "&", "&amp;", "&#60;",
  ":", "/", ".", "@", "$", "^", "{", "}", "1.", "1)", "> ", "    ", "\t", "<!--", "-->", "<?", "<![CDATA[", "<script>", "<img src=x>",
  "www.evil.example", "www.", "www.-", "www.---W", "a.-b", "a._b", "https://evil.example/a?b=c", "mailto:a@b.co", "a@b.co", "javascript:alert(1)", "[x]: /url", "![i](u)", "[l](u)",
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

/** The first escaper, which escaped every character Markdown can give a meaning to anywhere: the reference the minimal one must render the same as. */
const escapeEverything = (value: string) => asWritten(value).replace(/[#$&()*+\-./:<=>@[\\\]^_`{|}~]/g, "\\$&");

const SENTENCES = [
  "The Save button is wrong. It should say Submit, not Save!",
  "Department shows Sales; expected Engineering (see row 3).",
  "Can't find the user-list page after login, can you check?",
  "Use snake_case names here - the API expects them.",
  "C# and F# are both listed; 10:30 is the wrong time.",
];

test("ordinary sentences come out with no backslashes; a character is escaped only where it would mean something", () => {
  for (const sentence of SENTENCES) expect(markdownText(sentence)).toBe(sentence);
  expect(markdownLines(SENTENCES.join("\n"))).toEqual(SENTENCES);
  // Where Markdown would read them: at the start of a line, or opening something.
  expect(markdownText("1. First")).toBe("1\\. First");
  expect(markdownText("- item")).toBe("\\- item");
  expect(markdownText("# Title")).toBe("\\# Title");
  expect(markdownText("> quote")).toBe("\\> quote");
  expect(markdownText("---")).toBe("\\---");
  expect(markdownText("===")).toBe("\\===");
  expect(markdownText("see *this* and [that](x)")).toBe("see \\*this\\* and \\[that\\]\\(x)");
  expect(markdownText("<b>bold</b> &amp; www.evil.example")).toBe("\\<b>bold\\</b> \\&amp; www\\.evil\\.example");
  expect(markdownText("Issue #")).toBe("Issue \\#");
});

test("the minimal escaping renders exactly as escaping everything did, in each place Critiqs puts text", () => {
  const places = [
    (escape: (value: string) => string, value: string) => escape(value),
    (escape: (value: string) => string, value: string) => `- **Screen:** ${escape(value)}`,
    (escape: (value: string) => string, value: string) => `### ${escape(value)}`,
    (escape: (value: string) => string, value: string) => `**${escape(value)}**, 1 Jan`,
    (escape: (value: string) => string, value: string) => `[${escape(value)}](<https://review.example/a>)`,
  ];
  for (let seed = 1; seed <= 2000; seed++) {
    const value = hostile(seed);
    if (asWritten(value) === "") continue;
    for (const [place, build] of places.entries()) {
      const before = render(build(escapeEverything, value));
      const after = render(build(markdownText, value));
      expect({ seed, place, tags: after.tags, hrefs: after.hrefs, text: after.text }).toEqual({ seed, place, tags: before.tags, hrefs: before.hrefs, text: before.text });
    }
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
