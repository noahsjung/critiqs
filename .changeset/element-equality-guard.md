---
---

No release: tests only. In every workspace whose tests run in a DOM, a failing assertion given a rendered element no longer prints the element's whole page. DOM nodes and the window print as a short tag for every matcher; the matchers that print a diff (`toEqual`, `toStrictEqual`, `toMatchObject`, `toContainEqual`, `toHaveProperty` with a value, the `…CalledWith` and `…ReturnedWith` matchers, `toMatchSnapshot`) fail at once when given an element; `toMatchInlineSnapshot` is refused. The four equality assertions that compared elements now compare `element === other`.
