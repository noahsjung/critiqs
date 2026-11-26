---
---

No release: tests only. Every workspace whose tests run in a DOM now fails an equality assertion (`toEqual`, `toStrictEqual`, `toMatchObject`, `toContainEqual`) that is given a rendered element, before bun can print the element's whole page, and the four such assertions are rewritten to compare `element === other`.
