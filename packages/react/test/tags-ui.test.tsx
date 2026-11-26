import { afterEach, expect, test } from "bun:test";
import type { AiSettingsView, ProjectTags, SearchResponse } from "@critiqs/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TransportContext } from "../src/transport.ts";
import { activeHashtag, hashtagFor, MentionInput, type MentionText, MessageBody, tagDisplay } from "../src/ui/MentionInput.tsx";
import { SearchResults } from "../src/ui/Search.tsx";
import { TagsAiDialog } from "../src/ui/TagsAiDialog.tsx";
import { FilterButton } from "../src/ui/ThreadList.tsx";
import { readText, selectIn, selectionIn, showText } from "../src/ui/tag-text.ts";
import { commentField, fieldText, placeCaret, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactNode, backend: FakeBackend) {
  container ??= document.createElement("div");
  // Moving a focused element out of the page and back would blur it.
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(backend)}>{node}</TransportContext.Provider>));
  return container;
}

const tags: ProjectTags = {
  tags: [
    { key: "wording", label: "wording", preset: false, lastUsedAt: 3, groupIds: ["copy"], grouping: "starter" },
    { key: "ux-copy-change", label: "UX copy change", preset: true, lastUsedAt: 2, groupIds: ["copy"], grouping: "starter" },
    { key: "layout", label: "layout", preset: false, lastUsedAt: 1, groupIds: [], grouping: "pending" },
    { key: "bug", label: "Bug", preset: true, lastUsedAt: null, groupIds: [], grouping: "none" },
  ],
  groups: [{ _id: "copy", name: "Copy & wording", origin: "starter" }],
  canOrganize: true,
};

test("the tag being typed is the # word just before the caret, not a URL fragment or C#", () => {
  expect(activeHashtag("Fix #wo", 7)).toEqual({ start: 4, query: "wo" });
  expect(activeHashtag("#", 1)).toEqual({ start: 0, query: "" });
  expect(activeHashtag("(#lay", 5)).toEqual({ start: 1, query: "lay" });
  expect(activeHashtag("https://x.example/#top", 22)).toBeNull();
  expect(activeHashtag("C#", 2)).toBeNull();
  expect(activeHashtag("#12", 3)).toBeNull();
  expect(activeHashtag("#wording done", 13)).toBeNull();
  expect(hashtagFor("UX copy change")).toBe("UX-copy-change");
  expect([tagDisplay("wording"), tagDisplay("UX copy change"), tagDisplay("#Bug")]).toEqual(["#wording", "#UX-copy-change", "#Bug"]);
});

