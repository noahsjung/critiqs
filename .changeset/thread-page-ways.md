---
"critiqs-react": minor
"critiqs": minor
---

Thread pages return `connectedAt` with their project, and how each thread was left (`prototype.madeWith`: `install`, or `extension` when the panel ran in the browser extension; absent on threads from before). Components send `madeWith` on new threads to backends that report `threadMadeWith`. On the Critiqs website, a thread page offers the Critiqs extension beside **Open in prototype** only for a thread left with the extension, saying whether the project is installed now; threads left with an install, including every thread from before, open where they were left. `@` in its reply box suggests the people in the thread. Whom someone may mention now follows their standing in the project, wherever they write from: the project's team mentions anyone in it, and someone outside the team mentions the team and people in the thread (in a new thread, the team), and is suggested the team only in the panel. The self-hosted database gains a column for how each thread was left (migration 21); existing threads keep it empty.
