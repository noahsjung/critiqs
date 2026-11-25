import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { activeMention, MentionInput, type MentionText, MessageBody, mentionsInText } from "../src/ui/MentionInput.tsx";
import { TransportContext } from "../src/transport.ts";
import { commentField, fieldText, placeCaret, typeInto } from "./comment-field.ts";
import { fakeTransport } from "./fake-transport.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("the mention being typed is the @ word just before the caret", () => {
  expect(activeMention("Hi @Ri", 6)).toEqual({ start: 3, query: "Ri" });
  expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
  expect(activeMention("Hi @Riley Chen", 14)).toEqual({ start: 3, query: "Riley Chen" });
  expect(activeMention("email@example.com", 17)).toBeNull();
  expect(activeMention("Hi @Ri\nnext", 11)).toBeNull();
  expect(activeMention("Hi there", 8)).toBeNull();
});

test("mentions whose name was deleted from the text are dropped", () => {
  const value: MentionText = {
    text: "Thanks @Lee",
    mentions: [
      { _id: "u1", name: "Lee Park", label: "Lee" },
      { _id: "u2", name: "Riley", label: "Riley" },
    ],
  };
  // Matched by the name as written, even after a rename.
  expect(mentionsInText(value)).toEqual([{ userId: "u1", label: "Lee" }]);
});

test("message bodies highlight mentions, preferring the longest name", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MessageBody
        body="Ask @Riley Chen and @Riley."
        mentions={[
          { _id: "a", name: "Riley", label: "Riley" },
          { _id: "b", name: "Riley C.", label: "Riley Chen" },
        ]}
      />,
    ),
  );
  expect(Array.from(host.querySelectorAll(".mention")).map((span) => [span.textContent, span.getAttribute("title")])).toEqual([
    ["@Riley Chen", "Now Riley C."],
    ["@Riley", null],
  ]);
  await act(async () => root.unmount());
  host.remove();
});

test("typing @ suggests participants; choosing one inserts the name and records the mention", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let value: MentionText = { text: "", mentions: [] };
  let escaped = false;
  const transport = fakeTransport({
    project: undefined,
    threads: undefined,
    participants: [
      { _id: "u-riley", name: "Riley Chen", imageUrl: null },
      { _id: "u-lee", name: "Lee", imageUrl: null },
    ],
  });
  const render = () =>
    root.render(
      <TransportContext.Provider value={transport}>
        {/* Like the thread window around it, which closes on Escape. */}
        <div onKeyDown={(event) => event.key === "Escape" && (escaped = true)}>
          <MentionInput projectId="project" aria-label="Reply" value={value} onChange={(next) => ((value = next), render())} />
        </div>
      </TransportContext.Provider>,
    );
  await act(async () => render());
  const field = commentField(host)!;
  const typeText = (text: string) => typeInto(field, text);
  await typeText("Thanks @ri");
  const options = () => Array.from(host.querySelectorAll('[role="option"]')).map((option) => option.textContent);
  expect(options()).toEqual(["RCRiley Chen"]);
  expect(field.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(value).toEqual({ text: "Thanks @Riley Chen ", mentions: [{ _id: "u-riley", name: "Riley Chen", label: "Riley Chen" }] });
  expect(options()).toEqual([]);

  // Escape closes suggestions without reaching anything around the text box.
  await typeText("Thanks @Riley Chen and @l");
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(escaped).toBe(false);
  expect(options()).toEqual([]);
  await act(async () => root.unmount());
  host.remove();
});

test("a chosen mention, or one already in an edited message, doesn't reopen the suggestions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let value: MentionText = { text: "Thanks @Lee", mentions: [{ _id: "u-lee", name: "Lee", label: "Lee" }] };
  const transport = fakeTransport({ project: undefined, threads: undefined, participants: [{ _id: "u-lee", name: "Lee", imageUrl: null }] });
  const render = () =>
    root.render(
      <TransportContext.Provider value={transport}>
        <MentionInput projectId="project" aria-label="Edit message" value={value} onChange={(next) => ((value = next), render())} />
      </TransportContext.Provider>,
    );
  await act(async () => render());
  const field = commentField(host)!;
  await act(async () => {
    field.focus();
    placeCaret(field, fieldText(field).length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
});