test("typing # suggests the project's tags, most recent first; choosing one writes it; the draft shows tags as pills inside the input", async () => {
  let value: MentionText = { text: "", mentions: [] };
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = () => render(<MentionInput projectId="project" aria-label="Comment" value={value} onChange={(next) => ((value = next), void draw())} />, backend);
  const host = await draw();
  const field = commentField(host)!;
  const typeText = (text: string) => typeInto(field, text);
  const options = () => Array.from(host.querySelectorAll('[role="option"] .tag-chip')).map((option) => option.textContent);
  const pills = () => Array.from(field.querySelectorAll(".tag-pill")).map((pill) => pill.textContent);

  await typeText("Label is unclear #");
  expect(options()).toEqual(["#wording", "#UX-copy-change", "#layout", "#Bug"]);
  expect(host.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Tags");
  await typeText("Label is unclear #u");
  expect(options()).toEqual(["#UX-copy-change"]);
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(value.text).toBe("Label is unclear #UX-copy-change ");
  expect(options()).toEqual([]);
  expect(pills()).toEqual(["#UX-copy-change"]);
  expect(host.querySelector(".tag-preview")).toBeNull();
  expect(fieldText(field)).toBe(value.text);
  // The caret follows the chosen tag, outside its pill.
  expect(selectionIn(field)).toEqual([value.text.length, value.text.length]);
  await typeText("Fix #wording, #wording and (#文案). C# https://x/#fragment");
  expect(pills()).toEqual(["#wording", "#wording", "#文案"]);
  // The pills hold the text as typed: nothing is added to pad them.
  expect(field.textContent).toBe(value.text);
  await typeText("Fix wording");
  expect(field.querySelector(".tag-pill")).toBeNull();
});

test("the comment box keeps plain text: pills follow typing, and the caret stays put when they are redrawn", async () => {
  let value: MentionText = { text: "", mentions: [] };
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = () => render(<MentionInput projectId="project" aria-label="Comment" placeholder="Add a comment" value={value} onChange={(next) => ((value = next), void draw())} />, backend);
  const host = await draw();
  const field = commentField(host)!;
  expect(field.getAttribute("contenteditable")).toBe("plaintext-only");
  expect(host.querySelector(".tag-placeholder")!.textContent).toBe("Add a comment");
  expect(field.getAttribute("aria-placeholder")).toBe("Add a comment");

  // Typing inside a word before the tag: the caret stays where it was typed.
  await typeInto(field, "Tighten #spacing here", 7);
  expect(host.querySelector(".tag-placeholder")).toBeNull();
  expect(Array.from(field.childNodes).map((node) => [node.nodeName, node.textContent])).toEqual([
    ["#text", "Tighten "],
    ["SPAN", "#spacing"],
    ["#text", " here"],
  ]);
  expect(selectionIn(field)).toEqual([7, 7]);

  // A browser may type a space into the end of a pill; the pill is redrawn around the tag alone.
  const pill = field.querySelector(".tag-pill")!;
  await act(async () => {
    pill.firstChild!.textContent = "#spacing ";
    document.getSelection()!.setBaseAndExtent(pill.firstChild!, 9, pill.firstChild!, 9);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " " }));
  });
  expect(value.text).toBe("Tighten #spacing  here");
  expect(field.querySelector(".tag-pill")!.textContent).toBe("#spacing");
  expect(selectionIn(field)).toEqual([17, 17]);

  // A line break a browser adds, or a trailing one, reads back as plain text.
  await act(async () => {
    field.append(document.createElement("br"), "next");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  expect(value.text).toBe("Tighten #spacing  here\nnext");
  expect(readText(field)).toBe(value.text);
  await draw();
  expect(Array.from(field.childNodes).some((node) => node.nodeName === "BR")).toBe(false);
});

test("Enter and paste insert plain text; undo and redo restore the text and caret", async () => {
  let value: MentionText = { text: "", mentions: [] };
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = () => render(<MentionInput projectId="project" aria-label="Comment" value={value} onChange={(next) => ((value = next), void draw())} />, backend);
  const host = await draw();
  const field = commentField(host)!;
  const key = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => void field.dispatchEvent(event));
    return event.defaultPrevented;
  };

  await typeInto(field, "Button #spacing");
  // A line break is a newline in the text, with a line held open after it.
  const enter = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" });
  await act(async () => void field.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  expect(value.text).toBe("Button #spacing\n");
  expect(field.lastChild!.nodeName).toBe("BR");
  expect(selectionIn(field)).toEqual([16, 16]);

  // Pasted rich text arrives as its plain text, and its hashtags become pills.
  const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  paste.clipboardData = { getData: (type: string) => (type === "text/plain" ? "too tight\r\nsee #layout" : "<b>too tight</b>") };
  await act(async () => void field.dispatchEvent(paste));
  expect(paste.defaultPrevented).toBe(true);
  expect(value.text).toBe("Button #spacing\ntoo tight\nsee #layout");
  expect(Array.from(field.querySelectorAll(".tag-pill")).map((pill) => pill.textContent)).toEqual(["#spacing", "#layout"]);
  expect(selectionIn(field)).toEqual([value.text.length, value.text.length]);

  // Each step undoes in turn, putting the caret back where the change was made.
  expect(await key({ key: "z", ctrlKey: true })).toBe(true);
  expect(value.text).toBe("Button #spacing\n");
  expect(selectionIn(field)).toEqual([16, 16]);
  expect(await key({ key: "z", metaKey: true })).toBe(true);
  expect(value.text).toBe("Button #spacing");
  expect(field.querySelector(".tag-pill")!.textContent).toBe("#spacing");
  expect(await key({ key: "Z", metaKey: true, shiftKey: true })).toBe(true);
  expect(value.text).toBe("Button #spacing\n");
  const redo = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "historyRedo" });
  await act(async () => void field.dispatchEvent(redo));
  expect(redo.defaultPrevented).toBe(true);
  expect(value.text).toBe("Button #spacing\ntoo tight\nsee #layout");
  expect(await key({ key: "y", ctrlKey: true })).toBe(true);
  expect(value.text).toBe("Button #spacing\ntoo tight\nsee #layout");

  // Ctrl or Cmd with Enter goes to the form around the box and adds no line.
  expect(await key({ key: "Enter", ctrlKey: true })).toBe(true);
  expect(value.text).toBe("Button #spacing\ntoo tight\nsee #layout");
});

