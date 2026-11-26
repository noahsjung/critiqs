import { expect, test } from "bun:test";
import type { ExportThread } from "../src/export.ts";
import { TRACKERS, ticketText } from "../src/tickets.ts";

const thread: ExportThread = {
  id: "t1",
  link: "https://proto.example/?critiqs=t1",
  status: "open",
  tags: ["Bug", "Wording"],
  screen: "user-details",
  viewState: { tab: "permissions" },
  scope: "record",
  target: { purposeId: "user.department", recordKey: "user:alex", label: "Sales" },
  revision: "abc123",
  pageUrl: "https://proto.example/users/alex",
  viewport: { width: 1440, height: 900 },
  persona: "Admin",
  reattached: false,
  hasCapture: true,
  messages: [
    { id: "m1", link: "https://proto.example/?critiqs=t1&m=m1", author: "Dana", createdAt: Date.UTC(2026, 9, 9), editedAt: null, body: "Department is wrong\nShould be Support", revision: "abc123" },
    { id: "m2", link: "https://proto.example/?critiqs=t1&m=m2", author: "Lee", createdAt: Date.UTC(2026, 9, 10), editedAt: null, body: "Agreed, and the label too", revision: null },
  ],
};

const review = "https://review.example/?critiqs=t1";

test("Critiqs offers Linear, then GitHub Issues, then Jira", () => {
  expect(TRACKERS.map((tracker) => tracker.label)).toEqual(["Linear", "GitHub Issues", "Jira"]);
});

test("a ticket's title is the first message's first line, and its text starts with that message, quoted", () => {
  const { title, body } = ticketText(thread, { attribution: { name: "Dana" }, link: review, captureNote: "uploaded" });
  expect(title).toBe("Department is wrong");
  expect(body.startsWith("> Department is wrong\n> Should be Support\n")).toBe(true);
});

test("a long first line is shortened for the title", () => {
  const long = { ...thread, messages: [{ ...thread.messages[0]!, body: "x".repeat(100) }] };
  const { title } = ticketText(long, { attribution: null, link: review, captureNote: "uploaded" });
  expect(title).toBe(`${"x".repeat(71)}…`);
});

test("the text carries the thread's link, context, and whole discussion", () => {
  const { body } = ticketText(thread, { attribution: { name: "Dana" }, link: review, captureNote: "uploaded" });
  expect(body).toContain("- Link: [open the thread](");
  // Reviewers' and the app's text is escaped, so it renders exactly as written.
  expect(body).toContain("- Screen: user\\-details");
  expect(body).toContain('- Target: `user.department`, "Sales", record user\\:alex');
  expect(body).toContain("- Scope: this record only");
  expect(body).toContain("- Revision: abc123");
  expect(body).toContain("- Tags: Bug, Wording");
  expect(body).toContain("**Dana**, 2026-10-09T00:00:00.000Z, revision abc123:");
  expect(body).toContain("> Should be Support");
  expect(body).toContain("**Lee**, 2026-10-10T00:00:00.000Z, revision unknown:");
  expect(body).toContain("> Agreed, and the label too");
  // The thread's Critiqs status means nothing in the tracker, which has its own.
  expect(body).not.toContain("- Status:");
});

test("attribution adds who created it from Critiqs and the thread's link; turned off, only the link stays", () => {
  const on = ticketText(thread, { attribution: { name: "Dana" }, link: review, captureNote: "uploaded" }).body;
  expect(on).toContain("Created from Critiqs by Dana: [open the thread](");
  expect(renderedLinks(on).at(-1)).toBe(review);
  const off = ticketText(thread, { attribution: null, link: review, captureNote: "uploaded" }).body;
  expect(off).not.toContain("Created from Critiqs");
  expect(off).toContain("- Link: [open the thread](");
  expect(renderedLinks(off)).toEqual([review]);
});

/** Every link destination in the rendered Markdown, decoded as a browser would read the href. */
function renderedLinks(markdown: string): string[] {
  const html = Bun.markdown.html(markdown);
  const entities: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'" };
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replace(/&(amp|quot|lt|gt|#39);/g, (entity) => entities[entity]!));
}

test("thread links render to exactly the review address, with attribution on or off", () => {
  for (const odd of [
    "https://review.example/route)/details?critiqs=t1",
    "https://review.example/?critiqs=t1#/details)",
    "https://review.example/?a=1&copy;b=2&critiqs=t1",
  ]) {
    const on = ticketText(thread, { attribution: { name: "Dana" }, link: odd, captureNote: "uploaded" }).body;
    expect(renderedLinks(on)).toEqual([odd, odd]);
    const off = ticketText(thread, { attribution: null, link: odd, captureNote: "uploaded" }).body;
    expect(renderedLinks(off)).toEqual([odd]);
  }
});

test("a comment with old Mac line endings stays inside its quote too", () => {
  const fence = { ...thread, messages: [{ ...thread.messages[0]!, body: "Broken:\r```\rnever closed" }, thread.messages[1]!] };
  const { body } = ticketText(fence, { attribution: null, link: review, captureNote: "uploaded" });
  expect(renderedLinks(body)).toEqual([review]);
  expect(Bun.markdown.html(body)).toContain("<h2>Discussion</h2>");
});

test("context from the app stays on its line, so it can't hide the rest of the ticket", () => {
  const odd = { ...thread, viewState: { note: "two\n```\nlines" }, screen: "a\r\n```", persona: "x\n```" };
  const { body } = ticketText(odd, { attribution: { name: "Dana" }, link: review, captureNote: "uploaded" });
  expect(body).toContain("- View state: note=two \\`\\`\\` lines");
  expect(renderedLinks(body)).toEqual([review, review]);
  expect(Bun.markdown.html(body)).toContain("<h2>Discussion</h2>");
});

test("a comment's own Markdown stays inside the summary and its quote", () => {
  const fence = { ...thread, messages: [{ ...thread.messages[0]!, body: "Broken:\n```\nnever closed" }, thread.messages[1]!] };
  const { body } = ticketText(fence, { attribution: { name: "Dana" }, link: review, captureNote: "uploaded" });
  // The context link and the footer link both still render as links.
  expect(renderedLinks(body)).toEqual([review, review]);
  expect(Bun.markdown.html(body)).toContain("<h2>Context</h2>");
});

test("where the tracker can't take images, the text says to open the thread's link for the capture", () => {
  const uploaded = ticketText(thread, { attribution: null, link: review, captureNote: "uploaded" }).body;
  expect(uploaded).toContain("- Capture: attached to this ticket");
  const linked = ticketText(thread, { attribution: null, link: review, captureNote: "link" }).body;
  expect(linked).toContain("- Capture: saved with the thread; open its link to view it");
  // With attribution off, no capture wording names Critiqs, in either mode.
  expect(uploaded.replaceAll(review, "")).not.toMatch(/critiqs/i);
  expect(linked.replaceAll(review, "")).not.toMatch(/critiqs/i);
  const none = ticketText({ ...thread, hasCapture: false }, { attribution: null, link: review, captureNote: "link" }).body;
  expect(none).toContain("- Capture: none");
});

test("a reply a coding agent wrote keeps that mark in the ticket", () => {
  const agent = { ...thread, messages: [...thread.messages, { ...thread.messages[1]!, id: "m3", body: "Fixed in abc124", via: "agent" as const }] };
  expect(ticketText(agent, { attribution: null, link: review, captureNote: "uploaded" }).body).toContain("**Lee** via coding agent,");
});
