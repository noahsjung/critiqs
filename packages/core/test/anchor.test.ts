import { beforeEach, describe, expect, test } from "bun:test";
import { describeTarget, locateTarget } from "../src/anchor.ts";

function render(html: string): HTMLElement {
  document.body.innerHTML = `<main id="app">${html}</main>`;
  return document.getElementById("app")!;
}

const userList = `
  <ul>
    <li data-critiqs-record="user:alex"><span data-critiqs-id="user.department"><b>Sales</b></span></li>
    <li data-critiqs-record="user:sam"><span data-critiqs-id="user.department">Support</span></li>
  </ul>`;

describe("describeTarget", () => {
  beforeEach(() => render(userList));

  test("targets the nearest element with a purpose ID and its record", () => {
    const root = document.getElementById("app")!;
    const bold = root.querySelector("b")!;
    const { target, element } = describeTarget(bold, root);
    expect(element.getAttribute("data-critiqs-id")).toBe("user.department");
    expect(target.purposeId).toBe("user.department");
    expect(target.recordKey).toBe("user:alex");
    expect(target.clues).toEqual({ tagName: "span", role: null, label: "Sales", path: "ul:1/li:1/span:1" });
  });
});

describe("locateTarget", () => {
  test("finds shared feedback on every compatible record", () => {
    const root = render(userList);
    const target = { purposeId: "user.department", recordKey: "user:alex", clues: anyClues };
    const result = locateTarget(target, "shared", root);
    expect(result.status).toBe("found");
    expect(result.status === "found" && result.elements.length).toBe(2);
  });

  test("places record-specific feedback only on its own record", () => {
    const root = render(userList);
    const target = { purposeId: "user.department", recordKey: "user:sam", clues: anyClues };
    const result = locateTarget(target, "record", root);
    expect(result.status === "found" && result.elements[0]?.textContent).toBe("Support");
  });

  test("never moves record-specific feedback to a different record", () => {
    const root = render(`<div data-critiqs-record="user:sam"><span data-critiqs-id="user.department">Support</span></div>`);
    const target = { purposeId: "user.department", recordKey: "user:alex", clues: anyClues };
    expect(locateTarget(target, "record", root)).toEqual({ status: "wrong-record" });
  });

  test("reports duplicate record matches instead of guessing", () => {
    const root = render(`
      <div data-critiqs-record="user:alex"><span data-critiqs-id="user.department">A</span></div>
      <div data-critiqs-record="user:alex"><span data-critiqs-id="user.department">B</span></div>`);
    const target = { purposeId: "user.department", recordKey: "user:alex", clues: anyClues };
    expect(locateTarget(target, "record", root)).toEqual({ status: "ambiguous", candidates: 2 });
  });

  test("reports a removed target as not found", () => {
    const root = render(`<p>Nothing here</p>`);
    const target = { purposeId: "user.department", recordKey: null, clues: anyClues };
    expect(locateTarget(target, "shared", root)).toEqual({ status: "not-found" });
  });

  test("falls back to clues only when they all still agree", () => {
    const root = render(`<section><button>Save</button><button>Cancel</button></section>`);
    const { target } = describeTarget(root.querySelectorAll("button")[1]!, root);
    expect(target.purposeId).toBeNull();
    expect(locateTarget(target, "shared", root).status).toBe("found");

    root.querySelectorAll("button")[1]!.textContent = "Discard";
    expect(locateTarget(target, "shared", root)).toEqual({ status: "not-found" });
  });

  test("matches purpose IDs containing selector syntax", () => {
    const root = render(`<span data-critiqs-id='odd"id'>x</span>`);
    const target = { purposeId: 'odd"id', recordKey: null, clues: anyClues };
    expect(locateTarget(target, "shared", root).status).toBe("found");
  });
});

const anyClues = { tagName: "span", role: null, label: null, path: "" };

test("excluded candidates, such as hidden elements, are not located", () => {
  const root = render(`<div hidden><span data-critiqs-id="tab.permissions.role">Admin</span></div>`);
  const target = { purposeId: "tab.permissions.role", recordKey: null, clues: anyClues };
  expect(locateTarget(target, "shared", root, (element) => element.closest("[hidden]") === null)).toEqual({
    status: "not-found",
  });
});

describe("locating by clues after the page around a target changed", () => {
  const savedBefore = (html: string, select: (root: HTMLElement) => Element) => {
    const root = render(html);
    return describeTarget(select(root), root).target;
  };

  test("finds a stable purpose ID when an element added earlier in the page shifts its path", () => {
    // A tooltip region the app attached to the page before a dialog's container, after the comment was left.
    const target = savedBefore(`<div id="page"></div><div class="dialog"><article><h1 data-critiqs-id="question.3.heading">Question 3</h1></article></div>`, (root) => root.querySelector("h1")!);
    const root = render(`<div id="page"></div><div class="tooltips"></div><div class="dialog"><article><h1 data-critiqs-id="question.3.heading">Question 3</h1></article></div>`);
    const result = locateTarget(target, "shared", root);
    expect(result.status).toBe("found");
    expect(result.status === "found" && result.elements[0] === root.querySelector(".dialog h1")).toBe(true);
  });

  test("does not accept an element with the same clues under different tags", () => {
    const target = savedBefore(`<div><article><h1>Question 3</h1></article></div>`, (root) => root.querySelector("h1")!);
    const root = render(`<div><section><h1>Question 3</h1></section></div>`);
    expect(locateTarget(target, "shared", root)).toEqual({ status: "not-found" });
  });

  test("does not choose a shifted lookalike without stable identity", () => {
    const target = savedBefore(`<div><p>Save</p></div>`, (root) => root.querySelector("p")!);
    // One copy keeps the saved div's position, the other the paragraph's: each is as close as the other.
    const root = render(`<div><p>Other</p><p>Save</p></div><div><p>Save</p></div>`);
    expect(locateTarget(target, "shared", root).status).toBe("not-found");
  });

  test("does not jump to a surviving panel after the original heading is removed", () => {
    const root = render(`<div id="original"><article><h1>Question 3</h1></article></div><div><article><h1>Question 3</h1></article></div>`);
    const { target } = describeTarget(root.querySelector("#original h1")!, root);
    root.querySelector("#original h1")!.remove();
    expect(locateTarget(target, "shared", root)).toEqual({ status: "not-found" });
  });

  test("does not rank an unrelated panel above a target whose heading and panel both shifted", () => {
    const root = render(`<div id="original"><article><h1>Question 3</h1></article></div><div><article><h1>Question 3</h1></article></div>`);
    const { target } = describeTarget(root.querySelector("#original h1")!, root);
    root.querySelector("#original article")!.insertAdjacentHTML("afterbegin", "<h1>Intro</h1>");
    root.insertAdjacentHTML("afterbegin", "<div></div>");
    expect(locateTarget(target, "shared", root)).toEqual({ status: "not-found" });
  });
});