test("consecutive typing undoes as one step; a draft set from outside starts undo over", async () => {
  let value: MentionText = { text: "Keep #wording", mentions: [] };
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = () => render(<MentionInput projectId="project" aria-label="Edit message" autoFocus value={value} onChange={(next) => ((value = next), void draw())} />, backend);
  const host = await draw();
  const field = commentField(host)!;
  // An edited message opens with its pills and the caret at its end.
  expect(Array.from(field.querySelectorAll(".tag-pill")).map((pill) => pill.textContent)).toEqual(["#wording"]);
  expect(selectionIn(field)).toEqual([13, 13]);
  await typeInto(field, "Keep #wording t");
  await typeInto(field, "Keep #wording to");
  await typeInto(field, "Keep #wording too");
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(value.text).toBe("Keep #wording");
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(value.text).toBe("Keep #wording");

  value = { text: "Sent", mentions: [] };
  await draw();
  expect(fieldText(field)).toBe("Sent");
  value = { text: "", mentions: [] };
  await draw();
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(value.text).toBe("");
  expect(field.childNodes).toHaveLength(0);
});

test("text composed with an input method gets its pills once it is committed", async () => {
  let value: MentionText = { text: "", mentions: [] };
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = () => render(<MentionInput projectId="project" aria-label="Comment" value={value} onChange={(next) => ((value = next), void draw())} />, backend);
  const host = await draw();
  const field = commentField(host)!;
  await act(async () => {
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.textContent = "#文案";
    placeCaret(field, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
  });
  expect(value.text).toBe("#文案");
  // The composing text node is left alone.
  expect(field.querySelector(".tag-pill")).toBeNull();
  await act(async () => void field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(field.querySelector(".tag-pill")!.textContent).toBe("#文案");
  expect(selectionIn(field)).toEqual([3, 3]);
});

test("a draft counts distinct hashtags and warns when the message limit is exceeded", async () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => `#w${i}`).join(" ");
  const backend: FakeBackend = { project: undefined, threads: undefined, tags };
  const draw = (text: string) => render(<MentionInput projectId="project" aria-label="Comment" value={{ text, mentions: [] }} onChange={() => undefined} />, backend);
  let host = await draw(`${many(30)} #W0`);
  expect(host.querySelectorAll(".tag-pill")).toHaveLength(31);
  expect(host.querySelector(".tag-limit")).toBeNull();
  host = await draw(many(31));
  expect(host.querySelector(".tag-limit")!.textContent).toBe("A message can use up to 30 different hashtags; this one uses 31. Remove some to post it.");
  expect(fieldText(commentField(host)!)).toBe(many(31));
});

test("posted text shows mentions and hashtags differently, and a hashtag filters by its tag", async () => {
  const chosen: string[] = [];
  const host = await render(
    <MessageBody body="Ask @Lee about #wording, not https://x.example/#top or C#." mentions={[{ _id: "u", name: "Lee", label: "Lee" }]} onTag={(tag) => chosen.push(tag)} />,
    { project: undefined, threads: undefined },
  );
  expect(host.querySelector(".mention")!.textContent).toBe("@Lee");
  const hashtags = host.querySelectorAll<HTMLButtonElement>("button.hashtag");
  expect(Array.from(hashtags).map((tag) => tag.textContent)).toEqual(["#wording"]);
  await act(async () => hashtags[0]!.click());
  expect(chosen).toEqual(["wording"]);
  expect(host.textContent).toBe("Ask @Lee about #wording, not https://x.example/#top or C#.");
});

