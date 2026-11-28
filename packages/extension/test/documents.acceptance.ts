// Acceptance A13: the documents describe Critiqs on the page, not the side
// panel. Run with `bun test ./test/documents.acceptance.ts` (the file name
// keeps it out of the unit tests until the documents are rewritten).
import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/** The text without changelog sections, where old names may stay. */
function withoutChangelog(markdown: string): string {
  const kept: string[] = [];
  let skipping = 0;
  for (const line of markdown.split("\n")) {
    const heading = /^(#+)\s+(.*)/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (skipping > 0 && level <= skipping) skipping = 0;
      if (skipping === 0 && /changelog|release notes|history/i.test(heading[2]!)) skipping = level;
    }
    if (skipping === 0) kept.push(line);
  }
  return kept.join("\n");
}

/** Sentences of a document, roughly: enough to find what one sentence says. */
const sentences = (text: string) => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);

test("A13.1 the extension's README, MANUAL_TEST.md, the store listing and the privacy page don't describe a side panel or a Mockup tab", async () => {
  const found: string[] = [];
  for (const path of ["../README.md", "../MANUAL_TEST.md", "../store/listing.md", "../../../site-src/content/pages/privacy.md"]) {
    const lines = withoutChangelog(await read(path)).split("\n");
    lines.forEach((line, index) => {
      if (/side ?panel|mockup tab/i.test(line)) found.push(`${path.replace(/^(\.\.\/)+/, "")}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  expect(found).toEqual([]);
});

test("A13.2 the privacy page says the reviewed page can see what is typed into Critiqs there, and can't read the sign-in", async () => {
  const said = sentences(await read("../../../site-src/content/pages/privacy.md"));
  const typed = said.filter((sentence) => /page/i.test(sentence) && /(see|read)/i.test(sentence) && /what you type/i.test(sentence) && /Critiqs/i.test(sentence));
  const signIn = said.filter((sentence) => /(can't|cannot|can not) (read|see) your sign-in/i.test(sentence));
  expect({ typed: typed.length > 0, signIn: signIn.length > 0 }).toEqual({ typed: true, signIn: true });
});

test("A13.3 the technical direction describes madeWith from the panel's surface, and says the extension reads ?critiqs= links once open", async () => {
  const said = sentences(await read("../../../docs/technical-direction.md"));
  const surface = said.some((sentence) => /madeWith/.test(sentence) && /surface/.test(sentence));
  const links = said.filter((sentence) => /extension/i.test(sentence) && /\?critiqs=/.test(sentence));
  const reads = links.some((sentence) => /\bread/i.test(sentence) && !/(doesn't|does not|don't|never) read/i.test(sentence));
  const stillSaysNot = links.filter((sentence) => /(doesn't|does not|don't|never) read/i.test(sentence)).map((sentence) => sentence.slice(0, 120));
  expect({ surface, reads, stillSaysNot }).toEqual({ surface: true, reads: true, stillSaysNot: [] });
});
