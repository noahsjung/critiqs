import { expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { markdownBlocks } from "../src/markdown-blocks.ts";

// markdown-it in its CommonMark mode, which passes CommonMark's spec tests.
// Bun's own renderer reads some indents that mix spaces and tabs, such as
// " \t</div>" after a paragraph, differently from the spec.
const renderer = new MarkdownIt("commonmark");
const commonmark = (text: string) => renderer.render(text);

test("a code fence is left open at the top level exactly where a CommonMark renderer reads what follows as code", () => {
  let seed = 1;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T>(choices: T[]) => choices[Math.floor(random() * choices.length)]!;
  const indents = ["", " ", "  ", "   ", "    ", "\t", " \t"];
  const starts = ["```", "````", "~~~", "```js", "``` a`", "~~~ `x`", "``` x", "- ", "* ", "1. ", "2) ", "10. ", "> ", ">", "# ", "text", "---", "===", "<div>", "</div>", "<span>", "<!-- x -->", "", " ", "- ```", "1. ```", "> ```"];
  const ends = ["", "x", " y", "```", "~~~", " `z`"];
  let open = 0;
  for (let count = 0; count < 3_000; count++) {
    const lines: string[] = [];
    for (let length = 1 + Math.floor(random() * 6); length > 0; length--) lines.push(`${pick(indents)}${pick(starts)}${random() < 0.4 ? pick(starts) : ""}${pick(ends)}`);
    const text = lines.join(pick(["\n", "\r\n", "\r"]));
    const swallowed = !commonmark(`${text}\n\nAFTER\n`).includes("<p>AFTER</p>");
    const fence = markdownBlocks(text).openFence;
    if (fence !== null) open++;
    expect({ text, open: fence !== null }).toEqual({ text, open: swallowed });
  }
  // The inputs reach both answers often.
  expect(open).toBeGreaterThan(300);
});

test("a fence's kind and length are what its closing fence must match", () => {
  expect(markdownBlocks("````\n```\n~~~~").openFence).toEqual({ char: "`", length: 4 });
  expect(markdownBlocks("~~~\ncode\n~~~ \n").openFence).toBeNull();
  // A backtick in a backtick fence's info string makes the line text; a tilde fence's may have one.
  expect(markdownBlocks("``` a`").openFence).toBeNull();
  expect(markdownBlocks("~~~ a`").openFence).toEqual({ char: "~", length: 3 });
  // Indented 4 or more, it's code, not a fence.
  expect(markdownBlocks("    ```").openFence).toBeNull();
});