test("the filter menu offers groups, showing the tags each includes, and every tag", async () => {
  let filters = { status: "open" as const, unreadOnly: false, tags: [] as string[], groups: [] as string[], screens: "current" as const };
  const draw = () =>
    render(
      <FilterButton
        filters={filters}
        tags={tags.tags.map((tag) => tag.label)}
        groups={[{ _id: "copy", name: "Copy & wording", members: ["wording", "UX copy change"] }]}
        onFilters={(next) => ((filters = next as typeof filters), void draw())}
      />,
      { project: undefined, threads: undefined },
    );
  const host = await draw();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click());
  const items = () => Array.from(host.querySelectorAll('[role="menuitemcheckbox"]')).map((item) => item.textContent);
  expect(items()).toContain("Copy & wording wording, UX copy change");
  expect(items()).toContain("layout");
  const group = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')).find((item) => item.textContent?.startsWith("Copy"))!;
  await act(async () => group.click());
  expect(filters.groups).toEqual(["copy"]);
});

const response: SearchResponse = {
  mode: "ai",
  notice: null,
  query: { terms: ["label"], tags: [], groupIds: ["copy"], status: "open", screen: null, since: null, until: null },
  results: [
    { threadId: "t1", status: "open", screen: "users", tags: ["wording"], lastMessageAt: 1, messageCount: 2, preview: { body: "Department label is unclear", authorName: "Dana" }, matches: [{ messageId: "m2", excerpt: "the label again" }] },
    { threadId: "t2", status: "resolved", screen: "users", tags: [], lastMessageAt: 1, messageCount: 1, preview: { body: "Button text", authorName: "Lee" }, matches: [] },
  ],
  truncated: true,
  insights: [{ title: "Labels are unclear", detail: "Two threads ask for clearer labels.", threadIds: ["t1", "t2"] }],
  insightNotice: null,
};

test("search results show what was searched, insights with their sources, and open each thread", async () => {
  const opened: [string, string | null][] = [];
  const host = await render(
    <SearchResults state={{ status: "done", question: "labels?", response }} tags={tags} onOpen={(id, message) => opened.push([id, message])} onTag={() => undefined} />,
    { project: undefined, threads: undefined },
  );
  expect(host.querySelector(".badge")!.textContent).toBe("AI search");
  expect(host.textContent).toContain("more matched");
  expect(host.querySelector(".search-filters")!.textContent).toContain("group Copy & wording");
  const sources = host.querySelectorAll<HTMLButtonElement>(".insight .source");
  expect(Array.from(sources).map((source) => source.textContent)).toEqual(["Dana: Department label is unclear", "Lee: Button text"]);
  await act(async () => sources[1]!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".entry")!.click());
  expect(opened).toEqual([
    ["t2", null],
    ["t1", "m2"],
  ]);
});

test("basic search says AI wasn't used, and why", async () => {
  const host = await render(
    <SearchResults
      state={{ status: "done", question: "labels", response: { ...response, mode: "basic", notice: "AI unavailable: basic search. AI is turned off for this project.", insights: [], truncated: false } }}
      tags={tags}
      onOpen={() => undefined}
      onTag={() => undefined}
    />,
    { project: undefined, threads: undefined },
  );
  expect(host.querySelector(".badge")!.textContent).toBe("Basic search");
  expect(host.querySelector(".search-notice")!.textContent).toBe("AI unavailable: basic search. AI is turned off for this project.");
  expect(host.querySelector(".insights")).toBeNull();
});

test("result tags read as hashtags and filter by the tag as stored", async () => {
  const chosen: string[] = [];
  const result = { ...response.results[0]!, tags: ["wording", "UX copy change"] };
  const host = await render(
    <SearchResults state={{ status: "done", question: "labels?", response: { ...response, results: [result], insights: [] } }} tags={tags} onOpen={() => undefined} onTag={(tag) => chosen.push(tag)} />,
    { project: undefined, threads: undefined },
  );
  const chips = Array.from(host.querySelectorAll<HTMLElement>(".entry .tag-chip"));
  expect(chips.map((chip) => chip.textContent)).toEqual(["#wording", "#UX-copy-change"]);
  await act(async () => chips[1]!.click());
  expect(chosen).toEqual(["UX copy change"]);
});

