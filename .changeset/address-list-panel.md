---
"critiqs-react": minor
---

Project setup shows a project's owners its address list, the sites where the Critiqs extension finds the project, on backends that report `addressEdits`. Each address has **Remove**, and a field adds an origin or a pattern such as `https://*-acme.vercel.app`; each change saves at once. The transport adds `useProjectAddresses`, `addProjectAddress`, and `removeProjectAddress`. `parseProjectAddress` in `@critiqs/core` now reads a pattern the same in every browser: Chrome writes a `*` in a host as `%2A`, which made it refuse every pattern there.
