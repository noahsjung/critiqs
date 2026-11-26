import { expect, test } from "bun:test";
import { type PageFacts, pageView } from "../src/panel/page-view.ts";

const facts = (changes: Partial<PageFacts>): PageFacts => ({ url: undefined, origin: null, builtIn: false, refused: undefined, connected: false, waited: false, ...changes });

test("what the panel shows for its page", () => {
  expect(pageView(facts({ builtIn: true }))).toBe("built-in");
  // A connected page layer is this page's: a Built in note left from another page doesn't hide it.
  expect(pageView(facts({ builtIn: true, connected: true }))).toBe("ready");
  expect(pageView(facts({ connected: true, url: "https://a.dev/", origin: "https://a.dev" }))).toBe("ready");
  expect(pageView(facts({}))).toBe("checking");
  // Chrome hides the address until the icon is clicked on the page.
  expect(pageView(facts({ waited: true }))).toBe("needs-click");
  expect(pageView(facts({ url: "chrome://extensions/" }))).toBe("unsupported");
  expect(pageView(facts({ refused: "Cannot access a chrome:// URL" }))).toBe("unsupported");
  expect(pageView(facts({ refused: "The extensions gallery cannot be scripted." }))).toBe("unsupported");
  expect(pageView(facts({ refused: "Cannot access contents of the page. Extension manifest must request permission to access the respective host." }))).toBe("needs-click");
});