const settings: AiSettingsView = {
  enabled: true,
  mode: "own",
  provider: "openai",
  model: "gpt-test",
  baseUrl: null,
  keyHint: "1234",
  deployment: { managed: false, defaultProvider: null, keysStorable: true, allowedEndpoints: ["https://llm.example.com/v1"] },
  status: { ready: true },
  lastTest: null,
};

/** Waits for clicks and saves to settle. */
async function settled() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const navRow = (host: ParentNode, label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button.ds-nav-row")).find((row) => row.querySelector(".label")?.textContent === label)!;
const buttonIn = (host: ParentNode, label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label)!;

test("the owner's AI settings send a new key once and show only its hint", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const backend: FakeBackend = {
    project: undefined,
    threads: undefined,
    tags,
    aiSettings: settings,
    calls,
    saveAiSettings: async () => ({ ...settings, keyHint: "9876" }),
  };
  const host = await render(<TagsAiDialog projectId="project" initialTab="ai" onClose={() => undefined} notify={() => undefined} />, backend);
  await settled();
  expect(navRow(host, "OpenAI key").textContent).toBe("OpenAI key····1234");
  // The saved key opens at its own step, its hint in place of the key.
  await act(async () => navRow(host, "OpenAI key").click());
  await settled();
  const key = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(key.value).toBe("");
  expect(key.placeholder).toBe("Saved key ending in 1234");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "sk-new-9876");
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => buttonIn(host, "Save key").click());
  await settled();
  expect(calls.filter((call) => call.name === "saveAiSettings").map((call) => call.args)).toEqual([
    { projectId: "project", enabled: true, mode: "own", provider: "openai", model: "gpt-test", baseUrl: null, apiKey: "sk-new-9876" },
  ]);
  // Back on the settings, only the new hint remains.
  expect(navRow(host, "OpenAI key").textContent).toBe("OpenAI key····9876");
  expect(host.textContent).not.toContain("sk-new-9876");
});

test("without the operator's encryption key, keys can't be entered and the owner is told why", async () => {
  const host = await render(<TagsAiDialog projectId="project" initialTab="ai" onClose={() => undefined} notify={() => undefined} />, {
    project: undefined,
    threads: undefined,
    aiSettings: { ...settings, keyHint: null, deployment: { ...settings.deployment, keysStorable: false }, status: { ready: false, reason: "Add the provider's API key in AI settings." } },
  });
  await settled();
  expect(host.querySelector('.warning[role="status"]')!.textContent).toContain("Add the provider's API key");
  // Critiqs-managed AI isn't offered where the deployment lacks it: no way to switch to it.
  expect(Array.from(host.querySelectorAll("button.ds-nav-row")).map((row) => row.querySelector(".label")!.textContent)).toEqual(["OpenAI key"]);
  await act(async () => navRow(host, "OpenAI key").click());
  await settled();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(true);
  expect(host.textContent).toContain("CRITIQS_AI_ENCRYPTION_KEY");
});

test("the owner organizes groups: a person's choice for a tag is sent as final, or handed back to automatic grouping", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const host = await render(<TagsAiDialog projectId="project" initialTab="groups" onClose={() => undefined} notify={() => undefined} />, {
    project: undefined,
    threads: undefined,
    tags,
    calls,
  });
  // Group names stay as named; their tags read as the hashtags that write them.
  expect(host.querySelector(".group-list strong")!.textContent).toBe("Copy & wording · starter");
  expect(Array.from(host.querySelectorAll(".group-list .tag-chip")).map((chip) => chip.textContent)).toEqual(["#wording", "#UX-copy-change"]);
  const groupsFor = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Groups for ${label}"]`)!;
  await act(async () => groupsFor("layout").click());
  const item = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".menu button")).find((entry) => entry.textContent?.includes(text))!;
  await act(async () => item("Copy & wording").click());
  expect(calls.at(-1)).toEqual({ name: "setTagGroups", args: { projectId: "project", tag: "layout", groupIds: ["copy"], automatic: undefined } });
  await act(async () => item("Let automatic grouping decide").click());
  expect(calls.at(-1)).toEqual({ name: "setTagGroups", args: { projectId: "project", tag: "layout", groupIds: [], automatic: true } });
});


