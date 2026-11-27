import { expect, test } from "bun:test";
import { markdownBlocks } from "../src/markdown-blocks.ts";

test("a paragraph of only link reference definitions is never a setext heading", () => {
  expect(markdownBlocks("[a]: /url\n===").headings).toEqual([]);
  expect(markdownBlocks("[a]: /url\n---").headings).toEqual([]);
  expect(markdownBlocks('[a]: /url "title"\n[b]: <other>\n===').headings).toEqual([]);
  // Definitions before the text aren't part of the heading's text.
  expect(markdownBlocks("[foo]: /url\nbar\n===").headings.map((heading) => heading.text)).toEqual(["bar"]);
  expect(markdownBlocks("Real\n===").headings.map((heading) => heading.text)).toEqual(["Real"]);
});

test("the block a text leaves open at the top level is reported with the line that ends it", () => {
  const end = (text: string) => markdownBlocks(text).openBlockEnd;
  expect(end("x\n```\ncode")).toBe("```");
  expect(end("x\n<!-- comment")).toBe("-->");
  expect(end("<pre>\ntext")).toBe("</pre>");
  expect(end("<?php")).toBe("?>");
  expect(end("<!DOCTYPE x")).toBe(">");
  expect(end("<![CDATA[ x")).toBe("]]>");
  // Closed, or ended by a blank line, or inside a quote that a blank line ends: nothing to close.
  expect(end("<!-- done -->")).toBeNull();
  expect(end("<div>\nx")).toBeNull();
  expect(end("> ```\n> code")).toBeNull();
  expect(end("plain")).toBeNull();
});

test("an open script, style, or textarea block is ended by its own closing tag, which HTML also ends it with", () => {
  // CommonMark ends all four kinds at any of their closing tags, but a browser's HTML reads a script, style, or
  // textarea's content as text until its own: closing one with `</pre>` would leave what follows inside it.
  const end = (text: string) => markdownBlocks(text).openBlockEnd;
  expect(end("<script>\nvar x = 1;")).toBe("</script>");
  expect(end("<STYLE type=\"text/css\">\nbody { color: red }")).toBe("</style>");
  expect(end("<textarea>\nleft open")).toBe("</textarea>");
  expect(end("<pre>\ntext")).toBe("</pre>");
  expect(end("<script>\nx\n</script>")).toBeNull();
});
