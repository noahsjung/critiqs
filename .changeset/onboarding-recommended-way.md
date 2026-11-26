---
"critiqs-react": patch
---

Onboarding recommends a way in and offers the browser extension. The second screen lists the recommended way first, marked **Recommended** with one sentence on why, then the others: **I will**, **My developer will**, and, once there's a prototype link, **No one, for now**, which reviews it with the Critiqs extension. The extension's setup says it isn't in the Chrome Web Store yet and links to how to build and load it, and adds the prototype's origin to the project's address list so the extension finds the project. The setup screen lists the other ways under the chosen one, best first. In `@critiqs/core`, `AVAILABLE_WAYS` now includes `extension`, and a public address offers it after review links, which stay off.