test("the owner adds, renames, moves, and removes preset tags; each change sends the list it changed", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const notes: string[] = [];
  const backend: FakeBackend = {
    project: { _id: "project", name: "Pilot", tags: ["Bug", "UX copy change", "User feedback"], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: undefined,
    tags,
    calls,
  };
  // The fake isn't live: drawing again reads the saved presets, as a live query would.
  const draw = () => render(<TagsAiDialog projectId="project" initialTab="groups" onClose={() => undefined} notify={(note) => notes.push(note)} presetTags />, backend);
  let host = await draw();
  const presets = () => Array.from(host.querySelectorAll(".preset-list .tag-chip")).map((chip) => chip.textContent);
  const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = async (field: HTMLInputElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const menuItem = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".menu button")).find((entry) => entry.textContent === text);
  const change = async (label: string, item: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="Change preset ${label}"]`)!.click());
    await act(async () => menuItem(item)!.click());
    await settled();
    host = await draw();
  };
  expect(presets()).toEqual(["#Bug", "#UX-copy-change", "#User-feedback"]);
  expect(host.textContent).toContain("leaves the threads that already have it as they are");

  // Refused here first, with the backend's rules: a tag that can't be a hashtag, or one already there.
  await type(input("New preset tag"), "Design/UX");
  expect(host.textContent).toContain("starting with a letter");
  expect(buttonIn(host, "Add preset").disabled).toBe(true);
  await type(input("New preset tag"), "bug");
  expect(host.textContent).toContain("“Bug” is already a preset.");
  await type(input("New preset tag"), "Accessibility");
  await act(async () => buttonIn(host, "Add preset").click());
  await settled();
  expect(calls.at(-1)).toEqual({ name: "setPresetTags", args: { projectId: "project", tags: ["Bug", "UX copy change", "User feedback", "Accessibility"], previous: ["Bug", "UX copy change", "User feedback"] } });
  expect(notes.at(-1)).toBe("Preset “Accessibility” added");
  host = await draw();
  expect(input("New preset tag").value).toBe("");
  expect(presets()).toEqual(["#Bug", "#UX-copy-change", "#User-feedback", "#Accessibility"]);

  // The first can't move up, the last can't move down.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Change preset Bug"]')!.click());
  expect(menuItem("Move up")).toBeUndefined();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Change preset Bug"]')!.click());
  await change("User feedback", "Move up");
  expect(presets()).toEqual(["#Bug", "#User-feedback", "#UX-copy-change", "#Accessibility"]);

  await change("Bug", "Rename");
  await type(input("New name for Bug"), "Defect");
  await act(async () => buttonIn(host, "Save").click());
  await settled();
  expect(calls.at(-1)).toEqual({ name: "setPresetTags", args: { projectId: "project", tags: ["Defect", "User feedback", "UX copy change", "Accessibility"], previous: ["Bug", "User feedback", "UX copy change", "Accessibility"] } });
  host = await draw();

  await change("UX copy change", "Remove preset");
  expect(presets()).toEqual(["#Defect", "#User-feedback", "#Accessibility"]);
  expect(notes.at(-1)).toBe("Preset “UX copy change” removed; threads keep it");

  // The backend's refusal, such as a change someone made meanwhile, is shown and nothing changes here.
  backend.presetError = "The preset tags changed while you were editing them. Look at them again and redo your change.";
  await change("Accessibility", "Move up");
  expect(notes.at(-1)).toContain("changed while you were editing");
  expect(presets()).toEqual(["#Defect", "#User-feedback", "#Accessibility"]);
});

test("preset tags are offered only where the backend reports it can change them", async () => {
  const backend: FakeBackend = {
    project: { _id: "project", name: "Pilot", tags: ["Bug"], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: undefined,
    tags,
  };
  let host = await render(<TagsAiDialog projectId="project" initialTab="groups" onClose={() => undefined} notify={() => undefined} />, backend);
  expect(host.querySelector('[aria-label="Preset tags"]')).toBeNull();
  expect(host.querySelector(".group-list")).not.toBeNull();
  host = await render(<TagsAiDialog projectId="project" initialTab="groups" onClose={() => undefined} notify={() => undefined} presetTags />, backend);
  expect(host.querySelector('[aria-label="Preset tags"]')).not.toBeNull();
});

test("restoring a caret outside a wrapped pill reveals its text edge without moving inside it", () => {
  const editor = document.createElement("div");
  document.body.append(editor);
  showText(editor, "#wording");
  Object.defineProperty(editor, "clientHeight", { value: 40 });
  editor.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
  const createRange = document.createRange;
  document.createRange = () => {
    const range = createRange.call(document);
    // As in Chrome, an element-boundary caret has no rectangle. The text's
    // endpoints are on different lines of the wrapped pill.
    range.getBoundingClientRect = () => range.startContainer.nodeType === Node.TEXT_NODE
      ? new DOMRect(0, (range.startOffset === 0 ? 0 : 80) - editor.scrollTop, 0, 20)
      : new DOMRect();
    return range;
  };
  try {
    selectIn(editor, [8, 8]);
    expect(editor.scrollTop).toBe(60);
    expect(document.getSelection()!.focusNode === editor).toBe(true);
    expect(selectionIn(editor)).toEqual([8, 8]);
    editor.scrollTop = 80;
    selectIn(editor, [0, 0]);
    expect(editor.scrollTop).toBe(0);
    expect(document.getSelection()!.focusNode === editor).toBe(true);
    expect(selectionIn(editor)).toEqual([0, 0]);
  } finally {
    document.createRange = createRange;
    editor.remove();
  }
});

test("rename, move, and remove act on the preset chosen, even when the list changed while the form or menu was open", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const backend: FakeBackend = {
    project: { _id: "project", name: "Pilot", tags: ["Bug", "Design change request", "Defect"], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: undefined,
    tags,
    calls,
  };
  const draw = () => render(<TagsAiDialog projectId="project" initialTab="groups" onClose={() => undefined} notify={() => undefined} presetTags />, backend);
  let host = await draw();
  const menuItem = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".menu button")).find((entry) => entry.textContent === text);
  const open = async (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="Change preset ${label}"]`)!.click());
  // Another session of the owner changes the list; this one redraws live.
  const elsewhere = async (next: string[]) => {
    backend.project = { ...backend.project!, tags: next };
    host = await draw();
  };

  // Rename is chosen on "Design change request", then "Defect" moves above it.
  await open("Design change request");
  await act(async () => menuItem("Rename")!.click());
  await elsewhere(["Bug", "Defect", "Design change request"]);
  const field = host.querySelector<HTMLInputElement>(".preset-list input.field")!;
  expect(field.getAttribute("aria-label")).toBe("New name for Design change request");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Renamed first");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => buttonIn(host, "Save").click());
  await settled();
  expect(calls.at(-1)).toEqual({ name: "setPresetTags", args: { projectId: "project", tags: ["Bug", "Defect", "Renamed first"], previous: ["Bug", "Defect", "Design change request"] } });
  host = await draw();

  // Remove is chosen on "Defect", then "Bug" is removed elsewhere: "Defect" is still the one removed.
  await open("Defect");
  await elsewhere(["Defect", "Renamed first"]);
  await act(async () => menuItem("Remove preset")!.click());
  await settled();
  expect(calls.at(-1)).toEqual({ name: "setPresetTags", args: { projectId: "project", tags: ["Renamed first"], previous: ["Defect", "Renamed first"] } });
  host = await draw();

  // A rename whose preset was removed elsewhere closes rather than renaming another.
  await elsewhere(["Renamed first", "Other"]);
  await open("Other");
  await act(async () => menuItem("Rename")!.click());
  await elsewhere(["Renamed first"]);
  expect(host.querySelector(".preset-list input.field")).toBeNull();
});
