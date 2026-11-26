import { expect, test } from "bun:test";
import { exportJson, exportMarkdown, exportThread, type FeedbackCollection } from "../src/export.ts";
import type { ExportedThread } from "../src/protocol.ts";

const collection: FeedbackCollection = {
  title: "Sprint 4 handoff",
  projectName: "Admin prototype",
  exportedAt: Date.UTC(2026, 9, 10),
  threads: [
    {
      id: "t1",
      link: "https://proto.example/?critiqs=t1",
      status: "open",
      tags: ["Bug"],
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
        { id: "m2", link: "https://proto.example/?critiqs=t1&m=m2", author: "Lee", createdAt: Date.UTC(2026, 9, 10), editedAt: Date.UTC(2026, 9, 10), body: "Fixed in next build", revision: null },
      ],
    },
  ],
};

test("Markdown preserves each discussion with its context", () => {
  const markdown = exportMarkdown(collection);
  expect(markdown).toContain("## Department is wrong");
  expect(markdown).toContain("- Target: `user.department`, \"Sales\", record user:alex");
  expect(markdown).toContain("- View state: tab=permissions");
  expect(markdown).toContain("- Page: https://proto.example/users/alex at 1440×900");
  expect(markdown).toContain("- Demo persona: Admin");
  expect(markdown).toContain("- Capture: saved; open the link to view it");
  expect(markdown).toContain("> Should be Support");
  expect(markdown).toContain("**Lee**, 2026-10-10T00:00:00.000Z (edited), revision unknown:");
});

test("JSON carries a schema version and the full collection", () => {
  const parsed = JSON.parse(exportJson(collection));
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.threads[0].messages).toHaveLength(2);
});

test("a reply a coding agent wrote keeps that mark in Markdown and JSON", () => {
  const thread = collection.threads[0]!;
  const agent: FeedbackCollection = {
    ...collection,
    threads: [{ ...thread, messages: [...thread.messages, { ...thread.messages[1]!, id: "m3", body: "Fixed in abc124; please check", revision: "abc124", via: "agent" }] }],
  };
  const markdown = exportMarkdown(agent);
  expect(markdown).toContain("**Lee** via coding agent, 2026-10-10T00:00:00.000Z (edited), revision abc124:");
  // Messages people wrote stay as they were.
  expect(markdown).toContain("**Dana**, 2026-10-09T00:00:00.000Z, revision abc123:");
  const parsed = JSON.parse(exportJson(agent));
  expect(parsed.threads[0].messages.map((message: { via?: string }) => message.via ?? null)).toEqual([null, null, "agent"]);
});

test("an exported thread reads where it is now, with each message's link and mark", () => {
  const target = { purposeId: "user.department", recordKey: "user:alex", clues: { tagName: "span", role: null, label: "Sales", path: "main:1/span:1" } };
  const anchor = {
    screen: "user-details",
    viewState: { tab: "permissions" },
    target,
    scope: "record" as const,
    evidence: { url: "https://proto.example/users/alex", viewport: { width: 1440, height: 900 }, marker: { x: 0, y: 0, width: 1, height: 1 }, capturedAt: 1, revision: "abc", persona: null, userAgent: "UA" },
  };
  const moved = { screen: "user-list", viewState: {}, target: { ...target, clues: { ...target.clues, label: "Team" } }, scope: "shared" as const };
  const exported: ExportedThread = {
    _id: "t1",
    status: "resolved",
    tags: ["Bug"],
    anchor,
    location: moved,
    hasCapture: false,
    messages: [{ _id: "m1", author: "Dana", body: "Wrong", createdAt: 5, editedAt: null, revision: "abc", via: "agent" }],
  };
  const thread = exportThread(exported, (messageId) => `https://review.example/?critiqs=t1${messageId === null ? "" : `.${messageId}`}`);
  expect(thread).toMatchObject({ id: "t1", link: "https://review.example/?critiqs=t1", status: "resolved", screen: "user-list", scope: "shared", reattached: true, pageUrl: anchor.evidence.url });
  expect(thread.target).toEqual({ purposeId: "user.department", recordKey: "user:alex", label: "Team" });
  expect(thread.messages).toEqual([{ id: "m1", link: "https://review.example/?critiqs=t1.m1", author: "Dana", body: "Wrong", createdAt: 5, editedAt: null, revision: "abc", via: "agent" }]);
});

test("a thread's linked tickets go into the Markdown and JSON export, each with its tracker, key, status, title, and address", () => {
  const thread = collection.threads[0]!;
  const withTickets: FeedbackCollection = {
    ...collection,
    threads: [
      {
        ...thread,
        tickets: [
          { tracker: "linear", key: "ENG-1", title: "Department is wrong", status: { label: "In Progress", category: "started" }, url: "https://linear.app/acme/issue/eng-1" },
          { tracker: "github", key: "acme/web#12", title: "Label\nsplit", status: null, url: "https://github.com/acme/web/issues/12" },
        ],
      },
      { ...thread, id: "t2", tickets: [] },
      { ...thread, id: "t3" },
    ],
  };
  const markdown = exportMarkdown(withTickets);
  expect(markdown).toContain('- Ticket: Linear ENG-1 · In Progress, "Department is wrong", https://linear.app/acme/issue/eng-1');
  expect(markdown).toContain('- Ticket: GitHub Issues acme/web#12 · status unknown, "Label split", https://github.com/acme/web/issues/12');
  expect(markdown.match(/- Tickets: none/g)).toHaveLength(1);
  const parsed = JSON.parse(exportJson(withTickets));
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.threads[0].tickets[0]).toEqual({ tracker: "linear", key: "ENG-1", title: "Department is wrong", status: { label: "In Progress", category: "started" }, url: "https://linear.app/acme/issue/eng-1" });
  expect(parsed.threads[1].tickets).toEqual([]);
  expect(parsed.threads[2].tickets).toBeUndefined();
});

test("exportThread keeps the tickets the backend sent, and only their handoff fields", () => {
  const exported = exportThread(
    {
      _id: "t1",
      status: "open",
      tags: [],
      anchor: { screen: "s", viewState: {}, scope: "record", target: { purposeId: null, recordKey: null, clues: { label: null } }, evidence: { url: "https://proto.example/", capturedAt: 1, revision: null, persona: null, viewport: { width: 1, height: 1 }, marker: { x: 0, y: 0, width: 1, height: 1 }, userAgent: "x" } } as never,
      location: null,
      hasCapture: false,
      tickets: [{ tracker: "jira", key: "WEB-3", title: "T", status: { label: "To Do", category: "open" }, url: "https://acme.atlassian.net/browse/WEB-3", extra: "x" } as never],
      messages: [],
    },
    () => "https://proto.example/?critiqs=t1",
  );
  expect(exported.tickets).toEqual([{ tracker: "jira", key: "WEB-3", title: "T", status: { label: "To Do", category: "open" }, url: "https://acme.atlassian.net/browse/WEB-3" }]);
});
