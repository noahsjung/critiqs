import { expect, test } from "bun:test";
import type { ExportThread } from "../src/export.ts";
import { aiTicketText, draftedMarkdown, draftedSections, type SectionAnswer, STANDARD_OUTLINE, TRACKERS, templateTicketText, ticketBody, ticketLinkComment, ticketOutline, ticketText } from "../src/tickets.ts";
import { type WebAddress, webAddress } from "../src/web-address.ts";

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

const review = webAddress("https://review.example/?critiqs=t1")!;

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
  expect(body).toContain("- Screen: user-details");
  expect(body).toContain('- Target: `user.department`, "Sales", record user\\:\u2060alex');
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
function renderedLinks(markdown: string, options: { autolinks?: boolean } = {}): string[] {
  const html = Bun.markdown.html(markdown, options);
  const entities: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'" };
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replace(/&(amp|quot|lt|gt|#39);/g, (entity) => entities[entity]!));
}

test("thread links render to exactly the review address, with attribution on or off", () => {
  for (const odd of [
    "https://review.example/route)/details?critiqs=t1",
    "https://review.example/?critiqs=t1#/details)",
    "https://review.example/?a=1&copy;b=2&critiqs=t1",
  ]) {
    const on = ticketText(thread, { attribution: { name: "Dana" }, link: odd as WebAddress, captureNote: "uploaded" }).body;
    expect(renderedLinks(on)).toEqual([odd, odd]);
    const off = ticketText(thread, { attribution: null, link: odd as WebAddress, captureNote: "uploaded" }).body;
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

test("a created ticket's text is the edited draft, then the uploaded capture, then attribution when chosen", () => {
  const draft = ticketText(thread, { attribution: null, link: review, captureNote: "uploaded" }).body;
  const edited = `${draft}\nAlso check the Support team.\n`;
  const full = ticketBody(edited, { capture: { url: webAddress("https://uploads.linear.app/a/b(1).png")! }, attribution: { name: "Dana" }, link: review });
  expect(full.startsWith(`${edited.trimEnd()}\n\n## Capture\n\n![Capture](`)).toBe(true);
  expect(Bun.markdown.html(full)).toContain('<img src="https://uploads.linear.app/a/b(1).png" alt="Capture"');
  expect(full.trimEnd().endsWith("Created from Critiqs by Dana: [open the thread](<https://review.example/?critiqs=t1>)")).toBe(true);
  // Turned off: no Critiqs text, and the draft's own link to the thread stays.
  const off = ticketBody(edited, { capture: null, attribution: null, link: review });
  expect(off as string).toBe(`${edited.trimEnd()}\n`);
  expect(off).not.toContain("Critiqs");
});

test("a capture the tracker should have taken but couldn't says to open the thread instead", () => {
  const body = ticketBody("Text", { capture: "missing", attribution: null, link: review });
  expect(body).toContain("Critiqs couldn't add the capture to this ticket");
  expect(renderedLinks(body)).toEqual([review]);
});

test("a link comment quotes the thread's first message and links the thread, naming Critiqs only with attribution", () => {
  const on = ticketLinkComment("Department is wrong\n```\nunclosed", { link: review, attribution: { name: "Dana" } });
  expect(on as string).toBe("> Department is wrong\n> \\`\\`\\`\n> unclosed\n\nLinked from Critiqs by Dana: [open the thread](<https://review.example/?critiqs=t1>)\n");
  const off = ticketLinkComment("Department is wrong", { link: review, attribution: null });
  expect(off).not.toContain("Critiqs");
  expect(renderedLinks(off)).toEqual([review]);
});

test("without AI, a template's first section starts with the thread's summary and context, and every section keeps its own text", () => {
  const template = { name: "Bug", body: "Intro for the team\n\n## Summary\n\nWhat went wrong?\n\n## Steps to reproduce\n\n1.\n\n## Expected\n" };
  const { title, body } = templateTicketText(thread, template, { link: review, captureNote: "uploaded" });
  expect(title).toBe("Department is wrong");
  expect(templateTicketText({ ...thread, messages: [{ ...thread.messages[0]!, body: "@octocat #12 is back" }] }, template, { link: review, captureNote: "uploaded" }).title).toBe("@\u2060octocat #\u206012 is back");
  expect(body).toBe(
    [
      "Intro for the team",
      "",
      "## Summary",
      "",
      "> Department is wrong",
      "> Should be Support",
      "",
      "- Link: [open the thread](<https://review.example/?critiqs=t1>)",
      "- Tags: Bug, Wording",
      "- Screen: user-details",
      '- Target: `user.department`, "Sales", record user\\:\u2060alex',
      "- Scope: this record only",
      "- Revision: abc123",
      "- Page: `https://proto.example/users/alex` at 1440×900",
      "- Demo persona: Admin",
      "- View state: tab=permissions",
      "- Capture: attached to this ticket",
      "",
      "What went wrong?",
      "",
      "## Steps to reproduce",
      "",
      "1.",
      "",
      "## Expected",
      "",
    ].join("\n"),
  );
  // Only the summary and context: the rest of the discussion is the person's to add.
  expect(body).not.toContain("Agreed, and the label too");
  expect(renderedLinks(body)).toEqual([review]);
});

test("a template without headings gets the thread's summary and context before its text, and a heading in a code fence isn't a section", () => {
  const plain = templateTicketText(thread, { name: "Plain", body: "Fill in the details.\r\n" }, { link: review, captureNote: "link" }).body;
  expect(plain.startsWith("> Department is wrong\n")).toBe(true);
  expect(plain).toContain("- Capture: saved with the thread; open its link to view it\n\nFill in the details.\n");
  const fenced = templateTicketText(thread, { name: "Fenced", body: "```\n# not a heading\n```\n# Real\n" }, { link: review, captureNote: "uploaded" }).body;
  expect(fenced.startsWith("```\n# not a heading\n```\n# Real\n\n> Department is wrong")).toBe(true);
  expect(templateTicketText(thread, { name: "Empty", body: "  \n" }, { link: review, captureNote: "uploaded" }).body.startsWith("> Department is wrong")).toBe(true);
});

// ---------------------------------------------------------------------------
// Drafts by Critiqs AI: plain text, which Critiqs arranges under the template's headings.

const bugTemplate = "Intro for the team\n\n## Summary\n\nWhat happened?\n\n```\n## not a section\n```\n\n## Steps to reproduce\n\n1.\n\nExpected\n--------\n\n## Actual\n";

/** Renders as a tracker may: bare addresses and emails linked too. */
const html = (markdown: string) => Bun.markdown.html(markdown, { autolinks: true });

function aiDraft(answers: SectionAnswer[], template: string | null = bugTemplate) {
  const outline = ticketOutline(template);
  return aiTicketText(draftedSections(outline, answers), outline, review);
}

const answer = (heading: string, text: string, items: string[] = [], numbered = false): SectionAnswer => ({ heading, text, items, numbered });

test("a template's sections are its top-level headings, in order, written either way, and not those in code, quotes, or lists", () => {
  expect(ticketOutline(bugTemplate)).toEqual({
    sections: [
      { name: "Summary", heading: "## Summary" },
      { name: "Steps to reproduce", heading: "## Steps to reproduce" },
      { name: "Expected", heading: "## Expected" },
      { name: "Actual", heading: "## Actual" },
    ],
    keepEmpty: true,
  });
  const nested = "> ## Quoted\n\n- ## Listed\n\n<div>\n## In HTML\n</div>\n\n    ## Indented code\n\n### Notes ###\n\nTwo\nlines\n===\n";
  expect(ticketOutline(nested).sections).toEqual([
    { name: "Notes", heading: "### Notes" },
    { name: "Two lines", heading: "# Two lines" },
  ]);
  // No template, or one without headings: Critiqs's standard sections, which a draft leaves out when empty.
  expect(ticketOutline(null)).toBe(STANDARD_OUTLINE);
  expect(ticketOutline("Fill in the details.")).toBe(STANDARD_OUTLINE);
});

test("Critiqs writes the template's headings, in its order, each once; the AI's text goes under the heading it names, and the thread's link at the end", () => {
  const body = aiDraft([
    answer("Actual", "It reads Sales."),
    answer("Impact", "A section the template doesn't have."),
    answer("Summary", "The department is wrong.\n\nReviewers agree it should be Support."),
    answer("Steps to reproduce", "", ["Open Alex's details", "Look at Department"], true),
    answer("Steps to reproduce", "", ["Compare with the directory"], false),
  ]);
  expect(body).toBe(
    [
      "## Summary",
      "",
      "The department is wrong.",
      "",
      "Reviewers agree it should be Support.",
      "",
      "## Steps to reproduce",
      "",
      "1. Open Alex's details",
      "2. Look at Department",
      "3. Compare with the directory",
      "",
      "## Expected",
      "",
      "## Actual",
      "",
      "It reads Sales.",
      "",
      "Thread: [open the thread](<https://review.example/?critiqs=t1>)",
      "",
    ].join("\n"),
  );
  // Without a template: the standard sections the AI filled, in their order.
  expect(aiDraft([answer("Expected", "Support"), answer("Summary", "Wrong team")], null)).toBe(
    "## Summary\n\nWrong team\n\n## Expected\n\nSupport\n\nThread: [open the thread](<https://review.example/?critiqs=t1>)\n",
  );
});

/** How Critiqs AI's text has tried to render as Markdown, each in its own draft. */
const ATTEMPTS: Record<string, string> = {
  "a line holding only a nonbreaking space between backticks": "x `y\n \nz` [span](https://evil.example/span) ![i](https://evil.example/i.png) <b>raw</b> `w`",
  "a percent-encoded thread address": "[open the thread](https://review.example/?critiqs%3Dt1) https://review.example/?critiqs%3Dt9 <https://review.example/?critiqs%3Dt9>",
  "an uppercase thread address": "HTTPS://REVIEW.EXAMPLE/?CRITIQS=UPPER and www.review.example/?CRITIQS=www",
  "reference links": "[open the thread][1] and [1]\n\n[1]: https://evil.example/ref",
  images: "![pixel](https://evil.example/pixel.png) ![ref][p]\n\n[p]: https://evil.example/p.png",
  "raw <a> and <img>": '<a href="https://evil.example/html">the thread</a> <img src="https://evil.example/img.png">',
  "code fences": "```\n[in code](https://evil.example/code)\n```\n\n~~~js\nx\n~~~",
  "a fence whose info string has U+2028": "```js `\n[after](https://evil.example/2028)",
  "setext headings": "Fake heading\n===\n\nAnother\n---",
  "--- lines": "---\n\n***\n\n___",
  "HTML entities": "&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt; &#60;img src=x&#62; &amp;",
  "autolinks and emails": "<https://evil.example/auto> www.evil.example ops@evil.example mailto:ops@evil.example",
  "headings, quotes, lists, tables, and indented code": "# Heading\n> quote\n1. step\n- item\n| a | b |\n|---|---|\n| [c](https://evil.example/table) | d |\n\n    indented code",
};

for (const [name, text] of Object.entries(ATTEMPTS)) {
  test(`nothing Critiqs AI writes renders as Markdown, with ${name}: the only link is the thread's, and no image, HTML, code, or heading of its own`, () => {
    // In a section's text, in its list, and under a heading the template doesn't have.
    const body = aiDraft([answer("Summary", text, text.split("\n")), answer("Actual", text), answer(text, text)]);
    const rendered = html(body);
    expect([...rendered.matchAll(/<([a-z][a-z0-9]*)/g)].map((match) => match[1]).filter((tag) => !["h2", "p", "ul", "li", "a"].includes(tag!))).toEqual([]);
    expect(renderedLinks(body, { autolinks: true })).toEqual([review]);
    expect([...rendered.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1])).toEqual(["Summary", "Steps to reproduce", "Expected", "Actual"]);
  });
}

test("Critiqs AI's text renders exactly as written, whatever characters it has", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pieces = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~abcW09   \t", "\n", "\n\n", "www.", "https://e.example/", "a@b.example", "&amp;", "&#60;", "<a href=x>", "```", "1. ", "- ", "# ", "> ", "    ", "---"];
  const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  for (let count = 0; count < 2_000; count++) {
    let text = "";
    for (let length = 1 + Math.floor(random() * 12); length > 0; length--) text += pieces[Math.floor(random() * pieces.length)];
    const [section] = draftedSections(ticketOutline("## A\n"), [answer("A", text, [text])]);
    const paragraphs = section!.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>\n`).join("");
    const list = section!.items.length === 0 ? "" : `<ul>\n${section!.items.map((item) => `<li>${escapeHtml(item)}</li>\n`).join("")}</ul>\n`;
    // Word joiners after the signs GitHub resolves show nothing, so they don't count.
    expect(html(aiTicketText([section!], { keepEmpty: true }, review)).replace(/\u2060/g, "")).toBe(`<h2>A</h2>\n${paragraphs}${list}<p>Thread: <a href="${review}">open the thread</a></p>\n`);
  }
});

// ---------------------------------------------------------------------------
// The person's text, as they send it.

const capture = { url: webAddress("https://uploads.example/c.png")! };
const footer = `\n## Capture\n\n![Capture](<${capture.url}>)\n\n---\n\nCreated from Critiqs by Dana: [open the thread](<${review}>)\n`;
/** Rendered outside code: the HTML with every code block taken out. */
const outsideCode = (markdown: string) => html(markdown).replace(/<pre>[\s\S]*?<\/pre>/g, "");

test("a person's Markdown is sent exactly as they wrote it: a fenced command in a numbered step and an indented code block stay where they are", () => {
  const unchanged = [
    "1. Open a terminal and run:\n\n   ```sh\n   make test\n   ```\n\n2. ```\n   npm start\n   ```\n\nThe check:\n\n    def check():\n        return True\n",
    // A fence open inside a list item or quote ends with it, before Critiqs's text.
    "- ```\n  never closed in the item",
    "> ~~~\r\n> never closed in the quote",
    // U+2028 isn't a line ending: this backtick run isn't at the start of a line.
    "Inline ```\nstill text",
  ];
  for (const draft of unchanged) {
    const full = ticketBody(draft, { capture, attribution: { name: "Dana" }, link: review });
    expect(full as string).toBe(`${draft}${/\n$/.test(draft) ? "" : "\n"}${footer}`);
    expect(outsideCode(full)).toContain(`<a href="${review}">open the thread</a>`);
  }
  const [step] = unchanged;
  const rendered = html(ticketBody(step!, { capture, attribution: { name: "Dana" }, link: review }));
  expect(rendered).toContain('<li>\n<p>Open a terminal and run:</p>\n<pre><code class="language-sh">make test\n</code></pre>\n</li>');
  expect(rendered).toContain("<pre><code>def check():\n    return True\n</code></pre>");
});

test("a draft left inside a code fence gets a closing fence of its kind, and Critiqs's capture, attribution, and link render after it", () => {
  const open = {
    "```\nnever closed": "```",
    // Neither a shorter fence nor one of the other kind closes it.
    "````text\n~~~\n```\n## Not a heading": "````",
    "  ~~~~\r\ncode\r\n": "~~~~",
    "```js x\rcode": "```",
    // A backtick in a backtick fence's info string makes it text, but U+2028 doesn't end the info string.
    "```js \ncode": "```",
  };
  for (const [draft, fence] of Object.entries(open)) {
    const full = ticketBody(draft, { capture, attribution: { name: "Dana" }, link: review });
    expect(full as string).toBe(`${draft}${/[\r\n]$/.test(draft) ? "" : "\n"}${fence}\n${footer}`);
    expect(outsideCode(full)).toContain("<h2>Capture</h2>");
    expect(outsideCode(full)).toContain(`<img src="${capture.url}"`);
    expect(outsideCode(full)).toContain(`Created from Critiqs by Dana: <a href="${review}">open the thread</a>`);
    expect(outsideCode(full)).not.toContain("Not a heading");
  }
});

test("a template section that is only a task list (a GitHub form's checkboxes or dropdown) is choices the person ticks: Critiqs AI never writes under it, and its draft keeps them", () => {
  const outline = ticketOutline("### What happened?\n\n### Which browsers?\n\n- [ ] Firefox\n- [ ] Chrome\n\n### Code of Conduct\n\n- [ ] I agree to the <b>Code</b>\n");
  expect(outline.sections.map((section): [string, string[] | null] => [section.name, section.choices ?? null])).toEqual([
    ["What happened?", null],
    ["Which browsers?", ["Firefox", "Chrome"]],
    ["Code of Conduct", ["I agree to the <b>Code</b>"]],
  ]);
  const sections = draftedSections(outline, [
    { heading: "What happened?", text: "The button is grey.", items: [], numbered: false },
    { heading: "Code of Conduct", text: "Notes for Code of Conduct from the thread.", items: [], numbered: false },
  ]);
  expect(draftedMarkdown(sections, outline)).toBe(
    "### What happened?\n\nThe button is grey.\n\n### Which browsers?\n\n- [ ] Firefox\n- [ ] Chrome\n\n### Code of Conduct\n\n- [ ] I agree to the \\<b>Code\\</b>",
  );
});
