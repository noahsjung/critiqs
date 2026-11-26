import { expect, test } from "bun:test";
import { markdownCode, markdownLines, markdownLink, markdownText } from "../src/markdown-text.ts";
import type { WebAddress } from "../src/web-address.ts";
import { githubReferences, render, renderGfm, renderLinkified, renderMarked } from "./markdown-oracle.ts";

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
  const rendered = render(markdownLink("[x](https://evil.example) <b>", "https://review.example/a b?x=1&y=<2>" as WebAddress));
  expect(rendered.tags).toEqual(["p", "a"]);
  expect(rendered.hrefs).toEqual(["https://review.example/a%20b?x=1&y=%3C2%3E"]);
  expect(rendered.text).toBe("[x](https://evil.example) <b>");
});

/** Every string of up to `length` characters from `alphabet`. */
function* strings(alphabet: string, length: number, prefix = ""): Generator<string> {
  if (prefix !== "") yield prefix;
  if (prefix.length === length) return;
  for (const char of alphabet) yield* strings(alphabet, length, prefix + char);
}

test("no line of a person's text makes a table, heading underline, rule, or other block from the line above it, in GitHub's Markdown", () => {
  // Each place a line of a person's text goes, with the line above it a person's too, or Critiqs's.
  const places: Record<string, (above: string, line: string) => string> = {
    "paragraph": (above, line) => `${above}\n${line}\n`,
    "after a blank line": (above, line) => `${above}\n\n${line}\n`,
    "indented": (above, line) => `${above}\n   ${line}\n`,
    "quote": (above, line) => `> ${above}\n> ${line}\n`,
    "list item": (above, line) => `- ${above}\n  ${line}\n`,
  };
  const aboves = ["The totals column is wrong", markdownText("Hello | world"), markdownText("- x")];
  for (const line of strings("-:=*_+#>|. a", 3)) {
    // The line as one piece, and as two pieces escaped separately and joined, as Critiqs joins a key and its value.
    for (const pieces of [[line], ...Array.from({ length: line.length - 1 }, (_, index) => index + 1).map((cut) => [line.slice(0, cut), line.slice(cut)])]) {
      const written = pieces.map(asWritten).join("");
      const escaped = pieces.map(markdownText).join("");
      if (written === "") continue;
      for (const [place, build] of Object.entries(places)) {
        for (const above of aboves) {
          const rendered = renderGfm(build(above, escaped));
          const blocks = [...new Set(rendered.tags)].filter((tag) => !["p", "blockquote", "ul", "li", "br"].includes(tag));
          expect({ line, place, escaped, blocks, text: rendered.text.includes(written) }).toEqual({ line, place, escaped, blocks: [], text: true });
        }
      }
    }
  }
  // Linear starts a collapsed section at a line beginning `+++`.
  expect(markdownText("+++ Hidden")).toBe("\\+++ Hidden");
}, 60_000);

test("a reviewer's text can't mention anyone, reference an issue, or make an emoji on GitHub, and reads exactly as written", () => {
  const cases = [
    "@octocat can you look?",
    "cc @acme/designers",
    "Same as #12 and GH-3, see acme/app#4 or acme#5",
    "Here: https://github.com/acme/app/issues/6 and github.com/acme/app/pull/7",
    "Mail dana@example.com about it :smile: :+1:",
    "(@octocat) a.@octocat x@b.co",
  ];
  for (const value of cases) {
    const escaped = markdownText(value);
    for (const rendered of [renderGfm(escaped), render(escaped), renderLinkified(escaped)]) {
      expect({ value, text: rendered.text, references: githubReferences(rendered.html), links: rendered.hrefs }).toEqual({ value, text: value, references: [], links: [] });
    }
  }
  // Only a word joiner, which shows nothing, goes between a reference's sign and the rest.
  expect(markdownText("@octocat #12 GH-3 :smile:")).toBe("@\u2060octocat #\u206012 GH-\u20603 :\u2060smile:");
  expect(markdownText("No mention, issue or emoji: meet at 10, then lunch")).toBe("No mention, issue or emoji: meet at 10, then lunch");
});

test("a piece ending in a scheme next to one starting with an address makes no link where Critiqs joins them", () => {
  for (const [key, value] of [["mailto:", "@b.co"], ["MAILTO:", "@evil.example"], ["xmpp:", "@b.co"], ["mailto: ", "@b.co"]] as const) {
    for (const line of [`- View state: ${markdownText(key)}=${markdownText(value)}`, `x ${markdownText(key)}.${markdownText(value)} y`]) {
      for (const rendered of [renderGfm(line), render(line), renderLinkified(line)]) expect({ line, links: rendered.hrefs }).toEqual({ line, links: [] });
    }
  }
});

test("an & before word characters and ; reaches the browser as text, in every renderer, so a browser reads no character reference in it", () => {
  // A browser reads `&amp_x;` as `&_x;` and `&copy_amp;` as `©_amp;`: the legacy references need no `;`.
  for (const value of ["&amp_x;", "&copy_amp;", "&lt_b;", "x &nbsp_1; y", "&#_1;", "&a_b;"]) {
    for (const rendered of [render(markdownText(value)), renderGfm(markdownText(value)), renderLinkified(markdownText(value)), renderMarked(markdownText(value))]) {
      expect({ value, raw: rendered.html.match(/&(?!amp;|lt;|gt;|quot;|#39;|#\d+;)/g) ?? [] }).toEqual({ value, raw: [] });
    }
  }
  // An & in a sentence still needs no backslash.
  expect(markdownText("R&D and Q&A teams")).toBe("R&D and Q&A teams");
});
