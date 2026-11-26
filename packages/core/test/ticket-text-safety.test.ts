import { expect, test } from "bun:test";
import type { ExportThread } from "../src/export.ts";
import { ticketText } from "../src/tickets.ts";
import { githubReferences, render, renderGfm, TICKET_TAGS } from "./markdown-oracle.ts";

// Ticket text goes into a tracker the whole team reads, under the creator's
// name. Everything in it that a reviewer or a tracker wrote must render
// exactly as written: no link, image, HTML, or other structure of theirs.

const LINK = "https://review.example/app?critiqs=t1";

const HOSTILE = [
  "[Phish](https://evil.example)",
  "![track](https://evil.example/px.png)",
  "<img src=x onerror=alert(1)>",
  "<b>bold</b>",
  "www.evil.example",
  "https://evil.example/a",
  "mallory@evil.example",
  "`code` *em* _em_ ~~del~~",
  "<!-- open comment",
];
const hostile = HOSTILE.join(" ");

const thread: ExportThread = {
  id: "t1",
  link: "https://proto.example/?critiqs=t1",
  status: "open",
  tags: ["[tag](https://evil.example)", "<i>x</i>"],
  screen: `screen ${hostile}`,
  viewState: { "[k](https://evil.example)": `v ${hostile}` },
  scope: "record",
  target: { purposeId: "btn` [click](https://evil.example) `x", recordKey: `rec ${hostile}`, label: `label ${hostile}` },
  revision: `rev ${hostile}`,
  pageUrl: "https://proto.example/users/alex?session=SECRET-TOKEN#access_token=SECRET2",
  viewport: { width: 1440, height: 900 },
  persona: `--> ${hostile}`,
  reattached: false,
  hasCapture: false,
  messages: [
    { id: "m1", link: "x", author: "[Admin](https://evil.example)", createdAt: 0, editedAt: null, body: `First ${hostile}\n\n    indented code\n# not a heading\n1. not a list\n\`\`\`\nunclosed fence`, revision: "r1" },
    { id: "m2", link: "x", author: "<img src=y>", createdAt: 0, editedAt: null, body: `<script>alert(1)</script>\n${hostile}`, revision: null },
  ],
};

function expectOnlyCritiqsMarkup(markdown: string) {
  const rendered = render(markdown);
  const foreign = rendered.tags.filter((tag) => !TICKET_TAGS.has(tag));
  expect({ foreign, images: rendered.images, hrefs: [...new Set(rendered.hrefs)] }).toEqual({ foreign: [], images: [], hrefs: [LINK] });
  return rendered;
}

test("a plain ticket draft renders reviewers' text exactly as written, with Critiqs's thread link the only link", () => {
  const { body } = ticketText(thread, { attribution: { name: "[Admin](https://evil.example) <img src=x onerror=alert(1)>" }, link: LINK, captureNote: "uploaded" });
  const rendered = expectOnlyCritiqsMarkup(body);
  // What they wrote is still all there, as text.
  for (const piece of ["[Phish](https://evil.example)", "<img src=x onerror=alert(1)>", "www.evil.example", "`code` *em* _em_ ~~del~~", "[Admin](https://evil.example)"]) {
    expect(rendered.text).toContain(piece);
  }
  // Reviewers' lines can't become headings, lists, or code blocks either.
  expect(rendered.tags.filter((tag) => tag === "h1")).toEqual([]);
  expect(rendered.tags.filter((tag) => tag === "ol")).toEqual([]);
  expect(rendered.html).not.toContain("<pre");
  // The attribution line stays outside any comment or code a reviewer opened.
  expect(rendered.text).toContain("Created from Critiqs by [Admin](https://evil.example) <img src=x onerror=alert(1)>: open the thread");
});

test("a ticket's page address leaves out the page's query and fragment, which can carry a prototype's sign-in token", () => {
  const { body } = ticketText(thread, { attribution: null, link: LINK, captureNote: "uploaded" });
  expect(body).not.toContain("SECRET");
  expect(render(body).text).toContain("Page: https://proto.example/users/alex at 1440×900");
});

test("a reviewer's comment line that is only a table's delimiter stays a line of the comment in a GitHub issue, and the comment pings and links no one", () => {
  const comment = "The totals column is wrong\n:-\nIt should add up the rows\n-:\n:-:\n@octocat see #12, acme/app#3 and https://github.com/acme/app/issues/4 :smile:";
  const { body } = ticketText({ ...thread, messages: [{ ...thread.messages[0]!, body: comment }] }, { attribution: null, link: LINK, captureNote: "link" });
  const quote = body.slice(0, body.indexOf("## Context"));
  const rendered = renderGfm(quote);
  expect({ tables: rendered.tags.filter((tag) => tag === "table"), references: githubReferences(rendered.html) }).toEqual({ tables: [], references: [] });
  expect(rendered.text).toBe(comment.replace(/\n/g, " "));
});

test("a ticket's title from a reviewer's first line reads as written and mentions no one", () => {
  const { title } = ticketText({ ...thread, messages: [{ ...thread.messages[0]!, body: "@octocat #12 is back :smile:\nmore" }] }, { attribution: null, link: LINK, captureNote: "link" });
  expect(title.replace(/\u2060/g, "")).toBe("@octocat #12 is back :smile:");
  expect(githubReferences(title)).toEqual([]);
});
