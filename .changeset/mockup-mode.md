---
"critiqs-react": minor
---

Add Mockup mode, a third toolbar mode (**M**). It freezes the current page into a copy that covers the prototype, so clicks no longer navigate, and opens a panel in the sidebar's place. Reviewers ask Critiqs AI for changes on the whole page or on an element of the copy; each answer saves a new version, which anyone in the project can view, restore, or continue. Existing threads can be added to a mockup as instructions, and a thread added to one offers **Open mockup**. Copies can be taken at other window widths, and holding **Original** (or **O**) shows the live prototype.

Mockup mode needs a Convex backend that stores mockups; on the embedded server, or on a backend that doesn't report `mockups` in `/critiqs/config`, the toolbar leaves it out. Critiqs AI's changes also need the project's AI connection; without it, mockup threads explain that the project's owner can set it up in AI settings. Deploy the matching Critiqs backend functions before updating the component.
